//! Lobby port — a *bidirectional, streaming* boundary.
//!
//! Unlike [`AuthPort`](crate::ports::AuthPort) (request/response), the lobby pushes
//! data over time: `connect` returns a receiver that yields a [`LobbyUpdate`]
//! whenever the server's view changes. It is also bidirectional — [`Self::join`]
//! sends a `game_join` over the *same* authenticated connection, and the server's
//! `game_launch` / `game_join_failed` reply arrives back on the very same update
//! stream. The real impl wraps the FAF lobby WS protocol; the fake simulates it.
//! The service is identical against either.

use async_trait::async_trait;
use faf_domain::state::{Game, GameLaunch};
use serde_json::Value;
use tokio::sync::mpsc;

/// One thing the lobby connection tells us about. Game-list snapshots, join
/// replies, and in-game relay traffic all travel the same socket, so they share
/// one stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LobbyUpdate {
    /// A fresh full snapshot of the open-games list.
    Games(Vec<Game>),
    /// The server accepted a join and issued the launch order.
    Launch(GameLaunch),
    /// The server rejected a join (game not ready, host left, bad password, …).
    JoinFailed { id: i32, reason: String },
    /// A connectivity message addressed to the game (`target: "game"`) —
    /// `HostGame`/`JoinGame`/`ConnectToPeer`/`IceMsg`/… — to be relayed to the
    /// ICE adapter. `args` keep their JSON types (ints vs strings) for the
    /// GPGNet codec.
    GameRelay { command: String, args: Vec<Value> },
}

#[async_trait]
pub trait LobbyPort: Send + Sync {
    /// Connect to the lobby. The receiver yields a [`LobbyUpdate`] on each change;
    /// it closes when the connection ends (server-side or via [`Self::disconnect`]).
    async fn connect(&self) -> mpsc::Receiver<LobbyUpdate>;

    /// Request to join game `id` over the live connection (sends `game_join`). The
    /// reply arrives asynchronously on the [`Self::connect`] stream as
    /// [`LobbyUpdate::Launch`] or [`LobbyUpdate::JoinFailed`]. A no-op if there is
    /// no active connection.
    fn join(&self, id: i32);

    /// Relay a connectivity message to the server addressed to the game
    /// (`{ command, target: "game", args }`). Used by the launcher to forward
    /// GPGNet/ICE messages produced by the local adapter. A no-op if there is no
    /// active connection.
    fn send_game_relay(&self, command: String, args: Vec<Value>);

    /// Cancel the active connection, if any. Idempotent: closing an already-closed
    /// connection is a no-op. Closing drops the update sender, which ends the
    /// receiver returned by [`Self::connect`].
    fn disconnect(&self);
}
