//! Auth service.
//!
//! Translates [`AuthCommand`]s into the [`AuthPort`](crate::ports::AuthPort) calls
//! and emits the resulting events. Holds no state; the `auth` slice does.

use faf_domain::state::{AuthCommand, AuthEvent, Player};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: AuthCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        AuthCommand::Login { remember } => {
            let token = tokio_util::sync::CancellationToken::new();
            if let Ok(mut slot) = ctx.auth_cancellation.lock() {
                if let Some(prev) = slot.replace(token.clone()) {
                    prev.cancel();
                }
            }
            let generation = next_generation(ctx);
            let _guard = ctx.auth_mutation.acquire().await;
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
            if let Ok(mut slot) = ctx.auth_cancellation.lock() {
                if let Some(token) = slot.take() {
                    token.cancel();
                }
            }
            next_generation(ctx);
            out.emit(AuthEvent::LoggedOut);
        }
        AuthCommand::Restore => {
            let generation = next_generation(ctx);
            let _guard = ctx.auth_mutation.acquire().await;
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
        AuthCommand::LoginTest => {
            if let Ok(mut slot) = ctx.auth_cancellation.lock() {
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
            if let Ok(mut slot) = ctx.auth_cancellation.lock() {
                if let Some(token) = slot.take() {
                    token.cancel();
                }
            }
            let generation = next_generation(ctx);
            let _guard = ctx.auth_mutation.acquire().await;
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
            if let Ok(mut slot) = ctx.auth_cancellation.lock() {
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
    ctx.auth_generation.begin()
}

fn is_current(ctx: &ServiceCtx, generation: u64) -> bool {
    ctx.auth_generation.is_current(generation)
}
