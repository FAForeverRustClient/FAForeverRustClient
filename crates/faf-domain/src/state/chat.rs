//! Chat slice — a single default IRC channel, its message history and the set
//! of currently online users. First slice modeling a persistent chat
//! connection; mirrors the lobby slice's status/stream shape (ARCHITECTURE.md
//! §5) rather than inventing a new one.

use serde::{Deserialize, Serialize};
use specta::Type;

/// The only channel this client joins for now (no multi-channel UI yet).
pub const DEFAULT_CHANNEL: &str = "#aeolus";

/// Bound on retained history so a long-running session doesn't grow state
/// unbounded. Oldest messages are evicted first.
const MAX_MESSAGES: usize = 500;

/// A single chat message. `id`/`timestamp` are `String`: `id` avoids the
/// i64/specta boundary issue noted in `lobby.rs`'s `Game`, and `timestamp` is
/// stamped by the port (real IRC has no such field; the client stamps
/// receipt time) — keeping this pure slice free of a clock dependency.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub sender: String,
    pub content: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChatStatus {
    #[default]
    Disconnected,
    Connecting,
    Connected,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatState {
    pub status: ChatStatus,
    pub messages: Vec<ChatMessage>,
    /// Usernames currently in the channel, sorted for stable rendering.
    pub users: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ChatEvent {
    Connecting,
    Connected,
    MessageReceived { message: ChatMessage },
    UsersUpdated { users: Vec<String> },
    Disconnected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ChatCommand {
    /// Carries the username because IRC needs an explicit NICK/SASL authzid;
    /// the frontend already knows it (`auth.player.name`), so no new backend
    /// "current user" plumbing is needed — same posture as `LobbyCommand::Join`
    /// carrying UI-known data.
    Connect { username: String },
    SendMessage { content: String },
    Disconnect,
}

pub fn reduce(state: &mut ChatState, event: &ChatEvent) {
    match event {
        ChatEvent::Connecting => state.status = ChatStatus::Connecting,
        ChatEvent::Connected => state.status = ChatStatus::Connected,
        ChatEvent::MessageReceived { message } => {
            state.messages.push(message.clone());
            if state.messages.len() > MAX_MESSAGES {
                let excess = state.messages.len() - MAX_MESSAGES;
                state.messages.drain(0..excess);
            }
        }
        ChatEvent::UsersUpdated { users } => state.users = users.clone(),
        ChatEvent::Disconnected => {
            state.status = ChatStatus::Disconnected;
            state.users.clear();
            // Messages persist across reconnects — matches the Java client's
            // per-channel history retention.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str) -> ChatMessage {
        ChatMessage {
            id: id.into(),
            sender: "Stormlord".into(),
            content: format!("hello {id}"),
            timestamp: "2024-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn connecting_and_connected_set_status() {
        let mut s = ChatState::default();
        reduce(&mut s, &ChatEvent::Connecting);
        assert_eq!(s.status, ChatStatus::Connecting);
        reduce(&mut s, &ChatEvent::Connected);
        assert_eq!(s.status, ChatStatus::Connected);
    }

    #[test]
    fn message_received_appends() {
        let mut s = ChatState::default();
        reduce(
            &mut s,
            &ChatEvent::MessageReceived {
                message: message("1"),
            },
        );
        reduce(
            &mut s,
            &ChatEvent::MessageReceived {
                message: message("2"),
            },
        );
        assert_eq!(s.messages, vec![message("1"), message("2")]);
    }

    #[test]
    fn message_history_is_capped() {
        let mut s = ChatState::default();
        for i in 0..(MAX_MESSAGES + 10) {
            reduce(
                &mut s,
                &ChatEvent::MessageReceived {
                    message: message(&i.to_string()),
                },
            );
        }
        assert_eq!(s.messages.len(), MAX_MESSAGES);
        // Oldest were evicted; the newest survive.
        assert_eq!(s.messages.last().unwrap().id, (MAX_MESSAGES + 9).to_string());
    }

    #[test]
    fn users_updated_replaces_snapshot() {
        let mut s = ChatState::default();
        reduce(
            &mut s,
            &ChatEvent::UsersUpdated {
                users: vec!["a".into(), "b".into()],
            },
        );
        assert_eq!(s.users, vec!["a", "b"]);
        reduce(
            &mut s,
            &ChatEvent::UsersUpdated {
                users: vec!["c".into()],
            },
        );
        assert_eq!(s.users, vec!["c"]);
    }

    #[test]
    fn disconnect_clears_status_and_users_but_keeps_messages() {
        let mut s = ChatState {
            status: ChatStatus::Connected,
            messages: vec![message("1")],
            users: vec!["a".into()],
        };
        reduce(&mut s, &ChatEvent::Disconnected);
        assert_eq!(s.status, ChatStatus::Disconnected);
        assert!(s.users.is_empty());
        assert_eq!(s.messages, vec![message("1")]);
    }
}
