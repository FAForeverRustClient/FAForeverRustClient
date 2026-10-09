//! Client self-update orchestration.
//!
//! Mirrors `ClientUpdateService`: check, offer, download, hand to the
//! installer. The version comparison itself lives in the domain, so this file
//! is only the sequencing and the single-flight guards.

use std::sync::Arc;
use std::time::Duration;

use faf_domain::state::{
    should_update, ClientRelease, ClientUpdateCommand, ClientUpdateEvent, ClientUpdateStatus,
    NotificationAction, NotificationKind,
};

use crate::ports::DownloadProgress;
use crate::runtime::{Cancellable, EventSink, ServiceCtx};
use crate::services;

/// The installer download in flight, so `CancelDownload` can reach it. Owned
/// by this service.
#[derive(Default)]
pub struct ClientUpdateContext {
    /// One at most: a download holds `Key::ClientUpdate`. Keyed by nothing,
    /// since there is only the one.
    downloads: Cancellable<()>,
}

pub async fn handle(cmd: ClientUpdateCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        ClientUpdateCommand::Check => check(ctx, out).await,
        ClientUpdateCommand::Download => download(ctx, out).await,
        ClientUpdateCommand::CancelDownload => {
            ctx.client_update.downloads.cancel(|()| true);
        }
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
    // As a command, so it is single-flight with a check, download or install
    // already running (`Key::ClientUpdate` in the command policy).
    crate::runtime::run_command(ClientUpdateCommand::Check.into(), ctx, out).await;
}

/// How often the client looks again while it is running.
///
/// Six hours. A release is published at a moment nobody here controls, and the
/// startup check is the only one there was: a client left open over a weekend
/// never heard about a new version at all, which is the half of "notify people
/// about a new client version" that a banner cannot fix by itself. Long enough
/// that the release source sees one request per client per quarter day, short
/// enough that a security release is not waiting for somebody to restart.
const RECHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Start the re-check ticker. Called once from the runtime loop.
///
/// The first tick fires immediately and is skipped deliberately: the startup
/// check belongs to the settings load, which knows the release channel, and
/// running one here as well would mean two checks racing at every launch. The
/// guards inside `check` would drop one of them, but the one they drop is not
/// specified, and a checked-for-nothing request at startup is not free.
pub fn spawn(ctx: Arc<ServiceCtx>, sink: EventSink) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(RECHECK_INTERVAL);
        ticker.tick().await;
        loop {
            ticker.tick().await;
            // Nothing to look for once a newer release is already in hand, and
            // looking anyway would take something away: the check's first act
            // is to set the status to `Checking`, which is not a state the
            // banner or the gate draws, and a downloaded installer's `Ready`
            // path is the button the user is about to press. A release that
            // has been found is news the client is already showing; the ticker
            // exists for the client that has not heard any yet.
            if sink.with_state(|state| state.client_update.release.is_some()) {
                continue;
            }
            crate::runtime::run_command(ClientUpdateCommand::Check.into(), &ctx, &sink).await;
        }
    });
}

async fn check(ctx: &ServiceCtx, out: &EventSink) {
    crate::runtime::expect_admitted(crate::runtime::Key::ClientUpdate);
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
    let text = if current.is_empty() {
        services::notifications::Text::new("notifications.msg.clientUpdate")
    } else {
        services::notifications::Text::new("notifications.msg.clientUpdateFrom")
            .with("current", current)
    };
    services::notifications::add_text(
        out,
        NotificationKind::ClientUpdate,
        text.with("version", &release.version),
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
    crate::runtime::expect_admitted(crate::runtime::Key::ClientUpdate);
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

    // Reachable before anything is on screen, and on screen at once: the
    // first report only comes with the first chunk, and until then the offer
    // read as if Download had not been pressed.
    let ticket = ctx.client_update.downloads.begin(());
    out.emit(ClientUpdateEvent::DownloadProgressed {
        received_bytes: 0,
        total_bytes: 0,
    });
    // The call-off goes to the port as a token, and the stream is read to its
    // end either way: the adapter stops at its next await, deletes its
    // partial file, and only then lets the stream end (see
    // `ClientUpdatePort::download`). The update key is held until then. It
    // used to go at the cancel, with the worker still running, and a download
    // pressed straight after wrote the same partial file the old worker was
    // about to truncate or delete.
    let called_off = ticket.called_off.clone();
    let mut updates = ctx
        .ports
        .client_update
        .download(release, called_off.clone())
        .await;

    // The outcome is said once the stream has ended, so the offer is not back
    // on screen while the worker is still finishing.
    let mut finished = None;
    while let Some(progress) = updates.recv().await {
        match progress {
            // Not drawn once called off: the bar is on its way out.
            DownloadProgress::Received { .. } if called_off.is_cancelled() => {}
            DownloadProgress::Received {
                received_bytes,
                total_bytes,
            } => out.emit(ClientUpdateEvent::DownloadProgressed {
                received_bytes,
                total_bytes,
            }),
            DownloadProgress::Finished(outcome) => finished = Some(outcome),
        }
    }
    ctx.client_update.downloads.end(&ticket);
    out.emit(match finished {
        // Complete before the call-off reached it: the installer is in
        // place, and saying so is the truth.
        Some(Ok(path)) => ClientUpdateEvent::Downloaded { path },
        // Not a failure: the user stopped it. The offer stays.
        Some(Err(_)) | None if called_off.is_cancelled() => ClientUpdateEvent::DownloadCancelled,
        Some(Err(reason)) => ClientUpdateEvent::Failed { reason },
        // The port always ends with `Finished`. A stream that closes without
        // one is a failure, so a panicked task cannot leave the UI stuck on
        // a progress bar that will never move again.
        None => ClientUpdateEvent::Failed {
            reason: "the download stopped without finishing".into(),
        },
    });
}

async fn install(ctx: &ServiceCtx, out: &EventSink) {
    crate::runtime::expect_admitted(crate::runtime::Key::ClientUpdate);
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
