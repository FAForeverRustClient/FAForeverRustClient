//! ICE adapter port — the connectivity backend, abstracted over Go and Java.
//!
//! Both FAF adapters (`faf-pioneer` Go, `faf-ice-adapter` Java) are modeled the
//! same way: [`IcePort::start`] brings the adapter up for one game and returns a
//! [`ConnectivitySession`] — the GPGNet port the game must connect to, plus two
//! channels of [`RelayMsg`] bridging the adapter and the lobby. Everything
//! adapter-specific (Go's GPGNet relay server + `CreateLobby`; Java's JSON-RPC +
//! ICE-server poll) lives behind this seam, so the launcher is backend-neutral.

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::mpsc;

/// A connectivity message in the lobby relay format — identical to what crosses
/// the lobby (`{ command, target: "game", args }`). The shared currency between
/// the adapter backend and the lobby, regardless of Go vs Java internals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayMsg {
    pub command: String,
    pub args: Vec<Value>,
}

/// Everything the adapter needs to bridge one game.
#[derive(Debug, Clone)]
pub struct IceParams {
    pub player_id: i32,
    pub player_login: String,
    pub game_id: i32,
    /// Lobby init mode: 0 = normal (custom), 1 = auto (matchmaker).
    pub init_mode: i32,
}

/// The live connectivity session handed back to the launcher.
pub struct ConnectivitySession {
    /// GPGNet port the game connects to (`/gpgnet 127.0.0.1:<game_port>`).
    pub game_port: u16,
    /// Messages from the adapter to be relayed to the lobby (`send_game_relay`).
    pub to_lobby: mpsc::Receiver<RelayMsg>,
    /// Lobby game-target messages to feed into the adapter.
    pub from_lobby: mpsc::Sender<RelayMsg>,
}

#[async_trait]
pub trait IcePort: Send + Sync {
    /// Bring the adapter up for one game and return its session. Errors if the
    /// adapter can't be started or its control channel can't be established.
    async fn start(&self, params: IceParams) -> Result<ConnectivitySession, String>;

    /// Stop the adapter, if running. Idempotent.
    fn stop(&self);
}
