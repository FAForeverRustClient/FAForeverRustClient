//! Session service.
//!
//! Phase 2 has no real networking yet: the handshake simply reports the backend
//! version. Later this becomes the auth/connection flow, driving an `AuthPort`
//! and a `LobbyPort`. The shape stays identical — command in, events out.

use faf_domain::state::{SessionCommand, SessionEvent};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: SessionCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        SessionCommand::Hello => {
            out.emit(SessionEvent::Connecting);
            out.emit(SessionEvent::BackendReady {
                version: ctx.backend_version.clone(),
            });
        }
    }
}
