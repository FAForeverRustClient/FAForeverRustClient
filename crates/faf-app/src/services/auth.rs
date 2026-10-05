//! Auth service.
//!
//! Translates [`AuthCommand`]s into the [`AuthPort`](crate::ports::AuthPort) calls
//! and emits the resulting events. Holds no state; the `auth` slice does.

use faf_domain::state::{AuthCommand, AuthEvent, Player};

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
    cancellation: std::sync::Mutex<Option<tokio_util::sync::CancellationToken>>,
    /// Login, restore and logout act on the same session behind the auth
    /// port, so one finishes before the next begins.
    mutation: SerialMutation,
}

pub async fn handle(cmd: AuthCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        AuthCommand::Login { remember } => {
            let token = tokio_util::sync::CancellationToken::new();
            if let Ok(mut slot) = ctx.auth.cancellation.lock() {
                if let Some(prev) = slot.replace(token.clone()) {
                    prev.cancel();
                }
            }
            let generation = next_generation(ctx);
            let _guard = ctx.auth.mutation.acquire().await;
            if !is_current(ctx, generation) || token.is_cancelled() {
                return;
            }
            out.emit(AuthEvent::LoginStarted);
            let result = tokio::select! {
                res = ctx.ports.auth.login(remember) => Some(res),
                _ = token.cancelled() => None,
            };
            if !is_current(ctx, generation) {
                return;
            }
            let Some(result) = result else {
                out.emit(AuthEvent::LoggedOut);
                return;
            };
            match result {
                Ok(player) => out.emit(AuthEvent::LoggedIn { player }),
                Err(err) => out.emit(AuthEvent::LoginFailed {
                    message: err.message,
                }),
            }
        }
        AuthCommand::CancelLogin => {
            if let Ok(mut slot) = ctx.auth.cancellation.lock() {
                if let Some(token) = slot.take() {
                    token.cancel();
                }
            }
            next_generation(ctx);
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
            // the authenticated state.
            if let Ok(Some(player)) = ctx.ports.auth.restore().await {
                if is_current(ctx, generation) {
                    out.emit(AuthEvent::LoggedIn { player });
                }
            }
        }
        AuthCommand::PlayOffline => {
            // Whatever the login was doing, it is not what the user asked for
            // any more: the same cancellation the test path performs, and then
            // a session that talks to nothing.
            if let Ok(mut slot) = ctx.auth.cancellation.lock() {
                if let Some(token) = slot.take() {
                    token.cancel();
                }
            }
            next_generation(ctx);
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
            if let Ok(mut slot) = ctx.auth.cancellation.lock() {
                if let Some(token) = slot.take() {
                    token.cancel();
                }
            }
            next_generation(ctx);
            out.emit(AuthEvent::LoginStarted);
            out.emit(AuthEvent::TestLoggedIn {
                player: Player {
                    roles: ctx.ports.test_login_roles.clone(),
                    ..Player::new(42, "TestCommander")
                },
            });
        }
        AuthCommand::Logout => {
            if let Ok(mut slot) = ctx.auth.cancellation.lock() {
                if let Some(token) = slot.take() {
                    token.cancel();
                }
            }
            let generation = next_generation(ctx);
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
            if let Ok(mut slot) = ctx.auth.cancellation.lock() {
                if let Some(token) = slot.take() {
                    token.cancel();
                }
            }
            next_generation(ctx);
            out.emit(AuthEvent::LoggedOut);
        }
    }
}

fn next_generation(ctx: &ServiceCtx) -> u64 {
    ctx.auth.generation.begin()
}

fn is_current(ctx: &ServiceCtx, generation: u64) -> bool {
    ctx.auth.generation.is_current(generation)
}
