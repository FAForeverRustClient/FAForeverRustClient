//! Auth service.
//!
//! Translates [`AuthCommand`]s into the [`AuthPort`](crate::ports::AuthPort) calls
//! and emits the resulting events. Holds no state; the `auth` slice does.

use faf_domain::state::{AuthCommand, AuthEvent};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: AuthCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        AuthCommand::Login => {
            out.emit(AuthEvent::LoginStarted);
            match ctx.ports.auth.login().await {
                Ok(player) => out.emit(AuthEvent::LoggedIn { player }),
                Err(err) => out.emit(AuthEvent::LoginFailed {
                    message: err.message,
                }),
            }
        }
        AuthCommand::Logout => {
            // Best-effort teardown; the UI returns to logged-out regardless.
            let _ = ctx.ports.auth.logout().await;
            out.emit(AuthEvent::LoggedOut);
        }
    }
}
