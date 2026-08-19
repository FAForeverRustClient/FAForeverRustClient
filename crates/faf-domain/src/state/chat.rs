//! Chat slice: the joined IRC channels, their message history, topic and
//! roster, plus which one the user is currently reading.
//!
//! Modeled on the two reference clients, which agree on the shape even though
//! they disagree on everything else: a set of channels (public `#name` plus
//! per-user private conversations), each owning its own scrollback and user
//! list, with unread counters driving the channel switcher. Mirrors the lobby
//! slice's status/stream shape (ARCHITECTURE.md §5) for the connection itself.

use serde::{Deserialize, Serialize};
use specta::Type;

/// The channel every client joins on connect. Always first in the switcher and
/// never closable, matching both reference clients.
pub const DEFAULT_CHANNEL: &str = "#aeolus";

/// Stable settings key for a player's read position in one IRC channel.
/// Account and channel names are case-insensitive on FAF's IRC service, so
/// normalizing both parts keeps a reconnect from creating a second marker.
pub fn read_marker_key(username: &str, channel: &str) -> String {
    format!(
        "{}\u{1f}{}",
        username.trim().to_ascii_lowercase(),
        channel.trim().to_ascii_lowercase()
    )
}

/// Bound on retained history *per channel* so a long-running session doesn't
/// grow state unbounded. Oldest messages are evicted first. Matches the Python
/// client's `max_chat_lines` default and the size of the history backfill the
/// server will hand us on join.
const MAX_MESSAGES: usize = 500;

/// Histories retained after explicitly leaving a channel. Keeping this bound
/// prevents cycling through arbitrary private conversations from growing the
/// application snapshot forever. The Python client's `ChatLineRestorer`
/// retains lines independently from the live channel object; this is the same
/// model with an explicit desktop-session bound.
const MAX_RETAINED_HISTORIES: usize = 20;

/// IRC mode-prefix characters that mark a channel operator. `+` (voice) is
/// deliberately excluded: it confers no moderation power, and the Java client
/// only treats op-and-above as `MODERATOR`.
const MODERATOR_PREFIXES: [char; 4] = ['~', '&', '@', '%'];

/// What a line in the scrollback *is*. The Python client calls this
/// `ChatLineType` and styles each differently; carrying it in state (rather
/// than encoding it into the text) keeps the rendering decision in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChatMessageKind {
    /// An ordinary `PRIVMSG`.
    #[default]
    Message,
    /// A CTCP `ACTION` (`/me waves`): rendered as "* nick waves".
    Action,
    /// An IRC `NOTICE`, usually from a bot or a service.
    Notice,
    /// Client-generated commentary: joins, parts, quits, topic changes.
    Info,
    /// Client-generated failure (unknown command, send failed).
    Error,
}

/// A single chat message. `id`/`timestamp` are `String`: `id` avoids the
/// i64/specta boundary issue noted in `lobby.rs`'s `Game`, and `timestamp` is
/// an RFC 3339 instant stamped by the port: from the IRCv3 `server-time` tag
/// when the server sends one (which is what makes replayed history land in the
/// right order), otherwise receipt time. Keeping it a string leaves this pure
/// slice free of a clock dependency.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub sender: String,
    pub content: String,
    pub timestamp: String,
    pub kind: ChatMessageKind,
    /// The server's IRCv3 `msgid`, empty when it sent none.
    ///
    /// Distinct from `id`, which is a local counter minted on receipt: that
    /// one is unique in this session and meaningless to anyone else, while
    /// this is the handle every participant agrees on. Reactions and replies
    /// are anchored to it, which is why a message without one can carry
    /// neither.
    #[serde(default)]
    pub msgid: String,
    /// The `msgid` this message answers, empty when it answers nothing.
    ///
    /// Only the id is carried, never a copy of the quoted text: the original
    /// is already in the scrollback, and duplicating it would let the two
    /// drift apart after an edit or a redaction.
    #[serde(default)]
    pub reply_to: String,
}

/// One member of a channel's roster.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatUser {
    pub name: String,
    /// The raw IRC mode prefix(es) this user carries in this channel (`"@"`,
    /// `"~"`, `"+"`, or empty). Per-channel by nature: the Java client's
    /// `ChatChannelUser` doc calls this out as the reason a user needs one
    /// instance per channel.
    pub elevation: String,
}

impl ChatUser {
    pub fn new(name: impl Into<String>, elevation: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            elevation: elevation.into(),
        }
    }

    /// Channel operator or above: the Java client's `MODERATOR` category.
    pub fn is_moderator(&self) -> bool {
        self.elevation
            .chars()
            .any(|c| MODERATOR_PREFIXES.contains(&c))
    }
}

/// One conversation: a public `#channel` or a private per-user exchange.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatChannel {
    pub name: String,
    /// The channel topic, empty when unset. Private conversations never have one.
    pub topic: String,
    pub messages: Vec<ChatMessage>,
    /// Roster, sorted case-insensitively by name for stable rendering. Always
    /// empty for a private conversation.
    pub users: Vec<ChatUser>,
    /// Messages received while this channel was not the active one.
    pub unread: u32,
    /// Of those, how many named us (or arrived in a private conversation),
    /// the Python client's "important" tab state, which deserves a louder badge.
    pub unread_mentions: u32,
    /// Who the server last told us is composing here, newest last.
    ///
    /// Carries the instant each notice arrived rather than a bare list,
    /// because a typing notice has to *expire*: the sender promises to send
    /// `done`, and a client that is killed mid-sentence never does. Readers
    /// filter with [`ChatChannel::typists_at`]; the reducer prunes on the
    /// events it already sees, so a stale entry cannot outlive the next thing
    /// that happens in the channel.
    #[serde(default)]
    pub typing: Vec<TypingNotice>,
    /// Reactions to messages in this channel, keyed by the server's message id.
    #[serde(default)]
    pub reactions: Vec<MessageReactions>,
}

/// Someone composing a message, and when we last heard so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TypingNotice {
    pub nickname: String,
    /// Unix seconds. `u32` because specta rejects 64-bit integers on this
    /// boundary; it overflows in 2106, which is not this decade's problem.
    pub at_seconds: u32,
}

/// Every reaction carried by one message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MessageReactions {
    /// The server's `msgid` for the message being reacted to.
    pub msgid: String,
    pub entries: Vec<Reaction>,
}

/// One emoji on one message, and who put it there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Reaction {
    pub emoji: String,
    /// Reactors in arrival order. A nickname appears at most once: the draft
    /// spec has no retraction, so a repeat is a duplicate, not a toggle.
    pub senders: Vec<String>,
}

/// How long a typing notice is worth showing.
///
/// The IRCv3 draft puts the refresh interval at three seconds; six gives a
/// slow or briefly stalled sender one missed refresh before the indicator
/// disappears, without leaving it up long enough to be a lie.
pub const TYPING_TIMEOUT_SECONDS: u32 = 6;

/// Scrollback detached from a channel that is no longer joined. Deliberately
/// excludes topic, roster and unread state: those are live server facts and
/// must be rebuilt when the channel is joined again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RetainedChatHistory {
    pub channel: String,
    pub messages: Vec<ChatMessage>,
}

