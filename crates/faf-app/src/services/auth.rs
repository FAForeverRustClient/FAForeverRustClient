//! Auth service.
//!
//! Translates [`AuthCommand`]s into the [`AuthPort`](crate::ports::AuthPort) calls
//! and emits the resulting events. Holds no state; the `auth` slice does.

use faf_domain::state::{AuthCommand, AuthEvent, NotificationKind, Player};
use tokio_util::sync::CancellationToken;

use crate::runtime::{CancellationSlot, EventSink, LatestRequest, SerialMutation, ServiceCtx};
use crate::services::notifications;

/// Why an offline game did not start, said where the person who asked is.
///
/// From the login screen that is the login's own error line, which is what
/// `LoginFailed` fills. A signed-in player can ask too now, from the menu on
/// their own name in the sidebar (#514), and `LoginFailed` there would end
/// the session it reports into: it clears the player. So a session that has
/// a player gets a notification instead.
fn offline_game_failed(out: &EventSink, message: String) {
    if out.with_state(|state| state.auth.player.is_some()) {
        notifications::add_failure(
            out,
            notifications::Text::new("notifications.msg.offlineGameFailed"),
            "Could not start the game offline",
            message,
        );
    } else {
        out.emit(AuthEvent::LoginFailed { message });
    }
}

/// The auth service's operational context: which sign-in or sign-out is
/// current, how to call off a login in flight, and the lock that keeps them
/// from interleaving. Owned by this service.
#[derive(Default)]
pub struct AuthContext {
    /// Only the newest login, restore or logout may land. Commands run
    /// concurrently, so one that was cancelled or superseded and answers late
    /// must not sign the user in or out over the one now current.
    generation: LatestRequest,
    /// The in-flight login, so cancelling it, going offline or signing out can
    /// stop it. Dropping the future is the only thing that actually stops work
    /// that is several awaits deep inside a port.
    ///
    /// Its lock is also the session's commit boundary: a command that calls a
    /// sign-in off cancels the token and makes the generation stale while
    /// holding it, and a sign-in checks that it is still wanted and publishes
    /// its session while holding it. Either the sign-in lands first or it sees
    /// that it was called off; it can never publish in between.
    cancellation: std::sync::Mutex<Option<CancellationToken>>,
    /// Login, restore and logout act on the same session behind the auth
    /// port, so one finishes before the next begins.
    mutation: SerialMutation,
    /// A "Play offline" that is setting the game up, so its Cancel, or the
    /// player signing out, can stop it.
    offline_game: CancellationSlot,
}

/// The featured mod an offline game starts with: plain FAF, as in the Java
/// client's `launchOfflineGame`.
const OFFLINE_FEATURED_MOD: &str = "faf";

/// What a signed-out "Play offline" is told when FAF's copy of the game has
/// never been set up on this machine.
const SIGN_IN_TO_SET_UP: &str = "Forged Alliance with FAF's files was not found. Sign in once \
     and choose Play offline in the menu on your name, or play or watch any game, so the client \
     can set the game up; after that, playing offline works without an account.";

/// Whether Forged Alliance is running for this client already.
fn game_running(ctx: &ServiceCtx) -> bool {
    ctx.ports.process.game_running() || ctx.lobby.running_game_id().is_some()
}

/// Whether the configured game path holds FAF's copy of the game.
fn game_installed(ctx: &ServiceCtx, out: &EventSink) -> bool {
    let game_path = out.with_state(|state| state.settings.game_path.clone());
    ctx.ports.process.install_path_is_present(&game_path)
}

