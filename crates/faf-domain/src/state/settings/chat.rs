//! Chat: how conversations are drawn, which channels are joined, who is
//! muted, and the colours names are printed in.

use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatNameColors {
    /// Empty strings mean that the category uses the ordinary text colour.
    pub self_color: String,
    pub friends: String,
    pub foes: String,
    pub moderators: String,
    pub admins: String,
    /// The colour a name mentioned inside a message is printed in.
    ///
    /// This is the sender's confirmation that a ping landed: naming somebody
    /// pings them, and until now nothing on the sender's own screen said
    /// whether the word they typed had resolved to a real player or was a
    /// misspelling that reached nobody. Configurable rather than fixed
    /// because every other name colour here is, and the default is the one
    /// agreed on the thread.
    pub pings: String,
    /// Player login to a user-selected `#rrggbb` colour.
    pub players: BTreeMap<String, String>,
}

impl Default for ChatNameColors {
    fn default() -> Self {
        Self {
            self_color: "#ffdd00".into(),
            friends: "#87cefa".into(),
            foes: "#dc143c".into(),
            moderators: "#32cd32".into(),
            admins: "#ba55d3".into(),
            pings: "#ff8c00".into(),
            players: BTreeMap::new(),
        }
    }
}

impl<'de> Deserialize<'de> for ChatNameColors {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            self_color: String,
            friends: String,
            foes: String,
            moderators: String,
            admins: String,
            pings: String,
            players: BTreeMap<String, String>,
        }

        impl Default for Wire {
            fn default() -> Self {
                let defaults = ChatNameColors::default();
                Self {
                    self_color: defaults.self_color,
                    friends: defaults.friends,
                    foes: defaults.foes,
                    moderators: defaults.moderators,
                    admins: defaults.admins,
                    pings: defaults.pings,
                    players: defaults.players,
                }
            }
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            self_color: wire.self_color,
            friends: wire.friends,
            foes: wire.foes,
            moderators: wire.moderators,
            admins: wire.admins,
            pings: wire.pings,
            players: wire.players,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatPreferences {
    pub show_joins_parts: bool,
    pub show_timestamps: bool,
    pub use_24_hour_time: bool,
    pub colored_names: bool,
    /// Width of the public-channel roster in logical CSS pixels.
    pub roster_width: u16,
    /// Message text font size in logical pixels (11 to 24, default 13).
    pub font_size: u16,
    /// Width of the sender column in chat in logical pixels (60 to 300, default 116).
    pub sender_width: u16,
    pub name_colors: ChatNameColors,
    pub hide_foe_messages: bool,
    /// Number of recent messages rendered per conversation. The domain retains
    /// at most 500, so this is bounded to the same maximum.
    pub visible_message_limit: u16,
    /// Additional IRC channels joined after the connection becomes ready.
    pub auto_join_channels: Vec<String>,
    /// Join FAF's channel for this player's language (`#german`, `#french`,
    /// `#russian`) when one applies. Derived from the OS language, falling back
    /// to the account's country flag; see `chat::language_channel`. On by
    /// default, as in the Python client, and off is a real choice: plenty of
    /// non-English speakers prefer `#aeolus`.
    pub auto_join_language_channel: bool,
    /// Automatically join `#newbie` for accounts with fewer than
    /// `newbie_channel_game_threshold` completed games.
    pub auto_join_newbie_channel: bool,
    /// Maximum total game count below which `#newbie` is automatically joined.
    pub newbie_channel_game_threshold: u32,
    /// Locally ignored IRC nicknames. Muting is deliberately independent of
    /// the server-backed friend/foe relation lists.
    pub muted_players: Vec<String>,
    /// Last message timestamp read per account and channel. The marker keeps
    /// IRC history backfill from restoring an unread badge after a restart.
    /// Keys are produced by [`super::chat::read_marker_key`].
    pub read_markers: BTreeMap<String, String>,
    /// Roster categories the user has collapsed (`players`, `ircOnly`, …).
    ///
    /// The Java client stores this per channel
    /// (`ChatPrefs.channelNameToHiddenCategories`). One global set is used here
    /// instead: the categories people actually collapse are the noisy ones
    /// (`#aeolus` alone lists 600+ under Players), and that judgement does not
    /// change from channel to channel. Per-channel remains possible later
    /// without moving this field, by widening the value to a map.
    pub hidden_roster_categories: Vec<String>,
}

impl Default for ChatPreferences {
    fn default() -> Self {
        Self {
            show_joins_parts: false,
            show_timestamps: true,
            use_24_hour_time: true,
            colored_names: false,
            roster_width: 280,
            font_size: 13,
            sender_width: 116,
            name_colors: ChatNameColors::default(),
            hide_foe_messages: true,
            visible_message_limit: 500,
            auto_join_channels: Vec::new(),
            auto_join_language_channel: true,
            auto_join_newbie_channel: true,
            newbie_channel_game_threshold: 50,
            muted_players: Vec::new(),
            read_markers: BTreeMap::new(),
            hidden_roster_categories: Vec::new(),
        }
    }
}

// Existing installations already have a complete `chat` object on disk. A
// custom reader lets those files gain newly added chat fields without making
// the exported IPC type optional or discarding the user's older preferences.
impl<'de> Deserialize<'de> for ChatPreferences {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            show_joins_parts: bool,
            show_timestamps: bool,
            use_24_hour_time: bool,
            colored_names: bool,
            roster_width: u16,
            font_size: u16,
            sender_width: u16,
            name_colors: ChatNameColors,
            hide_foe_messages: bool,
            visible_message_limit: u16,
            auto_join_channels: Vec<String>,
            auto_join_language_channel: bool,
            auto_join_newbie_channel: bool,
            newbie_channel_game_threshold: u32,
            muted_players: Vec<String>,
            read_markers: BTreeMap<String, String>,
            hidden_roster_categories: Vec<String>,
        }

        impl Default for Wire {
            fn default() -> Self {
                let defaults = ChatPreferences::default();
                Self {
                    show_joins_parts: defaults.show_joins_parts,
                    show_timestamps: defaults.show_timestamps,
                    use_24_hour_time: defaults.use_24_hour_time,
                    colored_names: defaults.colored_names,
                    roster_width: defaults.roster_width,
                    font_size: defaults.font_size,
                    sender_width: defaults.sender_width,
                    name_colors: defaults.name_colors,
                    hide_foe_messages: defaults.hide_foe_messages,
                    visible_message_limit: defaults.visible_message_limit,
                    auto_join_channels: defaults.auto_join_channels,
                    auto_join_language_channel: defaults.auto_join_language_channel,
                    auto_join_newbie_channel: defaults.auto_join_newbie_channel,
                    newbie_channel_game_threshold: defaults.newbie_channel_game_threshold,
                    muted_players: defaults.muted_players,
                    read_markers: defaults.read_markers,
                    hidden_roster_categories: defaults.hidden_roster_categories,
                }
            }
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            show_joins_parts: wire.show_joins_parts,
            show_timestamps: wire.show_timestamps,
            use_24_hour_time: wire.use_24_hour_time,
            colored_names: wire.colored_names,
            roster_width: wire.roster_width,
            font_size: wire.font_size,
            sender_width: wire.sender_width,
            name_colors: wire.name_colors,
            hide_foe_messages: wire.hide_foe_messages,
            visible_message_limit: wire.visible_message_limit,
            auto_join_channels: wire.auto_join_channels,
            auto_join_language_channel: wire.auto_join_language_channel,
            auto_join_newbie_channel: wire.auto_join_newbie_channel,
            newbie_channel_game_threshold: wire.newbie_channel_game_threshold,
            muted_players: wire.muted_players,
            read_markers: wire.read_markers,
            hidden_roster_categories: wire.hidden_roster_categories,
        })
    }
}