impl ChatChannel {
    fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Default::default()
        }
    }

    /// A private conversation with a single user, not a server-side channel.
    pub fn is_private(&self) -> bool {
        !self.name.starts_with('#')
    }

    /// Who is still composing as of `now` (Unix seconds), excluding `viewer`.
    ///
    /// Filtering at read time rather than expiring with a timer is deliberate:
    /// nothing in the domain can run a clock, and an expiry event per second
    /// per typist would be a stream of deltas that says nothing new. The state
    /// records what the server said and when; how long that stays true is a
    /// question only the reader's clock can answer.
    ///
    /// `viewer` is dropped because the server echoes our own `TAGMSG` back to
    /// us, and "you are typing" is not news.
    pub fn typists_at(&self, now: u32, viewer: &str) -> Vec<&str> {
        self.typing
            .iter()
            .filter(|notice| now.saturating_sub(notice.at_seconds) < TYPING_TIMEOUT_SECONDS)
            .filter(|notice| !notice.nickname.eq_ignore_ascii_case(viewer))
            .map(|notice| notice.nickname.as_str())
            .collect()
    }

    /// The reactions on one message, or an empty slice when it has none.
    pub fn reactions_for(&self, msgid: &str) -> &[Reaction] {
        self.reactions
            .iter()
            .find(|entry| entry.msgid == msgid)
            .map_or(&[], |entry| entry.entries.as_slice())
    }

    fn note_typing(&mut self, nickname: &str, at_seconds: u32, composing: bool) {
        self.typing
            .retain(|notice| !notice.nickname.eq_ignore_ascii_case(nickname));
        // Anything that has aged out is dropped while we are here, so an
        // abandoned entry cannot outlive the next event in the channel.
        self.typing
            .retain(|notice| at_seconds.saturating_sub(notice.at_seconds) < TYPING_TIMEOUT_SECONDS);
        if composing {
            self.typing.push(TypingNotice {
                nickname: nickname.to_string(),
                at_seconds,
            });
        }
    }

    fn add_reaction(&mut self, msgid: &str, emoji: &str, sender: &str) {
        let message = match self.reactions.iter_mut().find(|entry| entry.msgid == msgid) {
            Some(existing) => existing,
            None => {
                self.reactions.push(MessageReactions {
                    msgid: msgid.to_string(),
                    entries: Vec::new(),
                });
                self.reactions.last_mut().expect("just pushed")
            }
        };
        let reaction = match message.entries.iter_mut().find(|r| r.emoji == emoji) {
            Some(existing) => existing,
            None => {
                message.entries.push(Reaction {
                    emoji: emoji.to_string(),
                    senders: Vec::new(),
                });
                message.entries.last_mut().expect("just pushed")
            }
        };
        // A repeat from the same person is a duplicate to swallow. Removal is
        // an explicit message (see `remove_reaction`), never a second add.
        if !reaction
            .senders
            .iter()
            .any(|s| s.eq_ignore_ascii_case(sender))
        {
            reaction.senders.push(sender.to_string());
        }
    }

    fn remove_reaction(&mut self, msgid: &str, emoji: &str, sender: &str) {
        let Some(message) = self.reactions.iter_mut().find(|entry| entry.msgid == msgid) else {
            return;
        };
        if let Some(reaction) = message.entries.iter_mut().find(|r| r.emoji == emoji) {
            reaction.senders.retain(|s| !s.eq_ignore_ascii_case(sender));
        }
        // An emoji nobody stands behind any more is not a zero, it is gone.
        message.entries.retain(|entry| !entry.senders.is_empty());
        self.reactions.retain(|entry| !entry.entries.is_empty());
    }
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
    /// Our own nick, once known. Needed to mark our own lines, to detect
    /// mentions, and to place ourselves first in the roster.
    pub username: String,
    pub channels: Vec<ChatChannel>,
    /// Recently closed conversations whose local scrollback can be restored
    /// if they are reopened during this desktop session.
    pub retained_histories: Vec<RetainedChatHistory>,
    /// Name of the channel currently being read. Empty before the first join.
    pub active_channel: String,
    /// Whether join/part/quit commentary is shown in the scrollback. The
    /// Python client makes this a preference (`chat_config.joinsparts`) because
    /// `#aeolus` is busy enough that it drowns out conversation; default off.
    pub show_joins_parts: bool,
    /// Channels the *lobby server* told us to join, from the `autojoin` field
    /// of its `social` message. Clan and other account-specific channels can
    /// arrive here. Language channels are derived separately from the OS
    /// language or player country by [`auto_join_channels`].
    ///
    /// Retained in state rather than acted on the instant it arrives, because
    /// the lobby socket and the IRC connection come up independently and in
    /// either order. Both reference clients solve the same race by buffering
    /// (Java's `bufferedChannels`, Python's `_saved_lobby_channels`); keeping
    /// the list here means a reconnect re-joins them without asking the lobby
    /// to repeat itself.
    pub server_auto_join: Vec<String>,
}

impl ChatState {
    pub fn channel(&self, name: &str) -> Option<&ChatChannel> {
        self.channels.iter().find(|c| c.name == name)
    }

    fn channel_mut(&mut self, name: &str) -> Option<&mut ChatChannel> {
        self.channels.iter_mut().find(|c| c.name == name)
    }

    /// Get the channel, creating it if this is the first we've heard of it,
    /// how an unsolicited private message opens a conversation in both
    /// reference clients.
    fn ensure_channel(&mut self, name: &str) -> &mut ChatChannel {
        if self.channel(name).is_none() {
            let messages = self
                .retained_histories
                .iter()
                .position(|history| history.channel == name)
                .map(|index| self.retained_histories.remove(index).messages)
                .unwrap_or_default();
            let mut channel = ChatChannel::new(name);
            channel.messages = messages;
            self.channels.push(channel);
            sort_channels(&mut self.channels);
        }
        self.channel_mut(name).expect("just inserted")
    }
}

/// Does `content` name `username`? Case-insensitive, and bounded by non-word
/// characters so "Sheikah" doesn't light up for "Sheik". Mirrors the Python
/// client's `mentions_me` and the Java client's mention highlighting.
pub fn mentions(content: &str, username: &str) -> bool {
    if username.is_empty() {
        return false;
    }
    let haystack = content.to_lowercase();
    let needle = username.to_lowercase();
    let is_word = |c: char| c.is_alphanumeric() || c == '_' || c == '-' || c == '[' || c == ']';

    let mut from = 0;
    while let Some(offset) = haystack[from..].find(&needle) {
        let start = from + offset;
        let end = start + needle.len();
        let before_ok = haystack[..start]
            .chars()
            .next_back()
            .is_none_or(|c| !is_word(c));
        let after_ok = haystack[end..].chars().next().is_none_or(|c| !is_word(c));
        if before_ok && after_ok {
            return true;
        }
        // Advance past this occurrence; `needle` is non-empty so this terminates.
        from = start + needle.len().max(1);
        if from >= haystack.len() {
            break;
        }
    }
    false
}

