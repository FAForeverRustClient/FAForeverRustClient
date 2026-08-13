//! Fake chat provider: simulates the IRC session without any network.
//!
//! Stands in for `infra::irc`. On `connect` it seeds `#aeolus` with a roster
//! (including a couple of elevated users and the connecting user), a topic, and
//! a short scrollback, then idles until cancelled: unlike `FakeLobby` there's
//! no need to keep simulating activity for the offline dev path to be useful.
//! Joining another channel or opening a private conversation works too, so the
//! multi-channel UI is exercisable without a live account.
//!
//! Sends are echoed straight back onto the update stream: this **is** the local
//! echo (the real client doesn't negotiate IRC's `echo-message` capability
//! either, so both fake and real ports own it). Seeding happens synchronously
//! inside `connect` rather than on a spawned task so a send that arrives
//! immediately afterwards can never be ordered ahead of the welcome lines.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_domain::state::{ChatMessage, ChatMessageKind, ChatStatus, ChatUser, DEFAULT_CHANNEL};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::ports::{ChatPort, ChatUpdate};

#[derive(Debug, Default)]
pub struct FakeChat {
    cancel: Arc<Mutex<Option<CancellationToken>>>,
    /// The live connection's update sender, so the sync methods below can push
    /// onto the same stream the service is draining.
    updates: Arc<Mutex<Option<mpsc::Sender<ChatUpdate>>>>,
    username: Arc<Mutex<String>>,
    next_id: Arc<AtomicU64>,
}

impl FakeChat {
    /// Push an update onto the live stream, if there is one. `try_send` (not a
    /// spawned `send`) so updates keep the order they were produced in.
    fn push(&self, update: ChatUpdate) -> bool {
        self.updates
            .lock()
            .unwrap()
            .as_ref()
            .map(|tx| tx.try_send(update).is_ok())
            .unwrap_or(false)
    }

    fn message(&self, sender: &str, content: &str, kind: ChatMessageKind) -> ChatMessage {
        ChatMessage {
            id: self.next_id.fetch_add(1, Ordering::SeqCst).to_string(),
            sender: sender.to_string(),
            content: content.to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            kind,
        }
    }

    fn echo(&self, channel: String, content: String, kind: ChatMessageKind) {
        let sender = self.username.lock().unwrap().clone();
        let message = self.message(&sender, &content, kind);
        if !self.push(ChatUpdate::Message { channel, message }) {
            tracing::warn!("chat send ignored because there is no active connection");
        }
    }
}

#[async_trait]
impl ChatPort for FakeChat {
    async fn connect(&self, username: String) -> mpsc::Receiver<ChatUpdate> {
        let token = CancellationToken::new();
        if let Some(prev) = self.cancel.lock().unwrap().replace(token.clone()) {
            prev.cancel();
        }
        *self.username.lock().unwrap() = username.clone();

        let (tx, rx) = mpsc::channel(64);
        *self.updates.lock().unwrap() = Some(tx);

        self.push(ChatUpdate::Status(ChatStatus::Connecting, String::new()));
        self.push(ChatUpdate::Status(ChatStatus::Connected, username.clone()));
        self.push(ChatUpdate::ChannelJoined(DEFAULT_CHANNEL.into()));
        self.push(ChatUpdate::Topic {
            channel: DEFAULT_CHANNEL.into(),
            topic: "Welcome to Forged Alliance Forever: be excellent to each other.".into(),
        });
        self.push(ChatUpdate::Users {
            channel: DEFAULT_CHANNEL.into(),
            users: seed_users(&username),
        });
        for (sender, content) in seed_messages() {
            let message = self.message(sender, content, ChatMessageKind::Message);
            self.push(ChatUpdate::Message {
                channel: DEFAULT_CHANNEL.into(),
                message,
            });
        }

        // Idle until disconnected: no artificial ticking needed here.
        tokio::spawn(async move { token.cancelled().await });
        rx
    }

    fn send_message(&self, channel: String, content: String) {
        self.echo(channel, content, ChatMessageKind::Message);
    }

    fn send_action(&self, channel: String, content: String) {
        self.echo(channel, content, ChatMessageKind::Action);
    }

    fn join_channel(&self, channel: String) {
        let is_public = channel.starts_with('#');
        if !self.push(ChatUpdate::ChannelJoined(channel.clone())) {
            return;
        }
        if is_public {
            let username = self.username.lock().unwrap().clone();
            self.push(ChatUpdate::Users {
                channel,
                users: seed_users(&username),
            });
        }
    }

    fn leave_channel(&self, channel: String, _reason: String) {
        self.push(ChatUpdate::ChannelLeft(channel));
    }

    fn set_topic(&self, channel: String, topic: String) {
        self.push(ChatUpdate::Topic { channel, topic });
    }

    fn disconnect(&self) {
        if let Some(token) = self.cancel.lock().unwrap().take() {
            token.cancel();
        }
        self.push(ChatUpdate::Status(ChatStatus::Disconnected, String::new()));
        *self.updates.lock().unwrap() = None;
    }
}

/// A roster with one op, one voiced user and the connecting user, so the
/// category grouping in the user list has something to group.
fn seed_users(username: &str) -> Vec<ChatUser> {
    vec![
        ChatUser::new("ArchSupport", "@"),
        ChatUser::new("Stormlord", "+"),
        ChatUser::new("Aurora", ""),
        ChatUser::new("Sheikah", ""),
        ChatUser::new(username, ""),
    ]
}

fn seed_messages() -> Vec<(&'static str, &'static str)> {
    vec![
        ("ArchSupport", "Welcome to #aeolus!"),
        ("Stormlord", "anyone up for a 2v2?"),
        ("Aurora", "give me ten minutes and I'm in"),
    ]
}
