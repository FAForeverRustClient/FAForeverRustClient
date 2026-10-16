//! Update orchestration with an admitted command and controllable download stream.
use super::*;
use crate::infra::fake_ports;
use crate::ports::{ClientUpdatePort, DownloadProgress};
use async_trait::async_trait;
use faf_domain::state::{
    ClientRelease, ClientUpdateCommand, ClientUpdateStatus, LobbyEvent, SettingsEvent,
    UpdatePreferences,
};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Script {
    downloads: AtomicUsize,
    installs: AtomicUsize,
    hold_install: AtomicBool,
    fail_install: AtomicBool,
    install_started: Notify,
    finish_install: Notify,
    cancellations: AtomicUsize,
    fail: AtomicBool,
    /// Publish 1.0.0 as a required release.
    required: AtomicBool,
    finish: Notify,
}

struct Updates(Arc<Script>);

#[async_trait]
impl ClientUpdatePort for Updates {
    async fn latest(
        &self,
        _: faf_domain::state::ReleaseChannel,
    ) -> Result<Option<ClientRelease>, String> {
        Ok(Some(ClientRelease {
            version: "1.0.0".into(),
            download_url: "https://example.invalid/installer".into(),
            published_at: chrono::Utc::now().to_rfc3339(),
            ..Default::default()
        }))
    }
    fn cached_release_notes(&self) -> Option<Vec<faf_domain::state::ClientReleaseNotes>> {
        Some(vec![faf_domain::state::ClientReleaseNotes {
            version: "1.0.0".into(),
            required: self.0.required.load(Ordering::SeqCst),
            ..Default::default()
        }])
    }
    async fn download(
        &self,
        _: ClientRelease,
        cancelled: CancellationToken,
    ) -> mpsc::Receiver<DownloadProgress> {
        self.0.downloads.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel(4);
        let script = self.0.clone();
        tokio::spawn(async move {
            let outcome = tokio::select! {
                biased;
                () = cancelled.cancelled() => {
                    script.cancellations.fetch_add(1, Ordering::SeqCst);
                    Err("cancelled".into())
                }
                () = script.finish.notified() => {
                    if script.fail.load(Ordering::SeqCst) { Err("offline".into()) } else { Ok("installer".into()) }
                }
            };
            let _ = tx.send(DownloadProgress::Finished(outcome)).await;
        });
        rx
    }
    async fn install(&self, _: String) -> Result<(), String> {
        self.0.installs.fetch_add(1, Ordering::SeqCst);
        self.0.install_started.notify_one();
        if self.0.hold_install.load(Ordering::SeqCst) {
            self.0.finish_install.notified().await;
        }
        if self.0.fail_install.load(Ordering::SeqCst) {
            Err("installer could not start".into())
        } else {
            Ok(())
        }
    }
}

fn harness() -> (Arc<ServiceCtx>, EventSink, Arc<Script>) {
    let script = Arc::new(Script::default());
    let (_, app_loop) = App::new(
        "0.9.0",
        Ports {
            client_update: Arc::new(Updates(script.clone())),
            ..fake_ports()
        },
    );
    let ctx = Arc::new(app_loop.ctx);
    let sink = app_loop.sink;
    services::client_update::spawn(ctx.clone(), sink.clone());
    (ctx, sink, script)
}

async fn until(sink: &EventSink, expected: impl Fn(&faf_domain::state::ClientUpdateState) -> bool) {
    let mut events = sink.subscribe();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if sink.with_state(|s| expected(&s.client_update)) {
                return;
            }
            events.recv().await.unwrap();
        }
    })
    .await
    .expect("update settled");
}

fn preference(sink: &EventSink, enabled: bool) {
    sink.emit(SettingsEvent::UpdatesChanged {
        preferences: UpdatePreferences {
            background_download: enabled,
            ..Default::default()
        },
    });
}

