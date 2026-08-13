//! Chat port: a *streaming* boundary, same shape as [`LobbyPort`](crate::ports::LobbyPort).
//!
//! `connect` returns a receiver that yields a [`ChatUpdate`] whenever anything
//! about the session changes: connection status, channel membership, a message,
//! or a change to a channel's roster. The real impl wraps FAF's chat IRC
//! protocol; the fake simulates it. The service is identical against either.
//!
//! Every update names its channel, because the client is multi-channel: the
//! default `#aeolus`, any channel the user joins, and one pseudo-channel per
//! private conversation (named after the other user, no leading `#`): the same
//! model both reference clients use.

use async_trait::async_trait;
use faf_domain::state::{ChatMessage, ChatStatus, ChatUser};
use tokio::sync::mpsc;

/// One thing the chat connection tells us about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatUpdate {
    /// The connection's own state, with the nick the server accepted (empty
    /// unless connected). Emitted by the port rather than inferred by the
    /// service because the port reconnects on its own (see `infra::irc`), so
    /// "the stream is still open" no longer implies "we are online".
    Status(ChatStatus, String),
    /// We are now in this channel (or have opened this private conversation).
    ChannelJoined(String),
    /// We have left it.
    ChannelLeft(String),
    /// The channel's topic, as set or as reported on join.
    Topic {
        channel: String,
        topic: String,
    },
    /// A new line in the channel: including our own sent messages, since this
    /// client doesn't negotiate IRC's `echo-message` capability; the port is
    /// responsible for the local echo (see `infra::chat`/`infra::irc`).
    Message {
        channel: String,
        message: ChatMessage,
    },
    /// A fresh full snapshot of who's in the channel.
    Users {
        channel: String,
        users: Vec<ChatUser>,
    },
    UserJoined {
        channel: String,
        user: ChatUser,
    },
    UserLeft {
        channel: String,
        user: String,
    },
    /// A user's channel mode changed (op granted/revoked, voice, …).
    UserElevation {
        channel: String,
        user: String,
        elevation: String,
    },
    /// A nick change, which applies to every channel that user is in.
    UserRenamed {
        old_name: String,
        new_name: String,
    },
}

#[async_trait]
pub trait ChatPort: Send + Sync {
    /// Connect and join the default channel as `username`. The receiver yields
    /// a [`ChatUpdate`] on each change; it closes only when the session is torn
    /// down for good (a transient network failure is retried internally).
    async fn connect(&self, username: String) -> mpsc::Receiver<ChatUpdate>;

    /// Send a message to `channel`. A no-op if there is no active connection.
    fn send_message(&self, channel: String, content: String);

    /// Send a CTCP ACTION (`/me`) to `channel`.
    fn send_action(&self, channel: String, content: String);

    /// Join a channel, or open a private conversation when `channel` has no
    /// leading `#` (which needs no server round trip).
    fn join_channel(&self, channel: String);

    /// Leave a channel or close a private conversation.
    fn leave_channel(&self, channel: String, reason: String);

    /// Set a channel's topic. Silently ignored by the server if we lack the
    /// privilege, which is why there is no result here.
    fn set_topic(&self, channel: String, topic: String);

    /// Cancel the active connection, if any. Idempotent.
    fn disconnect(&self);
}