impl ChatPreferences {
    pub(super) fn normalized(mut self) -> Self {
        self.roster_width = self.roster_width.clamp(200, 600);
        self.font_size = self.font_size.clamp(11, 24);
        self.sender_width = self.sender_width.clamp(60, 300);
        self.name_colors.self_color = normalize_color(self.name_colors.self_color);
        self.name_colors.friends = normalize_color(self.name_colors.friends);
        self.name_colors.foes = normalize_color(self.name_colors.foes);
        self.name_colors.moderators = normalize_color(self.name_colors.moderators);
        self.name_colors.admins = normalize_color(self.name_colors.admins);
        self.name_colors.players = normalize_player_colors(self.name_colors.players);
        self.visible_message_limit = self.visible_message_limit.clamp(50, 500);
        self.auto_join_channels = normalize_channels(self.auto_join_channels);
        self.muted_players = normalize_logins(self.muted_players, 500);
        let mut read_markers: Vec<_> = self
            .read_markers
            .into_iter()
            .filter(|(key, timestamp)| !key.trim().is_empty() && !timestamp.trim().is_empty())
            .collect();
        // BTreeMap iteration is alphabetical by marker key, not chronological.
        // Sort by the RFC 3339 instant before applying the bound so an old
        // alphabetically early channel cannot evict a recent later one.
        read_markers.sort_by(|left, right| {
            marker_timestamp(&right.1)
                .cmp(&marker_timestamp(&left.1))
                .then_with(|| right.1.cmp(&left.1))
                .then_with(|| left.0.cmp(&right.0))
        });
        read_markers.truncate(MAX_READ_MARKERS);
        self.read_markers = read_markers.into_iter().collect();
        self
    }
}