/// Clean a list of channel names coming from outside this client: user
/// preferences, or the lobby server's `autojoin`.
///
/// Adds the `#` the server routinely omits (its `social` payload names
/// `aeolus`, not `#aeolus`), drops blanks, and de-duplicates case-insensitively
/// because IRC channel names are case-insensitive. Capped so neither a hand-
/// edited settings file nor an unexpected server response can push an unbounded
/// number of JOINs.
pub fn normalize_channels(channels: Vec<String>) -> Vec<String> {
    let mut normalized: Vec<String> = Vec::new();
    for channel in channels {
        let channel = channel.trim();
        if channel.is_empty() {
            continue;
        }
        let channel = if channel.starts_with('#') {
            channel.to_owned()
        } else {
            format!("#{channel}")
        };
        if !normalized
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(&channel))
        {
            normalized.push(channel);
        }
        if normalized.len() == MAX_AUTO_JOIN_CHANNELS {
            break;
        }
    }
    normalized
}

/// Ceiling on any externally supplied channel list.
const MAX_AUTO_JOIN_CHANNELS: usize = 20;

/// FAF's language channels, by the language code that selects them.
///
/// From the Python client's `chat/lang.py`. There are only three: FAF does not
/// run a channel per language, and the list is deliberately short. Its comment
/// on the Russian entry, "be conservative here", is the rule for editing this:
/// a wrong guess drops someone into a channel they cannot read.
const LANGUAGE_CHANNELS: [(&str, &str); 4] = [
    ("fr", "#french"),
    ("ru", "#russian"),
    ("by", "#russian"),
    ("de", "#german"),
];

/// Country code to language code, from the Python client's `util/lang.py`.
///
/// Two deliberate differences from that table, both noted rather than silently
/// applied:
///
/// - It maps `au` to German. `au` is Australia; Austria is `at`. Reproducing it
///   would put Australian players in `#german`, so this maps `at` instead.
/// - It has no entry for `fr`, so a French account only ever reached `#french`
///   through its OS language, never through its flag. `fr` is included here,
///   since `LANGUAGE_CHANNELS` plainly intends French players to land there.
///
/// Multilingual countries (`ch`, `be`, `ca`) are deliberately absent: there is
/// no single right answer for them, and the Python client omits them too.
const COUNTRY_LANGUAGES: [(&str, &str); 7] = [
    ("de", "de"),
    ("at", "de"),
    ("fr", "fr"),
    ("ru", "ru"),
    ("kz", "ru"),
    ("kg", "ru"),
    ("by", "by"),
];

/// Which language channel this player belongs in, if any.
///
/// Mirrors the Python client's `LanguageChannelChecker`: the OS language wins,
/// and the account's country flag is the fallback. Nothing here is sent by the
/// server, which is why a German player sees no `#german` until this runs.
///
/// `os_language` is whatever the platform reports, in any of the shapes it
/// tends to use (`de`, `de_DE.UTF-8`, `de-DE`); only the leading subtag is
/// read. `country` is the account's ISO 3166-1 alpha-2 flag.
pub fn language_channel(os_language: &str, country: &str) -> Option<&'static str> {
    let language = primary_subtag(os_language);
    if let Some(channel) = lookup(&LANGUAGE_CHANNELS, &language) {
        return Some(channel);
    }
    let country = country.trim().to_ascii_lowercase();
    let language = lookup(&COUNTRY_LANGUAGES, &country)?;
    lookup(&LANGUAGE_CHANNELS, language)
}

pub const NEWBIE_CHANNEL: &str = "#newbie";
pub const DEFAULT_NEWBIE_THRESHOLD: u32 = 50;

/// Total completed/played games known for the given player account.
///
/// Sources ratings from the live lobby snapshot (`state.social`), falling back
/// to the player-card profile (`state.player_card`) if loaded for this account.
/// Returns `None` if the account is unknown or unannounced, so callers can avoid
/// guessing when ratings are unavailable.
pub fn player_total_games(state: &super::AppState, login: &str) -> Option<u32> {
    if login.is_empty() {
        return None;
    }
    if let Some(profile) = state.social.player(login) {
        let total = profile
            .ratings
            .iter()
            .map(|r| r.games_played.max(0) as u32)
            .sum::<u32>();
        return Some(total);
    }
    if let Some(card) = &state.player_card.profile {
        if card.login.eq_ignore_ascii_case(login) {
            let total = card
                .ratings
                .iter()
                .map(|r| r.games_played.max(0) as u32)
                .sum::<u32>();
            return Some(total);
        }
    }
    None
}

/// Every channel this account should be in, in reference-client join order.
///
/// This is a pure state projection shared by the lobby and chat services. The
/// lobby server contributes account-specific channels, while the client adds
/// the optional newbie channel, language channel and the user's saved channels.
/// IRC channel names are case-insensitive, so duplicates are removed without reordering.
pub fn auto_join_channels(state: &super::AppState, os_language: &str) -> Vec<String> {
    let mut channels = state.chat.server_auto_join.clone();
    let mut push = |channel: String| {
        if !channels
            .iter()
            .any(|known| known.eq_ignore_ascii_case(&channel))
        {
            channels.push(channel);
        }
    };

    let login = if state.chat.username.is_empty() {
        state
            .auth
            .player
            .as_ref()
            .map(|player| player.name.as_str())
            .unwrap_or_default()
    } else {
        state.chat.username.as_str()
    };

    if state.settings.chat.auto_join_newbie_channel {
        if let Some(games) = player_total_games(state, login) {
            if games < state.settings.chat.newbie_channel_game_threshold {
                push(NEWBIE_CHANNEL.to_string());
            }
        }
    }

    if state.settings.chat.auto_join_language_channel {
        let country = state
            .social
            .player(login)
            .map(|profile| profile.country.as_str())
            .unwrap_or_default();
        if let Some(channel) = language_channel(os_language, country) {
            push(channel.to_string());
        }
    }

    for channel in &state.settings.chat.auto_join_channels {
        push(channel.clone());
    }
    channels
}

/// `de_DE.UTF-8` and `de-DE` both reduce to `de`.
fn primary_subtag(locale: &str) -> String {
    locale
        .split(['_', '-', '.'])
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

fn lookup<'a>(table: &[(&str, &'a str)], key: &str) -> Option<&'a str> {
    table
        .iter()
        .find(|(candidate, _)| *candidate == key)
        .map(|(_, value)| *value)
}

