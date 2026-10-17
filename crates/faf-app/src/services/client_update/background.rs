//! Optional installer downloads, driven by idle transitions rather than polling.

use crate::runtime::{EventSink, ServiceCtx};
use faf_domain::{
    state::{ClientUpdateCommand, ClientUpdateStatus, JoinState},
    AppEvent,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tokio_util::sync::CancellationToken;

tokio::task_local! {
    // Request origin belongs to the task: a concurrent manual Download cannot
    // accidentally inherit an automatic request's cancellation policy.
    static AUTOMATIC: bool;
}

#[derive(Default)]
pub(super) struct BackgroundDownloads {
    active: Mutex<Option<CancellationToken>>,
    pub paused: AtomicBool,
    failures: Mutex<std::collections::HashMap<String, u8>>,
    /// Rung by a check that found a release, once it has handed its key back.
    /// The check does not start the download itself: it would then last as
    /// long as the installer takes to arrive, and the startup check runs
    /// inside the settings load, which had to wait for it.
    offered: tokio::sync::Notify,
}

impl BackgroundDownloads {
    pub fn begin(&self, token: CancellationToken) {
        *self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(token);
    }

    pub fn end(&self) {
        self.active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
    }

    pub fn pause(&self) {
        let active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(token) = active.as_ref() {
            self.paused.store(true, Ordering::Release);
            // Own this download's token. A delayed observer must never cancel
            // a manual download that acquired the update key after it ended.
            token.cancel();
        }
    }

    /// Ask the observer to consider a download now. See `offered`.
    pub fn offer(&self) {
        self.offered.notify_one();
    }

    pub fn failed(&self, version: &str) {
        let mut failures = self
            .failures
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *failures.entry(version.to_owned()).or_default() += 1;
    }

    fn may_retry(&self, version: &str) -> bool {
        self.failures
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(version)
            .copied()
            .unwrap_or(0)
            < 2
    }
}

pub(super) fn is_background_request() -> bool {
    AUTOMATIC.try_with(|automatic| *automatic).unwrap_or(false)
}

pub(super) fn allowed(ctx: &ServiceCtx, out: &EventSink) -> bool {
    out.with_state(|state| {
        state.settings.updates.background_download && matches!(state.lobby.join, JoinState::Idle)
    }) && !ctx.ports.process.game_running()
}

pub(super) async fn maybe_start(ctx: &ServiceCtx, out: &EventSink) {
    if !allowed(ctx, out) {
        return;
    }
    let start = out.with_state(|state| {
        let update = &state.client_update;
        update.release.as_ref().is_some_and(|release| {
            release.is_installable()
                && release.version != update.dismissed_version
                && matches!(
                    update.status,
                    ClientUpdateStatus::Available | ClientUpdateStatus::Failed { .. }
                )
                && ctx.client_update.background.may_retry(&release.version)
        })
    });
    if start {
        AUTOMATIC
            .scope(
                true,
                crate::runtime::run_command(ClientUpdateCommand::Download.into(), ctx, out),
            )
            .await;
    }
}

pub(super) fn spawn(ctx: Arc<ServiceCtx>, out: EventSink) {
    let mut events = out.subscribe();
    let mut was_allowed = allowed(&ctx, &out);
    tokio::spawn(async move {
        loop {
            let offered = tokio::select! {
                received = events.recv() => match received {
                    Ok(
                        AppEvent::Lobby(_)
                        | AppEvent::Settings(_)
                        | AppEvent::Training(_)
                        | AppEvent::Tutorials(_),
                    )
                    | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => false,
                    Ok(_) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
                () = ctx.client_update.background.offered.notified() => true,
            };
            let is_allowed = allowed(&ctx, &out);
            if !is_allowed {
                ctx.client_update.background.pause();
            }
            if is_allowed && (offered || !was_allowed) {
                // Keep observing while Download owns its key, so a join can
                // call it off without waiting for the installer to finish.
                let ctx = ctx.clone();
                let out = out.clone();
                tokio::spawn(async move {
                    maybe_start(&ctx, &out).await;
                });
            }
            was_allowed = is_allowed;
        }
    });
}
