//! Lobby service.
//!
//! Bridges the streaming [`LobbyPort`](crate::ports::LobbyPort) to events: it
//! connects, then forwards each game-list snapshot as a `GamesUpdated` event until
//! the stream ends. Because each command runs on its own task (see the runtime),
//! this long-lived loop never blocks other commands.

use faf_domain::state::{LobbyCommand, LobbyEvent};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: LobbyCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        LobbyCommand::Connect => {
            out.emit(LobbyEvent::Connecting);
            let mut updates = ctx.ports.lobby.connect().await;
            out.emit(LobbyEvent::Connected);

            // Runs until the stream closes — either the server ended it or a
            // `Disconnect` command cancelled the connection (which drops the sender).
            while let Some(games) = updates.recv().await {
                out.emit(LobbyEvent::GamesUpdated { games });
            }

            out.emit(LobbyEvent::Disconnected);
        }
        LobbyCommand::Disconnect => {
            // Cancels the active connection; the `Connect` task above then sees the
            // stream close and emits `Disconnected`.
            ctx.ports.lobby.disconnect();
        }
    }
}
