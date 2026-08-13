//! Client self-update, end to end through the loop.
//!
//! The domain owns the version comparison and has its own tests; what those
//! cannot show is that the running build's version reaches it, that the
//! channel preference reaches the port, and that "install" can only ever run
//! the file this client downloaded.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{ClientUpdatePort, DownloadProgress};
use faf_app::{App, Ports};
use faf_domain::state::{
    ClientRelease, ClientUpdateCommand, ClientUpdateState, ClientUpdateStatus, ReleaseChannel,
    SettingsCommand, UpdatePreferences,
};
use tokio::sync::mpsc;

/// What the stub was asked to do, in order.
#[derive(Debug, Default)]
struct Calls {
    channels: Vec<ReleaseChannel>,
    downloaded: Vec<String>,
    installed: Vec<String>,
}

struct StubUpdates {
    calls: Arc<Mutex<Calls>>,
    latest: Result<Option<ClientRelease>, String>,
    /// The path a successful download reports, or the failure to report.
    download: Result<String, String>,
}

#[async_trait]
impl ClientUpdatePort for StubUpdates {
    async fn latest(&self, channel: ReleaseChannel) -> Result<Option<ClientRelease>, String> {
        self.calls.lock().unwrap().channels.push(channel);
        self.latest.clone()
    }

    async fn download(&self, release: ClientRelease) -> mpsc::Receiver<DownloadProgress> {
        self.calls.lock().unwrap().downloaded.push(release.version);
        let (tx, rx) = mpsc::channel(8);
        let outcome = self.download.clone();
        tokio::spawn(async move {
            let _ = tx
                .send(DownloadProgress::Received {
                    received_bytes: 512,
                    total_bytes: 1024,
                })
                .await;
            let _ = tx.send(DownloadProgress::Finished(outcome)).await;
        });
        rx
    }

    async fn install(&self, path: String) -> Result<(), String> {
        self.calls.lock().unwrap().installed.push(path);
        Ok(())
    }
}

/// A port that must never be reached.
struct ForbiddenUpdates;

#[async_trait]
impl ClientUpdatePort for ForbiddenUpdates {
    async fn latest(&self, _channel: ReleaseChannel) -> Result<Option<ClientRelease>, String> {
        panic!("no check should have been made");
    }
    async fn download(&self, _release: ClientRelease) -> mpsc::Receiver<DownloadProgress> {
        panic!("no download should have been started");
    }
    async fn install(&self, path: String) -> Result<(), String> {
        panic!("no installer should have been started ({path})");
    }
}

struct Harness {
    app: App,
    calls: Arc<Mutex<Calls>>,
}

fn release(version: &str) -> ClientRelease {
    ClientRelease {
        version: version.into(),
        notes_url: format!("https://example.invalid/releases/{version}"),
        download_url: "https://example.invalid/installer".into(),
        asset_name: "installer".into(),
        size_bytes: 1024,
        pre_release: false,
        published_at: "2026-02-01T00:00:00Z".into(),
    }
}

/// `version` is the *running* client's version: the thing every comparison in
/// this feature is made against.
fn harness(
    version: &str,
    latest: Result<Option<ClientRelease>, String>,
    download: Result<String, String>,
) -> Harness {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let ports = Ports {
        client_update: Arc::new(StubUpdates {
            calls: calls.clone(),
            latest,
            download,
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new(version, ports);
    tokio::spawn(app_loop.run());
    Harness { app, calls }
}

async fn settle(app: &App, condition: impl Fn(&ClientUpdateState) -> bool, what: &str) {
    for _ in 0..300 {
        if condition(&app.snapshot().client_update) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "timed out waiting for {what}: {:?}",
        app.snapshot().client_update
    );
}

#[tokio::test]
async fn a_newer_release_is_offered_with_its_notes() {
    let h = harness("0.2.0", Ok(Some(release("0.3.0"))), Ok("installer".into()));
    h.app
        .dispatch(ClientUpdateCommand::Check.into())
        .await
        .unwrap();

    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::Available,
        "the offer",
    )
    .await;

    let state = h.app.snapshot().client_update;
    assert_eq!(state.current_version, "0.2.0");
    let offered = state.banner_release().expect("a banner release");
    assert_eq!(offered.version, "0.3.0");
    assert!(offered.notes_url.contains("0.3.0"));
}

#[tokio::test]
async fn an_older_release_is_reported_as_up_to_date_rather_than_offered() {
    // The check is a comparison, not "is there a release": a client ahead of
    // the newest published tag must not be told to downgrade.
    let h = harness("0.9.0", Ok(Some(release("0.3.0"))), Ok("installer".into()));
    h.app
        .dispatch(ClientUpdateCommand::Check.into())
        .await
        .unwrap();

    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::UpToDate,
        "the up-to-date result",
    )
    .await;
    assert_eq!(h.app.snapshot().client_update.release, None);
}

#[tokio::test]
async fn a_development_build_is_never_offered_an_update() {
    // `App::new("test", …)` is what every test and every `cargo run` produces.
    // Offering an installer over a local build would be actively destructive.
    let h = harness("test", Ok(Some(release("9.9.9"))), Ok("installer".into()));
    h.app
        .dispatch(ClientUpdateCommand::Check.into())
        .await
        .unwrap();

    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::UpToDate,
        "the refusal to offer",
    )
    .await;
    assert_eq!(h.app.snapshot().client_update.banner_release(), None);
}

