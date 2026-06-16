//! Lobby port — a *streaming* boundary.
//!
//! Unlike [`AuthPort`](crate::ports::AuthPort) (request/response), the lobby pushes
//! data over time: `connect` returns a receiver that yields a fresh game-list
//! snapshot whenever the server's view changes. The real impl wraps the FAF lobby
//! TCP/WS protocol; the fake simulates an evolving list. The service is identical.

use async_trait::async_trait;
use faf_domain::state::Game;
use tokio::sync::mpsc;

#[async_trait]
pub trait LobbyPort: Send + Sync {
    /// Connect to the lobby. The receiver yields a full game-list snapshot on each
    /// change; it closes when the connection ends (server-side or via [`Self::disconnect`]).
    async fn connect(&self) -> mpsc::Receiver<Vec<Game>>;

    /// Cancel the active connection, if any. Idempotent: closing an already-closed
    /// connection is a no-op. Closing drops the snapshot sender, which ends the
    /// receiver returned by [`Self::connect`].
    fn disconnect(&self);
}
