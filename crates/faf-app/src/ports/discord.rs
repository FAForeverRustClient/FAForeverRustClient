//! Discord boundary: Rich Presence out, join/spectate requests in.
//!
//! Two directions, so unlike most ports this one is both a sink and a stream.
//! The Java client splits them across `DiscordRichPresenceService` (outbound)
//! and `DiscordEventHandler` (inbound) over one shared connection; the same
//! connection backs both halves here.

use async_trait::async_trait;
use faf_domain::protocol::discord::Activity;
use tokio::sync::mpsc;

/// Something a Discord friend asked for by clicking our status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscordRequest {
    /// Join this lobby. The id has already been read out of our own secret.
    Join { game_id: i32 },
    /// Watch this game's live replay.
    Spectate { game_id: i32 },
}

#[async_trait]
pub trait DiscordPort: Send + Sync {
    /// Publish the presence, or clear it with `None`.
    ///
    /// Fire-and-forget and infallible by design: Discord not running is the
    /// normal case, not an error worth surfacing. The implementation
    /// reconnects on its own.
    fn set_presence(&self, activity: Option<Activity>);

    /// Requests arriving from Discord. Called once at startup; the receiver
    /// stays open for the life of the client, across Discord restarts.
    async fn requests(&self) -> mpsc::Receiver<DiscordRequest>;
}
