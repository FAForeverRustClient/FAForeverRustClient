//! Auth service.
//!
//! Translates [`AuthCommand`]s into the [`AuthPort`](crate::ports::AuthPort) calls
//! and emits the resulting events. Holds no state; the `auth` slice does.

use faf_domain::state::{AuthCommand, AuthEvent, Player};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: AuthCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        AuthCommand::Login { remember } => {
            let generation = next_generation(ctx);
            let _guard = ctx.auth_mutation.acquire().await;
            if !is_current(ctx, generation) {
                return;
            }
            out.emit(AuthEvent::LoginStarted);
            let result = ctx.ports.auth.login(remember).await;
            if !is_current(ctx, generation) {
                return;
            }
            match result {
                Ok(player) => out.emit(AuthEvent::LoggedIn { player }),
                Err(err) => out.emit(AuthEvent::LoginFailed {
                    message: err.message,
                }),
            }
        }
        AuthCommand::Restore => {
            let generation = next_generation(ctx);
            let _guard = ctx.auth_mutation.acquire().await;
            if !is_current(ctx, generation) {
                return;
            }
            // Say that a restore is happening. Emitting nothing until it
            // succeeded left the ordinary login screen on display throughout,
            // which read as "you are signed out" to anyone who had ticked
            // "stay signed in" and invited a pointless second login.
            out.emit(AuthEvent::RestoreStarted);
            let restored = ctx.ports.auth.restore().await;
            if !is_current(ctx, generation) {
                return;
            }
            match restored {
                Ok(Some(player)) => out.emit(AuthEvent::LoggedIn { player }),
                // No stored token, or one that could not be exchanged. Not a
                // login failure: there is nothing to report and the login
                // screen must become usable.
                _ => out.emit(AuthEvent::LoggedOut),
            }
        }
        AuthCommand::LoginTest => {
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