#[tokio::test]
async fn a_failed_check_is_not_reported_as_up_to_date() {
    // The distinction that matters: an unreachable release list must not look
    // like a client that is current.
    let h = harness("0.2.0", Err("github unreachable".into()), Ok("x".into()));
    h.app
        .dispatch(ClientUpdateCommand::Check.into())
        .await
        .unwrap();

    settle(
        &h.app,
        |state| matches!(state.status, ClientUpdateStatus::Failed { .. }),
        "the failure",
    )
    .await;
    match h.app.snapshot().client_update.status {
        ClientUpdateStatus::Failed { reason } => assert!(reason.contains("unreachable")),
        other => panic!("expected a failure, got {other:?}"),
    }
}

#[tokio::test]
async fn downloading_reports_progress_and_then_the_installer_path() {
    let h = harness(
        "0.2.0",
        Ok(Some(release("0.3.0"))),
        Ok("/tmp/faf-client-0.3.0".into()),
    );
    h.app
        .dispatch(ClientUpdateCommand::Check.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::Available,
        "the offer",
    )
    .await;

    h.app
        .dispatch(ClientUpdateCommand::Download.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| matches!(state.status, ClientUpdateStatus::Ready { .. }),
        "the download",
    )
    .await;

    assert_eq!(
        h.calls.lock().unwrap().downloaded,
        vec!["0.3.0".to_string()]
    );
    match h.app.snapshot().client_update.status {
        ClientUpdateStatus::Ready { path } => assert_eq!(path, "/tmp/faf-client-0.3.0"),
        other => panic!("expected a ready installer, got {other:?}"),
    }
}

#[tokio::test]
async fn installing_runs_exactly_the_file_that_was_downloaded() {
    // The path is never a command parameter, so the UI cannot ask the backend
    // to execute something else.
    let h = harness(
        "0.2.0",
        Ok(Some(release("0.3.0"))),
        Ok("/tmp/faf-client-0.3.0".into()),
    );
    h.app
        .dispatch(ClientUpdateCommand::Check.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::Available,
        "the offer",
    )
    .await;
    h.app
        .dispatch(ClientUpdateCommand::Download.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| matches!(state.status, ClientUpdateStatus::Ready { .. }),
        "the download",
    )
    .await;

    h.app
        .dispatch(ClientUpdateCommand::Install.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::Installing,
        "the install",
    )
    .await;

    assert_eq!(
        h.calls.lock().unwrap().installed,
        vec!["/tmp/faf-client-0.3.0".to_string()]
    );
}

