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
    /// A calendar event the player asked to be reminded about is coming up.
    EventReminder,
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
    /// A newer client release exists. The banner says so too, but the banner
    /// lives at the top of one workspace and this survives a tab change.
    ClientUpdate,
    Error,
}

impl NotificationKind {
    /// Whether this kind may leave the client and become an operating-system
    /// notification.
    ///
    /// The client used to mirror its whole notification stream to the OS, so a
    /// friend coming online, a review reminder and a report receipt all pushed
    /// a toast over whatever the user was doing. That is not what an OS
    /// notification is for. It interrupts; the notification centre does not,
    /// and it is still there when the user comes back.
    ///
    /// So the test for this list is narrow, and it is not "is this important".
    /// It is: **is somebody or something waiting on an answer that expires?**
    ///
    /// - [`Self::MatchFound`]: the queue popped and the timer is running.
    /// - [`Self::PartyInvite`]: another player is sitting there waiting.
    /// - [`Self::GameLaunched`]: the game is up and the lobby is holding.
    /// - [`Self::MapGenerated`]: generation is slow, which is exactly why the
    ///   user tabbed away, and a lobby join is blocked until it finishes.
    /// - [`Self::EventReminder`]: the player asked to be told before a thing
    ///   starts, and being told after it started is the one failure a reminder
    ///   has. It is also the only kind on this list the player opted into one
    ///   at a time.
    ///
    /// Everything else fails that test, including the loud-sounding ones. An
    /// error, a server notice, a cache warning and a new client version are all
    /// worth reading; none of them is worth taking the screen away from
    /// somebody mid-game, and all of them keep.
    ///
    /// Users who preferred the old behaviour can have it back with
    /// `settings.notifications.desktop_all_kinds`; this list is what the switch
    /// means when it is off, which is the default.
    pub fn raises_os_notification(self) -> bool {
        matches!(
            self,
            Self::MatchFound
                | Self::PartyInvite
                | Self::GameLaunched
                | Self::MapGenerated
                | Self::EventReminder
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NotificationAction {
    OpenChat {
        channel: String,
    },
    OpenMatchmaking,
    OpenCustomGames,
    AcceptPartyInvite {
        player_id: i32,
    },
    WatchLive {
        target: super::LiveReplayTarget,
    },
    OpenSettings {
        section: Option<String>,
    },
    /// Open the calendar on one occurrence's detail panel.
    #[serde(rename_all = "camelCase")]
    OpenEvent {
        occurrence_id: String,
    },
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

    #[test]
    fn only_the_kinds_somebody_is_waiting_on_leave_the_client() {
        for kind in [
            NotificationKind::MatchFound,
            NotificationKind::PartyInvite,
            NotificationKind::GameLaunched,
            NotificationKind::MapGenerated,
        ] {
            assert!(kind.raises_os_notification(), "{kind:?} expires");
        }

        // The ones that read as urgent and are not: all of these keep until the
        // user looks at the client again, and none is worth taking the screen
        // away from somebody mid-game.
        for kind in [
            NotificationKind::Error,
            NotificationKind::ServerWarning,
            NotificationKind::ServerNotice,
            NotificationKind::GameCacheAlert,
            NotificationKind::ClientUpdate,
            NotificationKind::PrivateMessage,
            NotificationKind::Mention,
            NotificationKind::FriendOnline,
            NotificationKind::FriendOffline,
            NotificationKind::FriendPlaying,
            NotificationKind::NewCustomGame,
            NotificationKind::GameFull,
            NotificationKind::ReviewReminder,
            NotificationKind::ReplayAvailable,
            NotificationKind::ReportSubmitted,
        ] {
            assert!(!kind.raises_os_notification(), "{kind:?} keeps");
        }
    }
}