const MAX_READ_MARKERS: usize = 500;

fn marker_timestamp(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .and_then(|timestamp| timestamp.timestamp_nanos_opt())
}

preference_patch! {
    /// A change to some of the colours in [`ChatNameColors`].
    ChatNameColorsPatch for ChatNameColors {
        self_color: String,
        friends: String,
        foes: String,
        moderators: String,
        admins: String,
        pings: String,
        players: BTreeMap<String, String>,
    }
}

preference_patch! {
    /// A change to [`ChatPreferences`].
    ChatPreferencesPatch for ChatPreferences {
        show_joins_parts: bool,
        show_timestamps: bool,
        use_24_hour_time: bool,
        colored_names: bool,
        roster_width: u16,
        font_size: u16,
        sender_width: u16,
        hide_foe_messages: bool,
        visible_message_limit: u16,
        auto_join_channels: Vec<String>,
        auto_join_language_channel: bool,
        auto_join_newbie_channel: bool,
        newbie_channel_game_threshold: u32,
        muted_players: Vec<String>,
        read_markers: BTreeMap<String, String>,
        hidden_roster_categories: Vec<String>,
    }
    nested {
        name_colors: ChatNameColorsPatch,
    }
}

fn normalize_color(color: String) -> String {
    let color = color.trim();
    if color.len() == 7
        && color.starts_with('#')
        && color[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        color.to_ascii_lowercase()
    } else {
        String::new()
    }
}

fn normalize_player_colors(colors: BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut normalized = BTreeMap::new();
    for (player, color) in colors {
        let player = player.trim();
        let color = normalize_color(color);
        if player.is_empty() || color.is_empty() || player.len() > 64 {
            continue;
        }
        if let Some(existing) = normalized
            .keys()
            .find(|existing: &&String| existing.eq_ignore_ascii_case(player))
            .cloned()
        {
            normalized.remove(&existing);
        }
        normalized.insert(player.to_owned(), color);
        if normalized.len() == 200 {
            break;
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_keeps_the_newest_read_markers_not_alphabetical_keys() {
        let read_markers = (0..=MAX_READ_MARKERS)
            .map(|index| {
                (
                    format!("account\u{1f}#{index:03}"),
                    chrono::DateTime::from_timestamp(index as i64, 0)
                        .expect("test timestamp is in range")
                        .to_rfc3339(),
                )
            })
            .collect();
        let settings = SettingsState {
            chat: ChatPreferences {
                read_markers,
                ..ChatPreferences::default()
            },
            ..SettingsState::default()
        }
        .normalized();

        assert_eq!(settings.chat.read_markers.len(), MAX_READ_MARKERS);
        assert!(!settings.chat.read_markers.contains_key("account\u{1f}#000"));
        assert!(settings.chat.read_markers.contains_key("account\u{1f}#500"));
    }

    #[test]
    fn existing_chat_preferences_gain_color_and_roster_defaults() {
        let settings: SettingsState = serde_json::from_str(
            r##"{
                "chat": {
                    "showJoinsParts": true,
                    "showTimestamps": false,
                    "use24HourTime": false,
                    "coloredNames": true,
                    "hideFoeMessages": false,
                    "visibleMessageLimit": 250,
                    "autoJoinChannels": ["#modding"]
                }
            }"##,
        )
        .unwrap();

        assert!(settings.chat.show_joins_parts);
        assert!(settings.chat.colored_names);
        assert_eq!(settings.chat.roster_width, 280);
        assert_eq!(settings.chat.name_colors, ChatNameColors::default());
        assert!(settings.chat.read_markers.is_empty());
    }

    #[test]
    fn normalization_rejects_invalid_colors_and_bounds_custom_players() {
        let mut players = BTreeMap::new();
        players.insert("  FriendOne  ".into(), " #AABBCC ".into());
        players.insert("Broken".into(), "red".into());
        let settings = SettingsState {
            chat: ChatPreferences {
                roster_width: 900,
                name_colors: ChatNameColors {
                    friends: "#12ABef".into(),
                    foes: "invalid".into(),
                    players,
                    ..ChatNameColors::default()
                },
                ..ChatPreferences::default()
            },
            ..SettingsState::default()
        }
        .normalized();

        assert_eq!(settings.chat.roster_width, 600);
        assert_eq!(settings.chat.name_colors.friends, "#12abef");
        assert!(settings.chat.name_colors.foes.is_empty());
        assert_eq!(
            settings.chat.name_colors.players.get("FriendOne"),
            Some(&"#aabbcc".to_owned())
        );
        assert!(!settings.chat.name_colors.players.contains_key("Broken"));
    }
}