/// Default channel first, then public channels, then private conversations,
/// each group alphabetical. The Java client pins the default channel to index 0
/// the same way.
fn sort_channels(channels: &mut [ChatChannel]) {
    channels.sort_by(|a, b| {
        let rank = |c: &ChatChannel| match () {
            _ if c.name == DEFAULT_CHANNEL => 0,
            _ if !c.is_private() => 1,
            _ => 2,
        };
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

fn sort_users(users: &mut [ChatUser]) {
    users.sort_by_key(|u| u.name.to_lowercase());
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ChatEvent {
    Connecting,
    /// Registered with the server under `username` (which may differ from the
    /// requested nick if it was taken).
    Connected {
        username: String,
    },
    ChannelJoined {
        channel: String,
    },
    ChannelLeft {
        channel: String,
    },
    /// The user switched to `channel`, which clears its unread counters.
    ChannelSelected {
        channel: String,
    },
    TopicChanged {
        channel: String,
        topic: String,
    },
    MessageReceived {
        channel: String,
        message: ChatMessage,
    },
    /// A message that belongs to the restored history at or before the
    /// persisted read marker. It is rendered like any other message but does
    /// not recreate an unread badge after a new login.
    MessageReceivedQuietly {
        channel: String,
        message: ChatMessage,
    },
    /// A full roster snapshot, replacing whatever we had (`RPL_ENDOFNAMES`).
    UsersUpdated {
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
    UserElevationChanged {
        channel: String,
        user: String,
        elevation: String,
    },
    /// A nick change, which applies to every channel the user is in.
    UserRenamed {
        old_name: String,
        new_name: String,
    },
    JoinsPartsToggled {
        enabled: bool,
    },
    /// The lobby server announced which channels this account belongs in
    /// (language, clan, and whatever else it assigns).
    AutoJoinAnnounced {
        channels: Vec<String>,
    },
    /// Someone started or stopped composing. `composing` is false for the
    /// draft spec's `done` and `paused`: both mean "stop showing this", and
    /// the difference between them is not worth a second indicator.
    TypingChanged {
        channel: String,
        nickname: String,
        composing: bool,
        /// Unix seconds at which this was observed; the reducer stores it so
        /// readers can expire the notice without a timer in the domain.
        at_seconds: u32,
    },
    /// Someone reacted to a message.
    ReactionReceived {
        channel: String,
        msgid: String,
        emoji: String,
        sender: String,
    },
    /// Someone took their reaction back.
    ///
    /// The IRCv3 draft defines no retraction at all, so this rides on a client
    /// tag of this client's own (`+draft/unreact`). Between two of these
    /// clients it works; a client that does not know the tag keeps showing the
    /// reaction, and there is no way to make it not.
    ReactionRemoved {
        channel: String,
        msgid: String,
        emoji: String,
        sender: String,
    },
    Disconnected,
}

// `rename_all_fields` matches `ChatEvent` above. Every field this enum had
// until now was a single word, so the omission was invisible; the first
// two-word field would have crossed the boundary as `reply_to` while every
// other payload in the client is camelCase.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ChatCommand {
    /// Carries the username because IRC needs an explicit NICK/SASL authzid;
    /// the frontend already knows it (`auth.player.name`), so no new backend
    /// "current user" plumbing is needed: same posture as `LobbyCommand::Join`
    /// carrying UI-known data.
    Connect {
        username: String,
    },
    /// Send raw composer input to `channel`. `content` may be a slash command
    /// (`/me`, `/join`, `/msg`, `/topic`, `/leave`); parsing lives in the
    /// backend (`protocol::chat_input`) so both the meaning of a command and
    /// its tests stay in one place.
    SendMessage {
        channel: String,
        content: String,
        /// The `msgid` being answered, empty for an ordinary line.
        #[serde(default)]
        reply_to: String,
    },
    JoinChannel {
        channel: String,
    },
    LeaveChannel {
        channel: String,
    },
    SelectChannel {
        channel: String,
    },
    SetShowJoinsParts {
        enabled: bool,
    },
    /// Tell the channel whether we are composing. Sent as the composer is
    /// used, not on every keystroke: the service throttles it.
    SetTyping {
        channel: String,
        composing: bool,
    },
    /// React to a message with an emoji. `msgid` is the server's, so a message
    /// the server never tagged cannot be reacted to.
    React {
        channel: String,
        msgid: String,
        emoji: String,
    },
    /// Take our own reaction back. Only ever our own: the tag carries no
    /// authority to remove anybody else's, and neither does this.
    Unreact {
        channel: String,
        msgid: String,
        emoji: String,
    },
    Disconnect,
}

pub fn reduce(state: &mut ChatState, event: &ChatEvent) {
    match event {
        ChatEvent::Connecting => state.status = ChatStatus::Connecting,
        ChatEvent::Connected { username } => {
            state.status = ChatStatus::Connected;
            state.username = username.clone();
        }
        ChatEvent::ChannelJoined { channel } => {
            state.ensure_channel(channel);
            if state.active_channel.is_empty() || channel == DEFAULT_CHANNEL {
                state.active_channel = channel.clone();
            }
        }
        ChatEvent::ChannelLeft { channel } => {
            let messages = state
                .channels
                .iter()
                .find(|c| &c.name == channel)
                .map(|left| left.messages.clone())
                .unwrap_or_default();
            if !messages.is_empty() {
                state
                    .retained_histories
                    .retain(|history| &history.channel != channel);
                state.retained_histories.push(RetainedChatHistory {
                    channel: channel.clone(),
                    messages,
                });
                if state.retained_histories.len() > MAX_RETAINED_HISTORIES {
                    let excess = state.retained_histories.len() - MAX_RETAINED_HISTORIES;
                    state.retained_histories.drain(0..excess);
                }
            }
            state.channels.retain(|c| &c.name != channel);
            if &state.active_channel == channel {
                state.active_channel = state
                    .channels
                    .first()
                    .map(|c| c.name.clone())
                    .unwrap_or_default();
            }
        }
        ChatEvent::ChannelSelected { channel } => {
            if let Some(c) = state.channel_mut(channel) {
                c.unread = 0;
                c.unread_mentions = 0;
                state.active_channel = channel.clone();
            }
        }
        ChatEvent::TopicChanged { channel, topic } => {
            state.ensure_channel(channel).topic = topic.clone();
        }
        ChatEvent::MessageReceived { channel, message }
        | ChatEvent::MessageReceivedQuietly { channel, message } => {
            let is_active = &state.active_channel == channel;
            let username = state.username.clone();
            let c = state.ensure_channel(channel);
            let is_private = c.is_private();

            c.messages.push(message.clone());
            if c.messages.len() > MAX_MESSAGES {
                let excess = c.messages.len() - MAX_MESSAGES;
                c.messages.drain(0..excess);
            }

            // Sending is the loudest possible "done typing". Relying on the
            // sender's own `done` would leave the indicator up for anyone
            // whose client does not send one, which is most of them.
            c.typing
                .retain(|notice| !notice.nickname.eq_ignore_ascii_case(&message.sender));

            // Our own lines and client-side commentary never count as unread.
            let from_self = message.sender == username;
            let counts = matches!(event, ChatEvent::MessageReceived { .. })
                && !is_active
                && !from_self
                && !matches!(message.kind, ChatMessageKind::Info | ChatMessageKind::Error);
            if counts {
                c.unread = c.unread.saturating_add(1);
                if is_private || mentions(&message.content, &username) {
                    c.unread_mentions = c.unread_mentions.saturating_add(1);
                }
            }
        }
        ChatEvent::UsersUpdated { channel, users } => {
            let c = state.ensure_channel(channel);
            c.users = users.clone();
            sort_users(&mut c.users);
        }
        ChatEvent::UserJoined { channel, user } => {
            let c = state.ensure_channel(channel);
            match c.users.iter_mut().find(|u| u.name == user.name) {
                Some(existing) => existing.elevation = user.elevation.clone(),
                None => {
                    c.users.push(user.clone());
                    sort_users(&mut c.users);
                }
            }
        }
        ChatEvent::UserLeft { channel, user } => {
            if let Some(c) = state.channel_mut(channel) {
                c.users.retain(|u| &u.name != user);
            }
        }
        ChatEvent::UserElevationChanged {
            channel,
            user,
            elevation,
        } => {
            if let Some(c) = state.channel_mut(channel) {
                if let Some(u) = c.users.iter_mut().find(|u| &u.name == user) {
                    u.elevation = elevation.clone();
                }
            }
        }
        ChatEvent::UserRenamed { old_name, new_name } => {
            if &state.username == old_name {
                state.username = new_name.clone();
            }
            for c in &mut state.channels {
                if let Some(u) = c.users.iter_mut().find(|u| &u.name == old_name) {
                    u.name = new_name.clone();
                    sort_users(&mut c.users);
                }
            }
        }
        ChatEvent::JoinsPartsToggled { enabled } => state.show_joins_parts = *enabled,
        ChatEvent::AutoJoinAnnounced { channels } => {
            state.server_auto_join = normalize_channels(channels.clone());
        }
        ChatEvent::TypingChanged {
            channel,
            nickname,
            composing,
            at_seconds,
        } => {
            if let Some(c) = state.channel_mut(channel) {
                c.note_typing(nickname, *at_seconds, *composing);
            }
        }
        ChatEvent::ReactionRemoved {
            channel,
            msgid,
            emoji,
            sender,
        } => {
            if let Some(c) = state.channel_mut(channel) {
                c.remove_reaction(msgid, emoji, sender);
            }
        }
        ChatEvent::ReactionReceived {
            channel,
            msgid,
            emoji,
            sender,
        } => {
            // A reaction with no anchor cannot be placed, and storing it would
            // grow the slice with entries nothing can ever render.
            if msgid.is_empty() {
                return;
            }
            if let Some(c) = state.channel_mut(channel) {
                c.add_reaction(msgid, emoji, sender);
            }
        }
        ChatEvent::Disconnected => {
            state.status = ChatStatus::Disconnected;
            for c in &mut state.channels {
                c.users.clear();
            }
            // Channels and messages persist across reconnects: matches the
            // Java client's per-channel history retention.
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
            kind: ChatMessageKind::Message,
            msgid: format!("srv-{id}"),
            reply_to: String::new(),
        }
    }

    fn typing(channel: &str, nickname: &str, composing: bool, at_seconds: u32) -> ChatEvent {
        ChatEvent::TypingChanged {
            channel: channel.into(),
            nickname: nickname.into(),
            composing,
            at_seconds,
        }
    }

    fn reaction(channel: &str, msgid: &str, emoji: &str, sender: &str) -> ChatEvent {
        ChatEvent::ReactionReceived {
            channel: channel.into(),
            msgid: msgid.into(),
            emoji: emoji.into(),
            sender: sender.into(),
        }
    }

    fn connected(username: &str) -> ChatState {
        let mut s = ChatState::default();
        reduce(&mut s, &ChatEvent::Connecting);
        reduce(
            &mut s,
            &ChatEvent::Connected {
                username: username.into(),
            },
        );
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: DEFAULT_CHANNEL.into(),
            },
        );
        s
    }

    #[test]
    fn connecting_and_connected_set_status_and_username() {
        let s = connected("Aurora");
        assert_eq!(s.status, ChatStatus::Connected);
        assert_eq!(s.username, "Aurora");
    }

    #[test]
    fn joining_the_default_channel_makes_it_active() {
        let s = connected("Aurora");
        assert_eq!(s.active_channel, DEFAULT_CHANNEL);
        assert_eq!(s.channels.len(), 1);
    }

    #[test]
    fn read_marker_keys_normalize_account_and_channel() {
        assert_eq!(
            read_marker_key("  Aurora ", "#AeOlUs"),
            "aurora\u{1f}#aeolus"
        );
    }

    #[test]
    fn leaving_and_rejoining_restores_messages_but_not_live_channel_state() {
        let mut s = connected("Aurora");
        let channel = s.channel_mut(DEFAULT_CHANNEL).unwrap();
        channel.messages.push(message("saved"));
        channel.topic = "stale topic".into();
        channel.users.push(ChatUser::new("Stormlord", "@"));
        channel.unread = 3;
        channel.unread_mentions = 1;

        reduce(
            &mut s,
            &ChatEvent::ChannelLeft {
                channel: DEFAULT_CHANNEL.into(),
            },
        );
        assert!(s.channel(DEFAULT_CHANNEL).is_none());
        assert_eq!(s.retained_histories.len(), 1);

        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: DEFAULT_CHANNEL.into(),
            },
        );
        let restored = s.channel(DEFAULT_CHANNEL).unwrap();
        assert_eq!(restored.messages, vec![message("saved")]);
        assert!(restored.topic.is_empty());
        assert!(restored.users.is_empty());
        assert_eq!(restored.unread, 0);
        assert_eq!(restored.unread_mentions, 0);
        assert!(s.retained_histories.is_empty());
    }

    #[test]
    fn an_incoming_private_message_restores_a_closed_conversation() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::MessageReceived {
                channel: "Stormlord".into(),
                message: message("old"),
            },
        );
        reduce(
            &mut s,
            &ChatEvent::ChannelLeft {
                channel: "Stormlord".into(),
            },
        );
        reduce(
            &mut s,
            &ChatEvent::MessageReceived {
                channel: "Stormlord".into(),
                message: message("new"),
            },
        );

        let restored = s.channel("Stormlord").unwrap();
        assert_eq!(restored.messages, vec![message("old"), message("new")]);
        assert!(s.retained_histories.is_empty());
    }

    #[test]
    fn message_received_appends_to_its_channel() {
        let mut s = connected("Aurora");
        for id in ["1", "2"] {
            reduce(
                &mut s,
                &ChatEvent::MessageReceived {
                    channel: DEFAULT_CHANNEL.into(),
                    message: message(id),
                },
            );
        }
        assert_eq!(
            s.channel(DEFAULT_CHANNEL).unwrap().messages,
            vec![message("1"), message("2")]
        );
    }

    #[test]
    fn quiet_history_appends_without_unread() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#newbie".into(),
            },
        );
        reduce(
            &mut s,
            &ChatEvent::MessageReceivedQuietly {
                channel: "#newbie".into(),
                message: message("history"),
            },
        );

        let channel = s.channel("#newbie").unwrap();
        assert_eq!(channel.messages, vec![message("history")]);
        assert_eq!(channel.unread, 0);
        assert_eq!(channel.unread_mentions, 0);
    }

    #[test]
    fn message_history_is_capped_per_channel() {
        let mut s = connected("Aurora");
        for i in 0..(MAX_MESSAGES + 10) {
            reduce(
                &mut s,
                &ChatEvent::MessageReceived {
                    channel: DEFAULT_CHANNEL.into(),
                    message: message(&i.to_string()),
                },
            );
        }
        let c = s.channel(DEFAULT_CHANNEL).unwrap();
        assert_eq!(c.messages.len(), MAX_MESSAGES);
        assert_eq!(
            c.messages.last().unwrap().id,
            (MAX_MESSAGES + 9).to_string()
        );
    }

    #[test]
    fn a_message_for_an_unknown_channel_opens_it() {
        // How an unsolicited private message starts a conversation.
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::MessageReceived {
                channel: "Stormlord".into(),
                message: message("1"),
            },
        );
        assert!(s.channel("Stormlord").unwrap().is_private());
    }

    #[test]
    fn inactive_channel_counts_unread_and_mentions() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#newbie".into(),
            },
        );
        // #aeolus is still active, so #newbie accrues unread.
        let mut plain = message("1");
        plain.content = "anyone around?".into();
        let mut mention = message("2");
        mention.content = "aurora: gg".into();
        for m in [plain, mention] {
            reduce(
                &mut s,
                &ChatEvent::MessageReceived {
                    channel: "#newbie".into(),
                    message: m,
                },
            );
        }
        let c = s.channel("#newbie").unwrap();
        assert_eq!(c.unread, 2);
        assert_eq!(c.unread_mentions, 1);
    }

    #[test]
    fn private_messages_always_count_as_mentions() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::MessageReceived {
                channel: "Stormlord".into(),
                message: message("1"),
            },
        );
        assert_eq!(s.channel("Stormlord").unwrap().unread_mentions, 1);
    }

    #[test]
    fn own_messages_and_info_lines_never_count_as_unread() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#newbie".into(),
            },
        );
        let mut own = message("1");
        own.sender = "Aurora".into();
        let mut info = message("2");
        info.kind = ChatMessageKind::Info;
        for m in [own, info] {
            reduce(
                &mut s,
                &ChatEvent::MessageReceived {
                    channel: "#newbie".into(),
                    message: m,
                },
            );
        }
        assert_eq!(s.channel("#newbie").unwrap().unread, 0);
    }

    #[test]
    fn selecting_a_channel_clears_its_unread() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#newbie".into(),
            },
        );
        reduce(
            &mut s,
            &ChatEvent::MessageReceived {
                channel: "#newbie".into(),
                message: message("1"),
            },
        );
        reduce(
            &mut s,
            &ChatEvent::ChannelSelected {
                channel: "#newbie".into(),
            },
        );
        let c = s.channel("#newbie").unwrap();
        assert_eq!(s.active_channel, "#newbie");
        assert_eq!(c.unread, 0);
        assert_eq!(c.unread_mentions, 0);
    }

    #[test]
    fn leaving_the_active_channel_falls_back_to_another() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#newbie".into(),
            },
        );
        reduce(
            &mut s,
            &ChatEvent::ChannelSelected {
                channel: "#newbie".into(),
            },
        );
        reduce(
            &mut s,
            &ChatEvent::ChannelLeft {
                channel: "#newbie".into(),
            },
        );
        assert_eq!(s.active_channel, DEFAULT_CHANNEL);
        assert!(s.channel("#newbie").is_none());
    }

    #[test]
    fn channels_sort_default_first_then_public_then_private() {
        let mut s = connected("Aurora");
        for name in ["Stormlord", "#zulu", "#newbie"] {
            reduce(
                &mut s,
                &ChatEvent::ChannelJoined {
                    channel: name.into(),
                },
            );
        }
        let names: Vec<_> = s.channels.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            vec![DEFAULT_CHANNEL, "#newbie", "#zulu", "Stormlord"]
        );
    }

    #[test]
    fn users_updated_replaces_snapshot_sorted() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::UsersUpdated {
                channel: DEFAULT_CHANNEL.into(),
                users: vec![ChatUser::new("zed", ""), ChatUser::new("Abc", "@")],
            },
        );
        let users = &s.channel(DEFAULT_CHANNEL).unwrap().users;
        assert_eq!(users[0].name, "Abc");
        assert_eq!(users[1].name, "zed");
    }

    #[test]
    fn user_join_is_idempotent_and_refreshes_elevation() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::UserJoined {
                channel: DEFAULT_CHANNEL.into(),
                user: ChatUser::new("Stormlord", ""),
            },
        );
        reduce(
            &mut s,
            &ChatEvent::UserJoined {
                channel: DEFAULT_CHANNEL.into(),
                user: ChatUser::new("Stormlord", "@"),
            },
        );
        let users = &s.channel(DEFAULT_CHANNEL).unwrap().users;
        assert_eq!(users.len(), 1);
        assert!(users[0].is_moderator());
    }

    #[test]
    fn elevation_change_marks_moderator() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::UserJoined {
                channel: DEFAULT_CHANNEL.into(),
                user: ChatUser::new("Stormlord", ""),
            },
        );
        reduce(
            &mut s,
            &ChatEvent::UserElevationChanged {
                channel: DEFAULT_CHANNEL.into(),
                user: "Stormlord".into(),
                elevation: "@".into(),
            },
        );
        assert!(s.channel(DEFAULT_CHANNEL).unwrap().users[0].is_moderator());
    }

    #[test]
    fn voice_is_not_moderation() {
        assert!(!ChatUser::new("x", "+").is_moderator());
        assert!(ChatUser::new("x", "~").is_moderator());
    }

    #[test]
    fn rename_applies_across_channels_and_to_self() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#newbie".into(),
            },
        );
        for channel in [DEFAULT_CHANNEL, "#newbie"] {
            reduce(
                &mut s,
                &ChatEvent::UserJoined {
                    channel: channel.into(),
                    user: ChatUser::new("Aurora", ""),
                },
            );
        }
        reduce(
            &mut s,
            &ChatEvent::UserRenamed {
                old_name: "Aurora".into(),
                new_name: "Aurora_".into(),
            },
        );
        assert_eq!(s.username, "Aurora_");
        for channel in [DEFAULT_CHANNEL, "#newbie"] {
            assert_eq!(s.channel(channel).unwrap().users[0].name, "Aurora_");
        }
    }

    #[test]
    fn topic_is_stored_per_channel() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::TopicChanged {
                channel: DEFAULT_CHANNEL.into(),
                topic: "Welcome to FAF".into(),
            },
        );
        assert_eq!(s.channel(DEFAULT_CHANNEL).unwrap().topic, "Welcome to FAF");
    }

    #[test]
    fn disconnect_clears_rosters_but_keeps_channels_and_messages() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::UsersUpdated {
                channel: DEFAULT_CHANNEL.into(),
                users: vec![ChatUser::new("Stormlord", "")],
            },
        );
        reduce(
            &mut s,
            &ChatEvent::MessageReceived {
                channel: DEFAULT_CHANNEL.into(),
                message: message("1"),
            },
        );
        reduce(&mut s, &ChatEvent::Disconnected);
        let c = s.channel(DEFAULT_CHANNEL).unwrap();
        assert_eq!(s.status, ChatStatus::Disconnected);
        assert!(c.users.is_empty());
        assert_eq!(c.messages.len(), 1);
    }

    #[test]
    fn joins_parts_preference_round_trips() {
        let mut s = ChatState::default();
        assert!(!s.show_joins_parts);
        reduce(&mut s, &ChatEvent::JoinsPartsToggled { enabled: true });
        assert!(s.show_joins_parts);
    }

    #[test]
    fn server_auto_join_adds_the_prefix_the_lobby_omits() {
        let mut s = ChatState::default();
        reduce(
            &mut s,
            &ChatEvent::AutoJoinAnnounced {
                channels: vec!["aeolus".into(), "german".into(), "#clan_qai".into()],
            },
        );
        assert_eq!(s.server_auto_join, vec!["#aeolus", "#german", "#clan_qai"]);
    }

    #[test]
    fn server_auto_join_replaces_rather_than_accumulates() {
        // Each `social` message carries the complete set, so a later one that
        // drops a channel must not leave it behind.
        let mut s = ChatState::default();
        reduce(
            &mut s,
            &ChatEvent::AutoJoinAnnounced {
                channels: vec!["aeolus".into(), "german".into()],
            },
        );
        reduce(
            &mut s,
            &ChatEvent::AutoJoinAnnounced {
                channels: vec!["aeolus".into()],
            },
        );
        assert_eq!(s.server_auto_join, vec!["#aeolus"]);
    }

    #[test]
    fn server_auto_join_is_deduplicated_and_bounded() {
        let mut s = ChatState::default();
        let mut channels = vec!["aeolus".into(), "#AEOLUS".into(), String::new()];
        channels.extend((0..40).map(|i| format!("#chan{i}")));
        reduce(&mut s, &ChatEvent::AutoJoinAnnounced { channels });
        assert_eq!(s.server_auto_join.len(), MAX_AUTO_JOIN_CHANNELS);
        assert_eq!(s.server_auto_join[0], "#aeolus");
        assert_eq!(s.server_auto_join[1], "#chan0");
    }

    #[test]
    fn the_country_flag_selects_a_language_channel() {
        // The case that started this: a German account with no OS locale, which
        // is every German player on Windows.
        assert_eq!(language_channel("", "de"), Some("#german"));
        assert_eq!(language_channel("", "at"), Some("#german"));
        assert_eq!(language_channel("", "fr"), Some("#french"));
        for country in ["ru", "kz", "kg", "by"] {
            assert_eq!(language_channel("", country), Some("#russian"), "{country}");
        }
    }

    #[test]
    fn the_os_language_wins_over_the_country() {
        // Mirrors Python's `from_os or from_ip`: a German living in France
        // reads German.
        assert_eq!(language_channel("de_DE.UTF-8", "fr"), Some("#german"));
        assert_eq!(language_channel("fr-FR", "de"), Some("#french"));
    }

    #[test]
    fn an_unmapped_language_or_country_joins_nothing() {
        // FAF has three language channels. Everyone else stays in #aeolus
        // rather than being sent somewhere that does not exist.
        assert_eq!(language_channel("en_GB.UTF-8", "gb"), None);
        assert_eq!(language_channel("", ""), None);
        assert_eq!(language_channel("C", "jp"), None);
        // Australia is not Austria: the Python table's `au` entry would put
        // these players in #german.
        assert_eq!(language_channel("", "au"), None);
    }

    #[test]
    fn mentions_requires_a_word_boundary() {
        assert!(mentions("Aurora: gg", "Aurora"));
        assert!(mentions("nice one aurora", "Aurora"));
        assert!(mentions("(aurora)", "Aurora"));
        assert!(!mentions("auroras are pretty", "Aurora"));
        assert!(!mentions("xaurora", "Aurora"));
        assert!(!mentions("anything", ""));
    }

    #[test]
    fn mentions_scans_past_a_non_boundary_hit() {
        // First occurrence is embedded; the second one is a real mention.
        assert!(mentions("xaurora and later aurora", "Aurora"));
    }

    // ── typing ───────────────────────────────────────────────────────────
    #[test]
    fn a_typing_notice_shows_until_it_ages_out() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#a".into(),
            },
        );
        reduce(&mut s, &typing("#a", "Stormlord", true, 100));

        let c = s.channel("#a").unwrap();
        assert_eq!(c.typists_at(100, "Aurora"), vec!["Stormlord"]);
        // Still inside the window: one missed refresh must not blank it.
        assert_eq!(c.typists_at(105, "Aurora"), vec!["Stormlord"]);
        // Past it: the sender promised a `done` and never sent one.
        assert!(c.typists_at(106, "Aurora").is_empty());
        assert!(c.typists_at(10_000, "Aurora").is_empty());
    }

    #[test]
    fn our_own_typing_is_never_shown_back_to_us() {
        // The server echoes our TAGMSG to the channel, ourselves included.
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#a".into(),
            },
        );
        reduce(&mut s, &typing("#a", "aurora", true, 100));

        assert!(s
            .channel("#a")
            .unwrap()
            .typists_at(100, "Aurora")
            .is_empty());
    }

    #[test]
    fn stopping_removes_the_notice_immediately() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#a".into(),
            },
        );
        reduce(&mut s, &typing("#a", "Stormlord", true, 100));
        reduce(&mut s, &typing("#a", "Stormlord", false, 101));

        assert!(s
            .channel("#a")
            .unwrap()
            .typists_at(101, "Aurora")
            .is_empty());
    }

    #[test]
    fn refreshing_extends_the_same_person_rather_than_duplicating_them() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#a".into(),
            },
        );
        reduce(&mut s, &typing("#a", "Stormlord", true, 100));
        reduce(&mut s, &typing("#a", "Stormlord", true, 104));

        let c = s.channel("#a").unwrap();
        assert_eq!(c.typing.len(), 1);
        assert_eq!(c.typists_at(108, "Aurora"), vec!["Stormlord"]);
    }

    #[test]
    fn sending_a_message_is_the_loudest_possible_done() {
        // Most clients never send `done`; the message itself is the signal.
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#a".into(),
            },
        );
        reduce(&mut s, &typing("#a", "Stormlord", true, 100));
        reduce(
            &mut s,
            &ChatEvent::MessageReceived {
                channel: "#a".into(),
                message: message("m1"),
            },
        );

        assert!(s
            .channel("#a")
            .unwrap()
            .typists_at(100, "Aurora")
            .is_empty());
    }

    #[test]
    fn an_abandoned_notice_is_pruned_by_the_next_event() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#a".into(),
            },
        );
        reduce(&mut s, &typing("#a", "Ghost", true, 100));
        reduce(&mut s, &typing("#a", "Stormlord", true, 200));

        // Ghost never sent `done` and never will; nothing should still carry it.
        let c = s.channel("#a").unwrap();
        assert_eq!(c.typing.len(), 1);
        assert_eq!(c.typing[0].nickname, "Stormlord");
    }

    #[test]
    fn several_people_can_compose_at_once() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#a".into(),
            },
        );
        reduce(&mut s, &typing("#a", "Stormlord", true, 100));
        reduce(&mut s, &typing("#a", "Zock", true, 101));

        assert_eq!(
            s.channel("#a").unwrap().typists_at(102, "Aurora"),
            vec!["Stormlord", "Zock"]
        );
    }

    // ── reactions ────────────────────────────────────────────────────────
    #[test]
    fn a_reaction_lands_on_its_message() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#a".into(),
            },
        );
        reduce(&mut s, &reaction("#a", "srv-m1", "\u{1f44d}", "Stormlord"));

        let c = s.channel("#a").unwrap();
        assert_eq!(c.reactions_for("srv-m1").len(), 1);
        assert_eq!(c.reactions_for("srv-m1")[0].emoji, "\u{1f44d}");
        assert_eq!(c.reactions_for("srv-m1")[0].senders, vec!["Stormlord"]);
    }

    #[test]
    fn the_same_emoji_from_two_people_is_one_entry_with_two_senders() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#a".into(),
            },
        );
        reduce(&mut s, &reaction("#a", "srv-m1", "\u{1f44d}", "Stormlord"));
        reduce(&mut s, &reaction("#a", "srv-m1", "\u{1f44d}", "Zock"));

        let entries = s.channel("#a").unwrap().reactions_for("srv-m1");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].senders, vec!["Stormlord", "Zock"]);
    }

    #[test]
    fn reacting_twice_is_swallowed_rather_than_counted_or_toggled() {
        // The draft spec defines no retraction, so a repeat cannot mean "undo"
        // and must not inflate the count either.
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#a".into(),
            },
        );
        reduce(&mut s, &reaction("#a", "srv-m1", "\u{1f44d}", "Stormlord"));
        reduce(&mut s, &reaction("#a", "srv-m1", "\u{1f44d}", "stormlord"));

        let entries = s.channel("#a").unwrap().reactions_for("srv-m1");
        assert_eq!(entries[0].senders, vec!["Stormlord"]);
    }

    #[test]
    fn different_emoji_on_one_message_are_separate_entries() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#a".into(),
            },
        );
        reduce(&mut s, &reaction("#a", "srv-m1", "\u{1f44d}", "Stormlord"));
        reduce(&mut s, &reaction("#a", "srv-m1", "\u{1f525}", "Zock"));

        let entries = s.channel("#a").unwrap().reactions_for("srv-m1");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].emoji, "\u{1f525}");
    }

    #[test]
    fn a_reaction_without_an_anchor_is_dropped() {
        // A message the server never tagged has no handle to react to; storing
        // it would grow the slice with entries nothing can render.
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#a".into(),
            },
        );
        reduce(&mut s, &reaction("#a", "", "\u{1f44d}", "Stormlord"));

        assert!(s.channel("#a").unwrap().reactions.is_empty());
    }

    fn removed(channel: &str, msgid: &str, emoji: &str, sender: &str) -> ChatEvent {
        ChatEvent::ReactionRemoved {
            channel: channel.into(),
            msgid: msgid.into(),
            emoji: emoji.into(),
            sender: sender.into(),
        }
    }

    #[test]
    fn taking_a_reaction_back_removes_only_that_person() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#a".into(),
            },
        );
        reduce(&mut s, &reaction("#a", "srv-m1", "\u{1f44d}", "Stormlord"));
        reduce(&mut s, &reaction("#a", "srv-m1", "\u{1f44d}", "Zock"));
        reduce(&mut s, &removed("#a", "srv-m1", "\u{1f44d}", "stormlord"));

        let entries = s.channel("#a").unwrap().reactions_for("srv-m1");
        assert_eq!(entries[0].senders, vec!["Zock"]);
    }

    #[test]
    fn an_emoji_nobody_stands_behind_disappears_rather_than_showing_zero() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#a".into(),
            },
        );
        reduce(&mut s, &reaction("#a", "srv-m1", "\u{1f44d}", "Stormlord"));
        reduce(&mut s, &removed("#a", "srv-m1", "\u{1f44d}", "Stormlord"));

        assert!(s.channel("#a").unwrap().reactions_for("srv-m1").is_empty());
        // The message's own entry goes too, not just its contents.
        assert!(s.channel("#a").unwrap().reactions.is_empty());
    }

    #[test]
    fn removing_a_reaction_that_was_never_there_changes_nothing() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#a".into(),
            },
        );
        reduce(&mut s, &reaction("#a", "srv-m1", "\u{1f44d}", "Stormlord"));
        for (msgid, emoji, sender) in [
            ("srv-nope", "\u{1f44d}", "Stormlord"),
            ("srv-m1", "\u{1f525}", "Stormlord"),
            ("srv-m1", "\u{1f44d}", "Nobody"),
        ] {
            reduce(&mut s, &removed("#a", msgid, emoji, sender));
        }

        assert_eq!(
            s.channel("#a").unwrap().reactions_for("srv-m1")[0].senders,
            vec!["Stormlord"]
        );
    }

    #[test]
    fn a_reply_carries_only_the_id_it_answers() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#a".into(),
            },
        );
        let mut answer = message("m2");
        answer.reply_to = "srv-m1".into();
        reduce(
            &mut s,
            &ChatEvent::MessageReceived {
                channel: "#a".into(),
                message: answer,
            },
        );

        let stored = &s.channel("#a").unwrap().messages[0];
        assert_eq!(stored.reply_to, "srv-m1");
        // The quoted text is never copied: the original is already in the
        // scrollback, and a copy would drift from it.
        assert_eq!(stored.content, "hello m2");
    }

    #[test]
    fn a_message_with_no_reactions_reports_none() {
        let mut s = connected("Aurora");
        reduce(
            &mut s,
            &ChatEvent::ChannelJoined {
                channel: "#a".into(),
            },
        );
        assert!(s
            .channel("#a")
            .unwrap()
            .reactions_for("srv-nope")
            .is_empty());
    }

    #[test]
    fn auto_join_channels_joins_newbie_when_game_count_under_threshold() {
        use crate::state::{
            AppState, AuthState, ChatPreferences, Player, PlayerLobbyRating, PlayerProfile,
            SocialState,
        };

        let mut state = AppState {
            auth: AuthState {
                player: Some(Player::new(100, "NewbiePlayer")),
                ..Default::default()
            },
            social: SocialState {
                players: vec![PlayerProfile {
                    id: 100,
                    login: "NewbiePlayer".into(),
                    ratings: vec![
                        PlayerLobbyRating {
                            leaderboard: "global".into(),
                            games_played: 10,
                            ..Default::default()
                        },
                        PlayerLobbyRating {
                            leaderboard: "ladder_1v1".into(),
                            games_played: 5,
                            ..Default::default()
                        },
                    ],
                    ..Default::default()
                }],
                ..Default::default()
            },
            settings: crate::state::SettingsState {
                chat: ChatPreferences {
                    auto_join_newbie_channel: true,
                    newbie_channel_game_threshold: 50,
                    ..Default::default()
                },
                ..Default::default()
            },
            ..Default::default()
        };

        let channels = auto_join_channels(&state, "en");
        assert!(
            channels.contains(&"#newbie".to_string()),
            "account with 15 games should join #newbie"
        );

        // Boundary: 49 games joins
        state.social.players[0].ratings[0].games_played = 44;
        state.social.players[0].ratings[1].games_played = 5;
        let channels = auto_join_channels(&state, "en");
        assert!(
            channels.contains(&"#newbie".to_string()),
            "account with 49 games should join #newbie"
        );

        // Boundary: 50 games does not join
        state.social.players[0].ratings[0].games_played = 45;
        state.social.players[0].ratings[1].games_played = 5;
        let channels = auto_join_channels(&state, "en");
        assert!(
            !channels.contains(&"#newbie".to_string()),
            "account with 50 games should not join #newbie"
        );

        // Veteran: 100 games does not join
        state.social.players[0].ratings[0].games_played = 100;
        let channels = auto_join_channels(&state, "en");
        assert!(
            !channels.contains(&"#newbie".to_string()),
            "account with 100+ games should not join #newbie"
        );

        // Setting disabled: low game count does not join
        state.social.players[0].ratings[0].games_played = 2;
        state.social.players[0].ratings[1].games_played = 0;
        state.settings.chat.auto_join_newbie_channel = false;
        let channels = auto_join_channels(&state, "en");
        assert!(
            !channels.contains(&"#newbie".to_string()),
            "should not join #newbie when setting is disabled"
        );
    }

    #[test]
    fn auto_join_channels_does_not_join_newbie_when_account_unknown() {
        use crate::state::{AppState, AuthState, Player};

        let state = AppState {
            auth: AuthState {
                player: Some(Player::new(101, "UnknownVeteran")),
                ..Default::default()
            },
            ..Default::default()
        };

        let channels = auto_join_channels(&state, "en");
        assert!(
            !channels.contains(&"#newbie".to_string()),
            "should not join #newbie when game count is unknown"
        );
    }
}