#[tokio::test]
async fn install_does_nothing_when_no_installer_has_been_downloaded() {
    let ports = Ports {
        client_update: Arc::new(ForbiddenUpdates),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("0.2.0", ports);
    tokio::spawn(app_loop.run());

    app.dispatch(ClientUpdateCommand::Install.into())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(
        app.snapshot().client_update.status,
        ClientUpdateStatus::Idle
    );
}

#[tokio::test]
async fn a_release_with_no_installer_for_this_platform_fails_with_a_reason() {
    let mut without_asset = release("0.3.0");
    without_asset.download_url = String::new();
    without_asset.asset_name = String::new();
    let h = harness("0.2.0", Ok(Some(without_asset)), Ok("x".into()));

    h.app
        .dispatch(ClientUpdateCommand::Check.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::Available,
        "the offer",
    )
    .await;

    h.app
        .dispatch(ClientUpdateCommand::Download.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| matches!(state.status, ClientUpdateStatus::Failed { .. }),
        "the refusal",
    )
    .await;

    // The port was never asked to fetch something that does not exist.
    assert!(h.calls.lock().unwrap().downloaded.is_empty());
    // …and the release stays on offer so the notes link still works.
    assert!(h.app.snapshot().client_update.banner_release().is_some());
}

#[tokio::test]
async fn dismissing_hides_the_banner_without_forgetting_the_release() {
    let h = harness("0.2.0", Ok(Some(release("0.3.0"))), Ok("x".into()));
    h.app
        .dispatch(ClientUpdateCommand::Check.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::Available,
        "the offer",
    )
    .await;

    h.app
        .dispatch(ClientUpdateCommand::Dismiss.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| state.dismissed_version == "0.3.0",
        "the dismissal",
    )
    .await;

    let state = h.app.snapshot().client_update;
    assert_eq!(state.banner_release(), None, "the banner is gone");
    assert!(
        state.release.is_some(),
        "Settings still shows what is available"
    );
}

#[tokio::test]
async fn the_startup_check_runs_when_settings_load() {
    let h = harness("0.2.0", Ok(Some(release("0.3.0"))), Ok("x".into()));
    h.app.dispatch(SettingsCommand::Load.into()).await.unwrap();

    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::Available,
        "the automatic check",
    )
    .await;
    assert_eq!(
        h.calls.lock().unwrap().channels,
        vec![ReleaseChannel::Stable]
    );
}

#[tokio::test]
async fn a_persisted_opt_out_keeps_startup_off_the_network() {
    // The preference has to be *stored*, not merely set: `Load` replaces the
    // whole settings slice from the port, so the startup check must read the
    // post-load value. Setting it in-session and then loading would silently
    // put the default back: which is what an earlier version of this test
    // did, and it caught it.
    let stored = faf_domain::state::SettingsState {
        updates: UpdatePreferences {
            automatic: false,
            pre_release: false,
        },
        ..Default::default()
    };
    let ports = Ports {
        client_update: Arc::new(ForbiddenUpdates),
        settings: Arc::new(faf_app::infra::FakeSettings { initial: stored }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("0.2.0", ports);
    tokio::spawn(app_loop.run());

    // `ForbiddenUpdates` panics if the check runs at all.
    app.dispatch(SettingsCommand::Load.into()).await.unwrap();
    for _ in 0..300 {
        if !app.snapshot().settings.updates.automatic {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!app.snapshot().settings.updates.automatic, "load applied");
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(
        app.snapshot().client_update.status,
        ClientUpdateStatus::Idle
    );
}

#[tokio::test]
async fn the_opt_out_is_a_preference_the_settings_page_can_change() {
    let h = harness("0.2.0", Ok(None), Ok("x".into()));
    h.app
        .dispatch(
            SettingsCommand::SetUpdates {
                preferences: UpdatePreferences {
                    automatic: false,
                    pre_release: false,
                },
            }
            .into(),
        )
        .await
        .unwrap();

    for _ in 0..300 {
        if !h.app.snapshot().settings.updates.automatic {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the preference never reached the state the UI renders from");
}

#[tokio::test]
async fn the_prerelease_preference_selects_the_channel_the_port_is_asked_for() {
    // Java picks between two entirely different tasks here; the equivalent
    // mistake for us is silently always asking for stable.
    let h = harness("0.2.0", Ok(None), Ok("x".into()));
    h.app
        .dispatch(
            SettingsCommand::SetUpdates {
                preferences: UpdatePreferences {
                    automatic: true,
                    pre_release: true,
                },
            }
            .into(),
        )
        .await
        .unwrap();
    for _ in 0..300 {
        if h.app.snapshot().settings.updates.pre_release {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    h.app
        .dispatch(ClientUpdateCommand::Check.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::UpToDate,
        "the check",
    )
    .await;

    assert_eq!(
        h.calls.lock().unwrap().channels,
        vec![ReleaseChannel::PreRelease]
    );
}