/// Fetch FAF's files for an offline game, the way an online launch does
/// before its first game: the `faf` featured mod brought up to date, which on
/// a fresh machine is what creates the game's own folder.
///
/// Only for a signed-in player. The update asks FAF's API which files make up
/// the current build, so signed out it has nothing to ask with, and the
/// player is told how to get there instead.
///
/// Answers `Err` with what to tell the player, or anything at all when
/// `cancel` was raised, which the caller does not report.
async fn set_up_offline_game(
    ctx: &ServiceCtx,
    out: &EventSink,
    cancel: &CancellationToken,
) -> Result<(), String> {
    if !out.with_state(|state| state.auth.player.is_some()) {
        return Err(SIGN_IN_TO_SET_UP.into());
    }
    // A path the client does not manage (Steam's executable, say) is one the
    // updater cannot write FAF's files into.
    if ctx.ports.process.game_install_dir().is_none() {
        return Err(
            "Forged Alliance with FAF's files was not found at the game path in Settings → \
             Paths, and the client cannot set the game up there."
                .into(),
        );
    }
    out.emit(AuthEvent::OfflineGamePreparing {
        detail: "Setting up the game".into(),
        progress: None,
    });
    // Said where it will be seen: the status bar's line is easy to miss, and
    // a "Play offline" that starts a download without a word reads as the
    // client doing something it was not asked to.
    notifications::add_text(
        out,
        NotificationKind::GameInstall,
        notifications::Text::new("notifications.msg.offlineGameDownloading"),
        "Downloading the game for offline play",
        "FAF's game files are not on this computer yet, so the client downloads them once \
         before the offline game starts. After that, Play offline starts without a download. \
         You can cancel it from the status bar.",
        None,
    );
    let outcome = super::launcher::prepare_featured_mod_narrated(
        OFFLINE_FEATURED_MOD,
        ctx,
        out,
        cancel,
        |step| {
            out.emit(AuthEvent::OfflineGamePreparing {
                detail: step.detail,
                progress: step.progress,
            })
        },
    )
    .await;
    out.emit(AuthEvent::OfflineGamePreparationEnded);
    if let Err(reason) = outcome {
        return Err(format!("The game could not be set up: {reason}"));
    }
    // The files are there now, which the missing-install banner and the login
    // screen's hint read from the install slice.
    super::settings::sync_installs(ctx, out);
    if game_running(ctx) {
        return Err("Forged Alliance is already running.".into());
    }
    if !game_installed(ctx, out) {
        return Err(
            "The game was set up, but Forged Alliance is still missing from the game path.".into(),
        );
    }
    Ok(())
}

pub async fn handle(cmd: AuthCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        AuthCommand::Login { remember } => {
            let token = CancellationToken::new();
            let generation = {
                let mut slot = cancellation_slot(ctx);
                if let Some(prev) = slot.replace(token.clone()) {
                    prev.cancel();
                }
                next_generation(ctx)
            };
            let _guard = ctx.auth.mutation.acquire().await;
            if !is_current(ctx, generation) || token.is_cancelled() {
                return;
            }
            out.emit(AuthEvent::LoginStarted);
            // The address the browser sign-in waits on, for the login screen's
            // Copy button. The reducer ignores it once the attempt has ended.
            let sink = out.clone();
            let link = move |url: String| sink.emit(AuthEvent::SignInLinkReady { url });
            let result = tokio::select! {
                res = ctx.ports.auth.login(remember, &link) => Some(res),
                _ = token.cancelled() => None,
            };
            let player = match result {
                Some(Ok(player)) => player,
                ended => {
                    // Nothing of this attempt may outlive it. The port can have
                    // staged a session even when the cancel won the race above,
                    // so it is dropped whatever ended the attempt.
                    ctx.ports.auth.discard_pending_session();
                    if is_current(ctx, generation) {
                        match ended {
                            Some(Err(err)) => out.emit(AuthEvent::LoginFailed {
                                message: err.message,
                            }),
                            _ => out.emit(AuthEvent::LoggedOut),
                        }
                    }
                    return;
                }
            };
            commit_if_current(ctx, out, generation, Some(&token), player);
        }
        AuthCommand::CancelLogin => {
            call_off_sign_in(ctx);
            out.emit(AuthEvent::LoggedOut);
        }
        AuthCommand::Restore => {
            let generation = next_generation(ctx);
            let _guard = ctx.auth.mutation.acquire().await;
            if !is_current(ctx, generation) {
                return;
            }
            if !out.with_state(|state| state.settings.general.auto_login) {
                return;
            }
            // A missing or temporarily unavailable refresh token should leave
            // the normal login screen usable; only a successful restore changes
            // the authenticated state. A restore cannot be cancelled, so one
            // that was superseded while it ran must still not go live.
            match ctx.ports.auth.restore().await {
                Ok(Some(player)) => commit_if_current(ctx, out, generation, None, player),
                _ => ctx.ports.auth.discard_pending_session(),
            }
        }
        AuthCommand::PlayOffline => {
            // Whatever the login was doing, it is not what the user asked for
            // any more: the same cancellation the test path performs, and then
            // a session that talks to nothing.
            call_off_sign_in(ctx);
            out.emit(AuthEvent::WentOffline);
        }
        AuthCommand::CancelOfflineGame => ctx.auth.offline_game.cancel(),
        AuthCommand::LaunchOfflineGame => {
            crate::runtime::expect_admitted(crate::runtime::Key::OfflineGameLaunch);
            let cancel = ctx.auth.offline_game.begin();
            // Java's `GameRunner.startOffline` answers a second press with
            // "game is running"; here it would have replaced the game, online
            // or not, because the game slot holds one process.
            if game_running(ctx) {
                offline_game_failed(out, "Forged Alliance is already running.".into());
                return;
            }
            // No updater run while the install is there, unlike every other
            // launch: there may be no network at all, and an install that was
            // patched once is a playable install. Without one, a signed-in
            // player gets it now; signed out there is nothing to start, which
            // is the Java client's answer too.
            if !game_installed(ctx, out) {
                if let Err(reason) = set_up_offline_game(ctx, out, &cancel).await {
                    if !cancel.is_cancelled() {
                        offline_game_failed(out, reason);
                    }
                    return;
                }
            }
            if let Err(reason) = ctx
                .ports
                .process
                .launch_offline(OFFLINE_FEATURED_MOD.into(), String::new())
                .await
            {
                offline_game_failed(
                    out,
                    format!("Forged Alliance could not be started: {reason}"),
                );
            }
        }
        AuthCommand::LoginTest => {
            call_off_sign_in(ctx);
            out.emit(AuthEvent::LoginStarted);
            out.emit(AuthEvent::TestLoggedIn {
                player: Player {
                    roles: ctx.ports.test_login_roles.clone(),
                    ..Player::new(42, "TestCommander")
                },
            });
        }
        AuthCommand::Logout => {
            let generation = call_off_sign_in(ctx);
            // Setting the offline game up needs the session that is ending,
            // and its progress and Cancel live in the shell being left.
            ctx.auth.offline_game.cancel();
            let _guard = ctx.auth.mutation.acquire().await;
            if !is_current(ctx, generation) {
                return;
            }
            // Best-effort teardown; the UI returns to logged-out regardless.
            let _ = ctx.ports.auth.logout().await;
            if is_current(ctx, generation) {
                out.emit(AuthEvent::LoggedOut);
            }
        }
        AuthCommand::LogoutTest => {
            call_off_sign_in(ctx);
            ctx.auth.offline_game.cancel();
            out.emit(AuthEvent::LoggedOut);
        }
    }
}