#[tokio::test]
async fn update_notice_background_lifecycle() {
    let (ctx, sink, script) = harness();
    run_command(ClientUpdateCommand::Check.into(), &ctx, &sink).await;
    assert_eq!(script.downloads.load(Ordering::SeqCst), 0);
    assert!(!sink.with_state(|s| s.client_update.overdue));
    // Turn the setting on while joining. No network work until the join ends.
    sink.emit(LobbyEvent::Joining {
        id: 1,
        prepared: false,
    });
    preference(&sink, true);
    tokio::task::yield_now().await;
    assert_eq!(script.downloads.load(Ordering::SeqCst), 0);
    sink.emit(LobbyEvent::JoinCancelled);
    until(&sink, |s| {
        matches!(s.status, ClientUpdateStatus::Downloading { .. })
    })
    .await;
    sink.emit(LobbyEvent::Joining {
        id: 2,
        prepared: false,
    });
    until(&sink, |s| s.status == ClientUpdateStatus::Available).await;
    assert_eq!(script.cancellations.load(Ordering::SeqCst), 1);
    sink.emit(LobbyEvent::JoinCancelled);
    until(&sink, |s| {
        matches!(s.status, ClientUpdateStatus::Downloading { .. })
    })
    .await;
    preference(&sink, false);
    until(&sink, |s| s.status == ClientUpdateStatus::Available).await;
    assert_eq!(script.cancellations.load(Ordering::SeqCst), 2);
    preference(&sink, true);
    until(&sink, |s| {
        matches!(s.status, ClientUpdateStatus::Downloading { .. })
    })
    .await;
    script.finish.notify_one();
    until(&sink, |s| {
        matches!(s.status, ClientUpdateStatus::Ready { .. })
    })
    .await;
    assert_eq!(script.downloads.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn update_notice_manual_download_survives_join_and_preference_changes() {
    let (ctx, sink, script) = harness();
    run_command(ClientUpdateCommand::Check.into(), &ctx, &sink).await;
    let worker_ctx = ctx.clone();
    let worker_sink = sink.clone();
    let task = tokio::spawn(async move {
        run_command(
            ClientUpdateCommand::Download.into(),
            &worker_ctx,
            &worker_sink,
        )
        .await;
    });
    until(&sink, |s| {
        matches!(s.status, ClientUpdateStatus::Downloading { .. })
    })
    .await;
    sink.emit(LobbyEvent::Joining {
        id: 1,
        prepared: false,
    });
    preference(&sink, false);
    // An explicit barrier lets the observer consume both events before completion.
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    script.finish.notify_one();
    task.await.unwrap();
    assert_eq!(script.cancellations.load(Ordering::SeqCst), 0);
    assert!(sink.with_state(|s| matches!(s.client_update.status, ClientUpdateStatus::Ready { .. })));
}

#[tokio::test]
async fn update_notice_automatic_retry_is_bounded() {
    let (ctx, sink, script) = harness();
    run_command(ClientUpdateCommand::Check.into(), &ctx, &sink).await;
    script.fail.store(true, Ordering::SeqCst);
    preference(&sink, true);
    until(&sink, |s| {
        matches!(s.status, ClientUpdateStatus::Downloading { .. })
    })
    .await;
    script.finish.notify_one();
    until(&sink, |s| {
        matches!(s.status, ClientUpdateStatus::Failed { .. })
    })
    .await;
    sink.emit(LobbyEvent::Joining {
        id: 1,
        prepared: false,
    });
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    sink.emit(LobbyEvent::JoinCancelled);
    until(&sink, |s| {
        matches!(s.status, ClientUpdateStatus::Downloading { .. })
    })
    .await;
    script.finish.notify_one();
    until(&sink, |s| {
        matches!(s.status, ClientUpdateStatus::Failed { .. })
    })
    .await;
    sink.emit(LobbyEvent::Joining {
        id: 2,
        prepared: false,
    });
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    sink.emit(LobbyEvent::JoinCancelled);
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert_eq!(script.downloads.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn update_notice_ticker_uses_the_held_release_without_a_network_check() {
    let (ctx, sink, _) = harness();
    run_command(ClientUpdateCommand::Check.into(), &ctx, &sink).await;
    assert!(!sink.with_state(|s| s.client_update.overdue));
    services::client_update::reevaluate_overdue(
        &ctx,
        &sink,
        chrono::Utc::now() + chrono::Duration::days(3),
    );
    assert!(sink.with_state(|s| s.client_update.overdue));
}

#[tokio::test]
async fn update_notice_a_required_release_gates_without_a_grace_period() {
    let (ctx, sink, script) = harness();
    script.required.store(true, Ordering::SeqCst);
    // Published a moment ago and one release behind: only the mark gates it.
    run_command(ClientUpdateCommand::Check.into(), &ctx, &sink).await;
    assert!(sink.with_state(|s| s.client_update.overdue));
    assert!(sink.with_state(|s| s.client_update.required_release().is_some()));
}

#[tokio::test]
async fn update_notice_check_leaves_the_background_download_to_its_own_task() {
    // The startup check runs inside the settings load. With background
    // downloads on it used to start the installer download itself and last
    // until the installer had arrived, holding the load for minutes on a slow
    // line. The check now returns while the download is still running.
    let (ctx, sink, script) = harness();
    preference(&sink, true);
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        run_command(ClientUpdateCommand::Check.into(), &ctx, &sink),
    )
    .await
    .expect("the check returns before the installer has arrived");
    until(&sink, |s| {
        matches!(s.status, ClientUpdateStatus::Downloading { .. })
    })
    .await;
    assert_eq!(script.downloads.load(Ordering::SeqCst), 1);
    script.finish.notify_one();
    until(&sink, |s| {
        matches!(s.status, ClientUpdateStatus::Ready { .. })
    })
    .await;
}

#[tokio::test]
async fn update_install_signals_exit_only_after_the_installer_starts() {
    let (ctx, sink, script) = harness();
    script.hold_install.store(true, Ordering::SeqCst);
    run_command(ClientUpdateCommand::Check.into(), &ctx, &sink).await;
    sink.emit(faf_domain::state::ClientUpdateEvent::Downloaded {
        path: "installer".into(),
    });
    let worker = {
        let ctx = ctx.clone();
        let sink = sink.clone();
        tokio::spawn(
            async move { run_command(ClientUpdateCommand::Install.into(), &ctx, &sink).await },
        )
    };
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        script.install_started.notified(),
    )
    .await
    .unwrap();
    assert!(sink.with_state(|state| matches!(
        state.client_update.status,
        ClientUpdateStatus::Ready { .. }
    )));
    script.finish_install.notify_one();
    worker.await.unwrap();
    assert!(sink.with_state(|state| state.client_update.status == ClientUpdateStatus::Installing));
}

#[tokio::test]
async fn update_install_failure_does_not_signal_exit() {
    let (ctx, sink, script) = harness();
    script.fail_install.store(true, Ordering::SeqCst);
    run_command(ClientUpdateCommand::Check.into(), &ctx, &sink).await;
    sink.emit(faf_domain::state::ClientUpdateEvent::Downloaded {
        path: "installer".into(),
    });
    let mut events = sink.subscribe();
    run_command(ClientUpdateCommand::Install.into(), &ctx, &sink).await;
    assert!(sink.with_state(|state| matches!(
        state.client_update.status,
        ClientUpdateStatus::Failed { .. }
    )));
    while let Ok(event) = events.try_recv() {
        assert!(!matches!(
            event,
            faf_domain::AppEvent::ClientUpdate(faf_domain::state::ClientUpdateEvent::Installing)
        ));
    }
}

#[tokio::test]
async fn update_install_is_refused_during_a_join_or_lesson_result_save() {
    let (ctx, sink, script) = harness();
    run_command(ClientUpdateCommand::Check.into(), &ctx, &sink).await;
    sink.emit(faf_domain::state::ClientUpdateEvent::Downloaded {
        path: "installer".into(),
    });
    sink.emit(LobbyEvent::Joining {
        id: 1,
        prepared: false,
    });
    run_command(ClientUpdateCommand::Install.into(), &ctx, &sink).await;
    assert_eq!(script.installs.load(Ordering::SeqCst), 0);
    sink.emit(LobbyEvent::JoinCancelled);
    ctx.training.lesson_results.store(1, Ordering::SeqCst);
    run_command(ClientUpdateCommand::Install.into(), &ctx, &sink).await;
    assert_eq!(script.installs.load(Ordering::SeqCst), 0);
    ctx.training.lesson_results.store(0, Ordering::SeqCst);
    run_command(ClientUpdateCommand::Install.into(), &ctx, &sink).await;
    assert_eq!(script.installs.load(Ordering::SeqCst), 1);
}
