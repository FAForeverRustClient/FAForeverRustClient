//! Actionable client notifications retained in backend-owned state.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum NotificationKind {
    MatchFound,
    PrivateMessage,
    Mention,
    FriendOnline,
    FriendOffline,
    FriendPlaying,
    NewCustomGame,
    GameFull,
    GameLaunched,
    ReviewReminder,
    ReplayAvailable,
    PartyInvite,
    ReportSubmitted,
    /// An operational message authored by the FAF lobby server.
    ServerNotice,
    /// A non-fatal server notice that still requires attention.
    ServerWarning,
    /// A generated map finished building. Worth surfacing because generation is
    /// slow and usually kicked off in the background by a lobby join, so the
    /// user is very likely looking at something else when it completes.
    MapGenerated,
    /// Game file cache exceeded user-configured threshold size.
    GameCacheAlert,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NotificationAction {
    OpenChat { channel: String },
    OpenMatchmaking,
    OpenCustomGames,
    AcceptPartyInvite { player_id: i32 },
    WatchLive { target: super::LiveReplayTarget },
    OpenSettings { section: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientNotification {
    pub id: String,
    pub kind: NotificationKind,
    pub title: String,
    pub body: String,
    pub created_at: String,
    pub read: bool,
    pub action: Option<NotificationAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotificationState {
    pub items: Vec<ClientNotification>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum NotificationEvent {
    Added { notification: ClientNotification },
    Read { id: String },
    Dismissed { id: String },
    Cleared,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum NotificationCommand {
    MarkRead { id: String },
    Dismiss { id: String },
    Clear,
}

pub fn reduce(state: &mut NotificationState, event: &NotificationEvent) {
    match event {
        NotificationEvent::Added { notification } => {
            state.items.retain(|item| item.id != notification.id);
            state.items.insert(0, notification.clone());
            state.items.truncate(50);
        }
        NotificationEvent::Read { id } => {
            if let Some(item) = state.items.iter_mut().find(|item| &item.id == id) {
                item.read = true;
            }
        }
        NotificationEvent::Dismissed { id } => state.items.retain(|item| &item.id != id),
        NotificationEvent::Cleared => state.items.clear(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str) -> ClientNotification {
        ClientNotification {
            id: id.into(),
            kind: NotificationKind::Mention,
            title: "Mention".into(),
            body: "hello".into(),
            created_at: "now".into(),
            read: false,
            action: None,
        }
    }

    #[test]
    fn notifications_are_newest_first_and_bounded() {
        let mut state = NotificationState::default();
        for index in 0..55 {
            reduce(
                &mut state,
                &NotificationEvent::Added {
                    notification: item(&index.to_string()),
                },
            );
        }
        assert_eq!(state.items.len(), 50);
        assert_eq!(state.items[0].id, "54");
    }

    #[test]
    fn read_dismiss_and_clear_are_idempotent() {
        let mut state = NotificationState::default();
        reduce(
            &mut state,
            &NotificationEvent::Added {
                notification: item("1"),
            },
        );
        reduce(&mut state, &NotificationEvent::Read { id: "1".into() });
        assert!(state.items[0].read);
        reduce(&mut state, &NotificationEvent::Dismissed { id: "1".into() });
        reduce(&mut state, &NotificationEvent::Dismissed { id: "1".into() });
        reduce(&mut state, &NotificationEvent::Cleared);
        assert!(state.items.is_empty());
    }
}
