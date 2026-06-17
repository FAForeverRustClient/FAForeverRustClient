//! Lobby service.
//!
//! Bridges the bidirectional, streaming [`LobbyPort`](crate::ports::LobbyPort) to
//! events: it connects, then maps each [`LobbyUpdate`] onto an event until the
//! stream ends. `Join` sends a `game_join` over the live connection; the server's
//! reply (`Launching` / `JoinFailed`) arrives back on that same update stream.
//!
//! When a launch order arrives and real launch is enabled (`FAF_REAL_LAUNCH=1`),
//! the connect loop also drives the [`launcher`](crate::services::launcher): it
//! starts the ICE adapter + game and then forwards the `target: "game"` relay
//! messages (which arrive on this very stream) to the adapter. Keeping the launch
//! session in this loop means no cross-task plumbing — the loop already sees both
//! the launch order and the relay traffic.

use std::sync::atomic::Ordering;

use faf_domain::state::{LobbyCommand, LobbyEvent};

use crate::ports::LobbyUpdate;
use crate::runtime::{EventSink, ServiceCtx};
use crate::services::launcher::{self, LaunchSession};

pub async fn handle(cmd: LobbyCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        LobbyCommand::Connect => {
            // Single-flight: only one connection may be active at a time. A
            // redundant `Connect` (StrictMode double-invoke, rapid clicks) loses
            // this compare-and-swap and is dropped, so overlapping connections
            // can't race and clobber each other's state. Decided before any await,
            // so there is no reorder window.
            if ctx
                .lobby_active
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                return; // a connection is already active/connecting
            }

            out.emit(LobbyEvent::Connecting);
            let mut updates = ctx.ports.lobby.connect().await;
            out.emit(LobbyEvent::Connected);

            // Real launch (subprocesses) is opt-in; otherwise we stop at the
            // modeled launch order, exactly as before this phase.
            let launch_enabled = std::env::var("FAF_REAL_LAUNCH").is_ok_and(|v| !v.is_empty());
            let mut session: Option<LaunchSession> = None;

            // Runs until the stream closes — either the server ended it or a
            // `Disconnect` command cancelled the connection (which drops the sender).
            while let Some(update) = updates.recv().await {
                match update {
                    LobbyUpdate::Games(games) => out.emit(LobbyEvent::GamesUpdated { games }),
                    LobbyUpdate::Launch(launch) => {
                        out.emit(LobbyEvent::Launching {
                            launch: launch.clone(),
                        });
                        if launch_enabled {
                            session = launcher::start(&launch, ctx, out).await;
                        }
                    }
                    LobbyUpdate::JoinFailed { id, reason } => {
                        out.emit(LobbyEvent::JoinFailed { id, reason })
                    }
                    // Connectivity messages for the game → forward to the adapter
                    // through the active launch session (ignored if none).
LobbyUpdate::GameRelay { command, args } => {
    eprintln!("[relay] GameRelay {command} session={}", session.is_some());
    if let Some(session) = &session {
        session.forward_to_adapter(command, args);
    }
}
                }
            }

            // Release the single-flight guard before announcing the disconnect, so
            // a fresh `Connect` right after can immediately take over.
            ctx.lobby_active.store(false, Ordering::SeqCst);
            out.emit(LobbyEvent::Disconnected);
        }
        LobbyCommand::Join { id } => {
            // Optimistic state; the launch/failed reply lands on the connect stream.
            out.emit(LobbyEvent::Joining { id });
            ctx.ports.lobby.join(id);
        }
        LobbyCommand::Disconnect => {
            // Cancels the active connection; the `Connect` task above then sees the
            // stream close and emits `Disconnected`.
            ctx.ports.lobby.disconnect();
        }
    }
}