fn cancellation_slot(ctx: &ServiceCtx) -> std::sync::MutexGuard<'_, Option<CancellationToken>> {
    // A poisoned lock still guards the commit boundary; giving up on it would
    // let a cancel and a commit interleave.
    ctx.auth
        .cancellation
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Cancel the login in flight, if any, and make every earlier login or restore
/// stale. Returns the new generation.
///
/// Both happen under the cancellation lock, the one [`commit_if_current`]
/// holds, so a sign-in that has not published yet will see that it was called
/// off and drop its staged session instead.
fn call_off_sign_in(ctx: &ServiceCtx) -> u64 {
    let mut slot = cancellation_slot(ctx);
    if let Some(token) = slot.take() {
        token.cancel();
    }
    next_generation(ctx)
}

/// Publish the session the port staged and announce `player`, but only while
/// the attempt is still the current one and has not been called off.
/// Otherwise the staged session is dropped and nothing is announced.
///
/// The check and the publication run under the cancellation lock, so a cancel
/// cannot land between them and leave a live session (and, with "Remember me",
/// one the next start would restore) behind a login screen.
fn commit_if_current(
    ctx: &ServiceCtx,
    out: &EventSink,
    generation: u64,
    token: Option<&CancellationToken>,
    player: Player,
) {
    let _slot = cancellation_slot(ctx);
    let called_off =
        !is_current(ctx, generation) || token.is_some_and(CancellationToken::is_cancelled);
    if called_off {
        ctx.ports.auth.discard_pending_session();
        return;
    }
    if ctx.ports.auth.commit_session() {
        out.emit(AuthEvent::LoggedIn { player });
    }
}

fn next_generation(ctx: &ServiceCtx) -> u64 {
    ctx.auth.generation.begin()
}

fn is_current(ctx: &ServiceCtx, generation: u64) -> bool {
    ctx.auth.generation.is_current(generation)
}
