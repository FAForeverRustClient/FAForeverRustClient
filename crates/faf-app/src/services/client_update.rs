//! Client self-update orchestration.
//!
//! Mirrors `ClientUpdateService`: check, offer, download, hand to the
//! installer. The version comparison itself lives in the domain, so this file
//! is only the sequencing and the single-flight guards.

use faf_domain::state::{
    should_update, ClientRelease, ClientUpdateCommand, ClientUpdateEvent, ClientUpdateStatus,
    NotificationAction, NotificationKind,
};

use crate::ports::DownloadProgress;
use crate::runtime::{EventSink, ServiceCtx};
use crate::services;

pub async fn handle(cmd: ClientUpdateCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        ClientUpdateCommand::Check => check(ctx, out).await,
        ClientUpdateCommand::Download => download(ctx, out).await,
        ClientUpdateCommand::Install => install(ctx, out).await,
        ClientUpdateCommand::Dismiss => dismiss(out),
    }
}

/// The startup check, run from the settings service once preferences are
/// loaded: the channel is a preference, so checking any earlier would always
/// use the stable default regardless of what the user chose.
///
/// Unconditional. It used to return early when `settings.updates.automatic`
/// was off, which was defensible while an update was only ever an offer: the
/// check is an outbound request, and not making it was a choice worth having.
/// It stopped being defensible once a release the client can install itself
/// became a gate, because a security update that a checkbox switches off is
/// not one. The preference now governs what is *said* about an optional
/// update rather than whether we find out about one at all.
pub async fn check_on_startup(ctx: &ServiceCtx, out: &EventSink) {
    check(ctx, out).await;
}

async fn check(ctx: &ServiceCtx, out: &EventSink) {
    let Some(_guard) = ctx.client_update_active.try_acquire() else {
        return;
    };
    let (busy, channel) = out.with_state(|state| {
        (
            state.client_update.status.is_busy(),
            state.settings.updates.channel(),
        )
    });
    // A second check while one is running would race to write the status, and
    // the loser would leave a stale answer behind. The startup check and a
    // click on "Check now" can land together.
    if busy {
        return;
    }
    let current = ctx.backend_version.clone();

    out.emit(ClientUpdateEvent::CheckStarted {
        current_version: current.clone(),
    });

    match ctx.ports.client_update.latest(channel).await {
        Err(reason) => out.emit(ClientUpdateEvent::Failed { reason }),
        // A source with no readable release is "nothing newer", not a failure:
        // a fresh repository with no releases yet is a normal state.
        Ok(None) => out.emit(ClientUpdateEvent::UpToDate),
        Ok(Some(release)) => {
            if should_update(&current, &release.version) {
                announce(&release, &current, out);
                out.emit(ClientUpdateEvent::Available { release })
            } else {
                out.emit(ClientUpdateEvent::UpToDate)
            }
        }
    }

    // After the outcome, and unconditionally. Two checks in a row usually
    // settle on the same status, so without this a second "Check now" changed
    // nothing on screen and read as a button that does nothing.
    out.emit(ClientUpdateEvent::CheckCompleted {
        at: chrono::Utc::now().to_rfc3339(),
    });
}

/// Put a new version in the notification centre as well as on the banner.
///
/// The banner is at the top of the workspace and a settings line is three
/// clicks away; neither reaches somebody who is in a game lobby when the
/// startup check lands. This is the one thing the client has that persists
/// across tabs and carries an unread mark.
///
/// Not `add_required`: an update is important, not urgent, and someone who has
/// turned notifications off has said what they want.
///
/// Skipped entirely for an optional update when the user has turned optional
/// update announcements off. A required release is announced regardless: they
/// are about to meet the gate, and meeting it with no idea why would be worse.
///
/// Announced once per release rather than once per check. Two reasons to skip:
/// the version was dismissed, which is the user saying they know, or it is
/// already the release on offer, which means this check told us nothing new and
/// a second click on "Check now" should not add a second identical entry.
fn announce(release: &ClientRelease, current: &str, out: &EventSink) {
    let skip = out.with_state(|state| {
        (!state.settings.updates.automatic && !release.is_required())
            || state.client_update.dismissed_version == release.version
            || state
                .client_update
                .release
                .as_ref()
                .is_some_and(|known| known.version == release.version)
    });
    if skip {
        return;
    }
    services::notifications::add(
        out,
        NotificationKind::ClientUpdate,
        format!("Version {} is available", release.version),
        if current.is_empty() {
            "Open Settings to download it.".to_string()
        } else {
            format!("You are running {current}. Open Settings to download it.")
        },
        Some(NotificationAction::OpenSettings {
            section: Some("updates".to_string()),
        }),
    );
}

async fn download(ctx: &ServiceCtx, out: &EventSink) {
    let Some(_guard) = ctx.client_update_active.try_acquire() else {
        return;
    };
    let state = out.with_state(|state| state.client_update.clone());
    if state.status.is_busy() {
        return;
    }
    let Some(release) = state.release.clone() else {
        return; // Nothing is on offer; a stray click.
    };
    if !release.is_installable() {
        out.emit(ClientUpdateEvent::Failed {
            reason: format!(
                "release {} has no installer for this platform: open the release page instead",
                release.version
            ),
        });
        return;
    }

    let mut updates = ctx.ports.client_update.download(release).await;

    // The port always ends with `Finished`. Treating a stream that closes
    // without one as a failure keeps a panicked task from leaving the UI stuck
    // on a progress bar that will never move again.
    let mut settled = false;
    while let Some(progress) = updates.recv().await {
        match progress {
            DownloadProgress::Received {
                received_bytes,
                total_bytes,
            } => out.emit(ClientUpdateEvent::DownloadProgressed {
                received_bytes,
                total_bytes,
            }),
            DownloadProgress::Finished(Ok(path)) => {
                settled = true;
                out.emit(ClientUpdateEvent::Downloaded { path });
            }
            DownloadProgress::Finished(Err(reason)) => {
                settled = true;
                out.emit(ClientUpdateEvent::Failed { reason });
            }
        }
    }
    if !settled {
        out.emit(ClientUpdateEvent::Failed {
            reason: "the download stopped without finishing".into(),
        });
    }
}

async fn install(ctx: &ServiceCtx, out: &EventSink) {
    let Some(_guard) = ctx.client_update_active.try_acquire() else {
        return;
    };
    // Only ever runs what *this* client downloaded and renamed into place. The
    // path is not a command parameter, so the UI cannot ask for an arbitrary
    // executable to be started.
    let status = out.with_state(|state| state.client_update.status.clone());
    let ClientUpdateStatus::Ready { path } = status else {
        return;
    };

    out.emit(ClientUpdateEvent::Installing);
    if let Err(reason) = ctx.ports.client_update.install(path).await {
        out.emit(ClientUpdateEvent::Failed { reason });
    }
}

fn dismiss(out: &EventSink) {
    let Some(release) = out.with_state(|state| state.client_update.release.clone()) else {
        return;
    };
    out.emit(ClientUpdateEvent::Dismissed {
        version: release.version,
    });
}
