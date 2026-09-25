//! The tournament's chat rooms.

use super::*;

/// A chat room this account is allowed to see.
///
/// Visibility is decided server-side by permission, so the client shows what it
/// is given rather than filtering: an organisers-only room simply never arrives.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatRoom {
    pub id: String,
    pub name: String,
    /// Messages posted since this account last opened the room.
    pub unread: i32,
    /// Whether the match this room belongs to has been played.
    ///
    /// A room per match adds up fast, and a finished one is a conversation
    /// nobody is having any more. The service says which, and the list folds
    /// them into a group that starts collapsed rather than leaving a bracket's
    /// worth of dead rooms above the live ones.
    pub done: bool,
    /// Whether this account was named with `@` in this room and has not opened
    /// it since.
    ///
    /// Louder than the unread count and shown instead of it: being addressed
    /// by name is a different thing from a room having moved on, and it is the
    /// one a player is scanning for.
    pub mentioned: bool,
    /// Whether somebody typed `!organizer` here and no organiser has read it.
    ///
    /// Organiser-facing: it exists so they can find the room that wants them
    /// without skimming every one. The service clears it when an organiser
    /// opens the room.
    pub needs_organiser: bool,
    /// How many messages the room holds in total.
    pub count: i32,
}

impl ChatRoom {
    /// The badge this room shows, if any.
    ///
    /// One at a time, in the order a reader cares about them: being named
    /// beats a room having moved on, and both beat nothing. The organiser bell
    /// is not in here because it is drawn alongside rather than instead, and
    /// only for organisers.
    pub fn badge(&self) -> RoomBadge {
        if self.mentioned {
            RoomBadge::Mentioned
        } else if self.unread > 0 {
            RoomBadge::Unread
        } else {
            RoomBadge::None
        }
    }
}

/// What a room's list entry marks itself with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RoomBadge {
    #[default]
    None,
    Unread,
    Mentioned,
}

/// One post in a tournament chat room.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatPost {
    pub id: String,
    pub author: String,
    /// The FAF account behind the name, where there is one. `None` for a
    /// system line and for anyone posting through a token rather than a login.
    ///
    /// Read so an organiser can silence the author of the post in front of
    /// them: `chat_mute` is addressed by account, and the name beside a post is
    /// free text with nothing to resolve it against.
    pub faf_id: Option<i32>,
    pub body: String,
    /// Unix seconds.
    pub at: Option<u32>,
    /// The server's own announcements, such as dice rolls and organiser pings, which the
    /// room shows differently from something a person typed.
    pub system: bool,
}
