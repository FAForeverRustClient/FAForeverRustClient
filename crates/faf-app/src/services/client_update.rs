//! Client self-update orchestration.
//!
//! Mirrors `ClientUpdateService`: check, offer, download, hand to the
//! installer. The version comparison itself lives in the domain, so this file
//! is only the sequencing and the single-flight guards.
//!
//! It also carries the client's own release notes, because they arrive in the
//! same GitHub response the check reads, and the What's new popup, because
//! deciding it is a version comparison against the running build.

use std::sync::Arc;
use std::time::Duration;

use faf_domain::state::{
    should_update, whats_new_on_startup, ClientRelease, ClientReleaseNotesStatus,
    ClientUpdateCommand, ClientUpdateEvent, ClientUpdateStatus, JoinState, MatchmakingState,
    NotificationAction, NotificationKind, SettingsEvent, WhatsNewOnStartup,
};

use crate::ports::DownloadProgress;
use crate::runtime::{Cancellable, EventSink, ServiceCtx};
use crate::services;

mod background;

/// The installer download in flight, so `CancelDownload` can reach it. Owned
/// by this service.
#[derive(Default)]
pub struct ClientUpdateContext {
    /// One at most: a download holds `Key::ClientUpdate`. Keyed by nothing,
    /// since there is only the one.
    downloads: Cancellable<()>,
    background: background::BackgroundDownloads,
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
        ClientUpdateCommand::LoadNotes => load_notes(ctx, out).await,
        ClientUpdateCommand::DismissWhatsNew => dismiss_whats_new(ctx, out).await,
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
///
/// The What's new decision comes first and needs the same moment: it compares
/// the running build with a version stored in the settings file. When the
/// popup is pending, the notes it shows are made sure of afterwards. The check
/// hands them on itself when it reached the release list; when it did not, one
/// more request, on the one start after an update, is a fair price for not
/// showing an empty popup.
pub async fn check_on_startup(ctx: &ServiceCtx, out: &EventSink) {
    let whats_new = whats_new_at_startup(ctx, out).await;
    // As a command, so it is single-flight with a check, download or install
    // already running (`Key::ClientUpdate` in the command policy).
    crate::runtime::run_command(ClientUpdateCommand::Check.into(), ctx, out).await;
    let notes_ready =
        out.with_state(|state| state.client_update.notes_status == ClientReleaseNotesStatus::Ready);
    if whats_new && !notes_ready {
        crate::runtime::run_command(ClientUpdateCommand::LoadNotes.into(), ctx, out).await;
    }
}

/// Decide the What's new popup for this start, and return whether it is now
/// pending. The rules are [`whats_new_on_startup`]'s.
///
/// Showing it records nothing: the version is remembered only when the popup
/// is dismissed (`DismissWhatsNew`), so a start that never got as far as
/// showing it shows it again next time.
async fn whats_new_at_startup(ctx: &ServiceCtx, out: &EventSink) -> bool {
    let current = ctx.backend_version.clone();
    let preferences = out.with_state(|state| state.settings.updates.clone());
    let decision = whats_new_on_startup(
        preferences.last_seen_version.as_deref(),
        &current,
        preferences.show_whats_new,
    );
    match decision {
        WhatsNewOnStartup::Nothing => false,
        WhatsNewOnStartup::Remember => {
            remember_seen(current, ctx, out).await;
            false
        }
        WhatsNewOnStartup::Show => {
            out.emit(ClientUpdateEvent::WhatsNewPending { version: current });
            true
        }
    }
}

async fn dismiss_whats_new(ctx: &ServiceCtx, out: &EventSink) {
    let Some(version) = out.with_state(|state| state.client_update.whats_new.clone()) else {
        return; // Nothing is pending; a stray click.
    };
    out.emit(ClientUpdateEvent::WhatsNewDismissed);
    remember_seen(version, ctx, out).await;
}

/// Record `version` as the last one whose notes were seen, and write it down.
///
/// Changed in the group as state holds it now, under the settings merge lock,
/// the way other services write a preference: a patch from the Settings page
/// landing in between cannot be carried back to its old value.
async fn remember_seen(version: String, ctx: &ServiceCtx, out: &EventSink) {
    ctx.settings.merge_and_emit(out, |settings| {
        let mut preferences = settings.updates.clone();
        preferences.last_seen_version = Some(version);
        (SettingsEvent::UpdatesChanged { preferences }, ())
    });
    services::settings::persist(ctx, out).await;
}

/// Read every release's notes, from the port's memory when a check has
/// already read the list. See [`crate::ports::ClientUpdatePort::release_notes`].
async fn load_notes(ctx: &ServiceCtx, out: &EventSink) {
    // One at a time (`Key::ClientReleaseNotes`): a second load while one is
    // asking GitHub would only ask again, against a rate limit that is per
    // address and shared with the update check.
    crate::runtime::expect_admitted(crate::runtime::Key::ClientReleaseNotes);
    // The reducer keeps a list that is already on screen through both of
    // these: a refresh neither blanks it nor replaces it with an error.
    out.emit(ClientUpdateEvent::NotesLoading);
    match ctx.ports.client_update.release_notes().await {
        Ok(notes) => out.emit(ClientUpdateEvent::NotesLoaded { notes }),
        Err(reason) => out.emit(ClientUpdateEvent::NotesFailed { reason }),
    }
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
    background::spawn(ctx.clone(), sink.clone());
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
                reevaluate_overdue(&ctx, &sink, chrono::Utc::now());
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

    let outcome = ctx.ports.client_update.latest(channel).await;
    let reached_the_list = outcome.is_ok();
    match outcome {
        Err(reason) => out.emit(ClientUpdateEvent::Failed { reason }),
        // A source with no readable release is "nothing newer", not a failure:
        // a fresh repository with no releases yet is a normal state.
        Ok(None) => out.emit(ClientUpdateEvent::UpToDate),
        Ok(Some(release)) => {
            if should_update(&current, &release.version) {
                let notes = ctx
                    .ports
                    .client_update
                    .cached_release_notes()
                    .unwrap_or_default();
                let behind =
                    faf_domain::state::client_update::releases_behind(&current, &notes, channel);
                let required = faf_domain::state::client_update::behind_a_required_release(
                    &current, &notes, channel,
                );
                if !faf_domain::state::client_update::is_overdue(
                    &release,
                    chrono::Utc::now(),
                    behind,
                    required,
                ) {
                    announce(&release, &current, out, false);
                }
                out.emit(ClientUpdateEvent::Available { release });
                reevaluate_overdue(ctx, out, chrono::Utc::now());
            } else {
                out.emit(ClientUpdateEvent::UpToDate)
            }
        }
    }

    // The release list just read is every release's notes too, so they are
    // handed on from the port's memory rather than fetched a second time: the
    // changelog and the What's new popup have them without asking, at the
    // cost of no request. Only after a check that reached the list: a failed
    // one read nothing new, and whatever the port kept from before was handed
    // on when it was read.
    if reached_the_list {
        if let Some(notes) = ctx.ports.client_update.cached_release_notes() {
            out.emit(ClientUpdateEvent::NotesLoaded { notes });
        }
    }

    // After the outcome, and unconditionally. Two checks in a row usually
    // settle on the same status, so without this a second "Check now" changed
    // nothing on screen and read as a button that does nothing.
    out.emit(ClientUpdateEvent::CheckCompleted {
        at: chrono::Utc::now().to_rfc3339(),
    });
    // The check has finished writing its outcome. Hand its key back, which
    // the download needs, and leave starting it to the background observer
    // on a task of its own: awaited here, the check (and the settings load
    // that runs the startup check) lasted as long as the installer download.
    crate::runtime::end_turn();
    ctx.client_update.background.offer();
}

/// Emit `Overdue` once the held release has passed its grace period, the
/// player has fallen too far behind, or a release they are behind was
/// published as required, and announce it. No network: it reads the
/// release and the notes the last check left, which is what lets the six-hour
/// ticker move a client left open for days into the gate.
pub(crate) fn reevaluate_overdue(
    ctx: &ServiceCtx,
    out: &EventSink,
    now: chrono::DateTime<chrono::Utc>,
) {
    let candidate = out.with_state(|state| {
        let update = &state.client_update;
        if update.overdue {
            return None;
        }
        let release = update.release.as_ref()?;
        let notes = ctx
            .ports
            .client_update
            .cached_release_notes()
            .unwrap_or_else(|| update.notes.clone());
        let channel = state.settings.updates.channel();
        let behind = faf_domain::state::client_update::releases_behind(
            &update.current_version,
            &notes,
            channel,
        );
        let required = faf_domain::state::client_update::behind_a_required_release(
            &update.current_version,
            &notes,
            channel,
        );
        faf_domain::state::client_update::is_overdue(release, now, behind, required)
            .then(|| (release.clone(), update.current_version.clone()))
    });
    if let Some((release, current)) = candidate {
        out.emit(ClientUpdateEvent::Overdue);
        announce(&release, &current, out, true);
    }
}

/// Put a new version in the notification centre as well as in the sidebar.
///
/// The sidebar notice is quiet and a settings line is three
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
fn announce(release: &ClientRelease, current: &str, out: &EventSink, required: bool) {
    let skip = out.with_state(|state| {
        !required
            && (!state.settings.updates.automatic
                || state.client_update.dismissed_version == release.version
                || state
                    .client_update
                    .release
                    .as_ref()
                    .is_some_and(|known| known.version == release.version))
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
    let automatic = background::is_background_request();
    if automatic && !background::allowed(ctx, out) {
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
    if automatic {
        ctx.client_update
            .background
            .begin(ticket.called_off.clone());
    }
    if automatic && !background::allowed(ctx, out) {
        ctx.client_update.background.pause();
    }
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
    let version = release.version.clone();
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
    if automatic {
        ctx.client_update.background.end();
    }
    if automatic && !called_off.is_cancelled() && !matches!(finished, Some(Ok(_))) {
        ctx.client_update.background.failed(&version);
    }
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
    if automatic
        && ctx
            .client_update
            .background
            .paused
            .swap(false, std::sync::atomic::Ordering::AcqRel)
    {
        crate::runtime::end_turn();
        background::maybe_start(ctx, out).await;
    }
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

    // Recheck at the command boundary: the offer may have been clicked just
    // before a game, lesson or search started. Never close an active client.
    // The notice and the gate are hidden then, so this only drops a click
    // that raced the start.
    if playing(out) {
        return;
    }
    // The last game can still be finishing after the notice came back: FA
    // closing, its replay upload or a lesson result being saved. Dropping the
    // click then left a button that did nothing, so wait for it instead, and
    // say so. A new game, join or search ends the wait without installing.
    if finishing(ctx) {
        out.emit(ClientUpdateEvent::InstallWaiting);
        let deadline = tokio::time::Instant::now() + INSTALL_WAIT_LIMIT;
        loop {
            tokio::time::sleep(INSTALL_WAIT_POLL).await;
            let still_ready = out.with_state(|state| {
                state.client_update.status == ClientUpdateStatus::Ready { path: path.clone() }
            });
            if !still_ready || playing(out) || tokio::time::Instant::now() >= deadline {
                out.emit(ClientUpdateEvent::InstallWaitEnded);
                return;
            }
            if !finishing(ctx) {
                break;
            }
        }
    }
    match ctx.ports.client_update.install(path).await {
        // On Windows the shell exits on this event. A spawn failure must never
        // publish it, or the player would lose the client without an update.
        Ok(()) => out.emit(ClientUpdateEvent::Installing),
        Err(reason) => out.emit(ClientUpdateEvent::Failed { reason }),
    }
}

/// How long Install waits for the last game to finish before giving up.
/// A replay upload or lesson result takes seconds; this is the backstop.
const INSTALL_WAIT_LIMIT: Duration = Duration::from_secs(120);
const INSTALL_WAIT_POLL: Duration = Duration::from_millis(500);

/// A game, join, matchmaker search, lesson or tutorial launch is under way:
/// the client must not close.
fn playing(out: &EventSink) -> bool {
    out.with_state(|state| {
        !matches!(state.lobby.join, JoinState::Idle)
            || !matches!(
                state.lobby.matchmaking,
                MatchmakingState::Idle | MatchmakingState::Cancelled { .. }
            )
            || matches!(
                state.training.lesson_launch,
                faf_domain::state::LessonLaunch::Preparing { .. }
                    | faf_domain::state::LessonLaunch::Playing { .. }
            )
            || matches!(
                state.tutorials.launch,
                faf_domain::state::TutorialLaunchStatus::Preparing { .. }
            )
    })
}

/// The last game is still winding down where the UI cannot see it.
fn finishing(ctx: &ServiceCtx) -> bool {
    ctx.ports.process.game_running()
        || ctx.ports.process.replay_upload_pending()
        || ctx
            .training
            .lesson_results
            .load(std::sync::atomic::Ordering::Acquire)
            != 0
}

fn dismiss(out: &EventSink) {
    let Some(release) = out.with_state(|state| state.client_update.release.clone()) else {
        return;
    };
    out.emit(ClientUpdateEvent::Dismissed {
        version: release.version,
    });
}
