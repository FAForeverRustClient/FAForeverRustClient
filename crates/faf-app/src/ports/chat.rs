//! Chat port — a *streaming* boundary, same shape as [`LobbyPort`](crate::ports::LobbyPort).
//!
//! `connect` returns a receiver that yields a [`ChatUpdate`] whenever the
//! channel changes: a new message, or a change to who's online. The real impl
//! wraps FAF's chat IRC protocol; the fake simulates it. The service is
//! identical against either.

use async_trait::async_trait;
use faf_domain::state::ChatMessage;
use tokio::sync::mpsc;

/// One thing the chat connection tells us about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatUpdate {
    /// A new message in the channel — including our own sent messages, since
    /// this client doesn't negotiate IRC's `echo-message` capability; the port
    /// is responsible for the local echo (see `infra::chat`/`infra::irc`).
    MessageReceived(ChatMessage),
    /// A fresh full snapshot of who's currently in the channel.
    UsersUpdated(Vec<String>),
}

#[async_trait]
pub trait ChatPort: Send + Sync {
    /// Connect and join the default channel as `username`. The receiver yields
    /// a [`ChatUpdate`] on each change; it closes when the connection ends.
    async fn connect(&self, username: String) -> mpsc::Receiver<ChatUpdate>;

    /// Send a message to the default channel. A no-op if there is no active
    /// connection.
    fn send_message(&self, content: String);

    /// Cancel the active connection, if any. Idempotent.
    fn disconnect(&self);
}
