//! Auth service.
//!
//! Translates [`AuthCommand`]s into the [`AuthPort`](crate::ports::AuthPort) calls
//! and emits the resulting events. Holds no state; the `auth` slice does.

use faf_domain::state::{AuthCommand, AuthEvent, Player};
use tokio_util::sync::CancellationToken;

use crate::runtime::{EventSink, LatestRequest, SerialMutation, ServiceCtx};

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
            let result = tokio::select! {
                res = ctx.ports.auth.login(remember) => Some(res),
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
        AuthCommand::LaunchOfflineGame => {
            let game_path = out.with_state(|state| state.settings.game_path.clone());
            // No updater run, unlike every other launch: there may be no
            // network at all, and an install that was patched once is a
            // playable install. Without one there is nothing to start, which
            // is the Java client's answer too.
            // Java's `GameRunner.startOffline` answers a second press with
            // "game is running"; here it would have replaced the game, online
            // or not, because the game slot holds one process.
            if ctx.ports.process.game_running() || ctx.lobby.running_game_id().is_some() {
                out.emit(AuthEvent::LoginFailed {
                    message: "Forged Alliance is already running.".into(),
                });
                return;
            }
            if !ctx.ports.process.install_path_is_present(&game_path) {
                out.emit(AuthEvent::LoginFailed {
                    message: "Forged Alliance with FAF's files was not found. Sign in once and \
                              play or watch a game, so the client can set the game up, then \
                              playing offline works without an account."
                        .into(),
                });
                return;
            }
            if let Err(reason) = ctx
                .ports
                .process
                .launch_offline("faf".into(), String::new())
                .await
            {
                out.emit(AuthEvent::LoginFailed {
                    message: format!("Forged Alliance could not be started: {reason}"),
                });
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
