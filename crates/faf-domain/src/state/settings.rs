//! Settings slice: persisted user preferences.
//!
//! Preferences live in the backend-owned [`crate::state::AppState`] and are
//! projected by the UI. Grouping them by feature keeps the IPC contract stable
//! as the settings page grows and lets each UI section replace one coherent
//! value rather than dispatching a stringly-typed key/value pair.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

use crate::protocol::map_generator::GeneratorOptions;

use super::chat::normalize_channels;
use super::mods::ModPreset;
use super::Tab;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    #[default]
    ForgeDark,
    ForgeLight,
    JavaClient,
    PythonClient,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UiDensity {
    Compact,
    #[default]
    Comfortable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneralPreferences {
    /// Destination selected when the persisted settings are loaded.
    pub start_page: Tab,
}

pub const PLAYER_NOTE_CHARACTER_LIMIT: usize = 150;
const PLAYER_NOTE_LIMIT: usize = 1_000;

/// A private, local annotation attached to one FAF account.
///
/// Player ids are stable across renames, while `login` makes the persisted JSON
/// understandable and gives a future notes-management screen something useful
/// to show without an API lookup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerNote {
    pub player_id: i32,
    pub login: String,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SocialPreferences {
    pub player_notes: Vec<PlayerNote>,
}

impl SocialPreferences {
    pub fn note_for(&self, player_id: i32) -> Option<&PlayerNote> {
        self.player_notes
            .iter()
            .find(|entry| entry.player_id == player_id)
    }

    /// Set or clear one note, applying the same bounds on every write path.
    pub fn set_player_note(&mut self, player_id: i32, login: String, note: String) {
        if player_id <= 0 {
            return;
        }

        let login = login.trim();
        if login.is_empty() || login.chars().count() > 64 {
            return;
        }

        self.player_notes
            .retain(|entry| entry.player_id != player_id);
        let note: String = note
            .trim()
            .chars()
            .take(PLAYER_NOTE_CHARACTER_LIMIT)
            .collect();
        if !note.is_empty() {
            self.player_notes.push(PlayerNote {
                player_id,
                login: login.to_owned(),
                note,
            });
        }
        *self = std::mem::take(self).normalized();
    }

    fn normalized(mut self) -> Self {
        let mut notes = BTreeMap::new();
        for entry in self.player_notes {
            if entry.player_id <= 0 {
                continue;
            }
            let login = entry.login.trim();
            let note: String = entry
                .note
                .trim()
                .chars()
                .take(PLAYER_NOTE_CHARACTER_LIMIT)
                .collect();
            if login.is_empty() || login.chars().count() > 64 || note.is_empty() {
                continue;
            }
            notes.insert(
                entry.player_id,
                PlayerNote {
                    player_id: entry.player_id,
                    login: login.to_owned(),
                    note,
                },
            );
        }
        self.player_notes = notes.into_values().take(PLAYER_NOTE_LIMIT).collect();
        self
    }
}

impl Default for GeneralPreferences {
    fn default() -> Self {
        Self {
            start_page: Tab::News,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppearancePreferences {
    pub density: UiDensity,
    pub reduce_motion: bool,
    /// Whole-interface zoom, as a percentage. Applied by the shell as a real
    /// webview zoom rather than a CSS transform, so layout, hit testing and
    /// `window.innerWidth` all stay in one coordinate space.
    ///
    /// This client's dimensions are in CSS pixels throughout, so on a large
    /// high-resolution display running at 100% desktop scaling every control is
    /// physically tiny. Neither reference client offers this (the Java client
    /// zooms only its chat), but neither is a fixed-pixel web UI.
    ///
    /// Settings files written before this existed still load: see the `Wire`
    /// reader below, which is how every other preference block in this module
    /// gains a field without making the generated IPC type optional.
    pub ui_scale: u16,
}

// A field-level `#[serde(default)]` would have been shorter, but specta turns
// it into an *optional* TS property, and the field is never actually absent in
// a serialized snapshot. That would push a `?? 100` onto every use site to
// satisfy a case that cannot happen.
impl<'de> Deserialize<'de> for AppearancePreferences {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            density: UiDensity,
            reduce_motion: bool,
            ui_scale: u16,
        }

        impl Default for Wire {
            fn default() -> Self {
                let defaults = AppearancePreferences::default();
                Self {
                    density: defaults.density,
                    reduce_motion: defaults.reduce_motion,
                    ui_scale: defaults.ui_scale,
                }
            }
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            density: wire.density,
            reduce_motion: wire.reduce_motion,
            ui_scale: wire.ui_scale,
        })
    }
}

/// 100% means "one CSS pixel per desktop pixel", matching the desktop's own
/// scaling rather than second-guessing it.
fn default_ui_scale() -> u16 {
    100
}

/// Bounds for [`AppearancePreferences::ui_scale`]. Below the minimum text stops
/// being legible; above the maximum the narrowest supported layout no longer
/// fits, and the sidebar starts colliding with content.
pub const MIN_UI_SCALE: u16 = 80;
pub const MAX_UI_SCALE: u16 = 200;

impl Default for AppearancePreferences {
    fn default() -> Self {
        Self {
            density: UiDensity::Comfortable,
            reduce_motion: false,
            ui_scale: default_ui_scale(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPreferences {
    pub enabled: bool,
    pub desktop: bool,
    pub sound: bool,
    pub notify_when_focused: bool,
    pub match_found: bool,
    pub private_messages: bool,
    pub mentions: bool,
    pub friend_online: bool,
    pub friend_offline: bool,
    pub friend_playing: bool,
    pub new_custom_games: bool,
    pub new_custom_games_friends_only: bool,
    pub game_full: bool,
    pub game_launched: bool,
    pub review_reminder: bool,
    pub party_invites: bool,
    /// Sound volume from 0 to 100.
    pub volume: u8,
}

impl Default for NotificationPreferences {
    fn default() -> Self {
        Self {
            enabled: true,
            desktop: true,
            sound: true,
            notify_when_focused: false,
            match_found: true,
            private_messages: true,
            mentions: true,
            friend_online: true,
            friend_offline: true,
            friend_playing: true,
            new_custom_games: false,
            new_custom_games_friends_only: true,
            game_full: true,
            game_launched: true,
            review_reminder: true,
            party_invites: true,
            volume: 70,
        }
    }
}

// Notification preferences are persisted as one complete object. Keep new
// event switches backwards-compatible without making the generated IPC type
// optional: older files gain only the newly introduced defaults.
impl<'de> Deserialize<'de> for NotificationPreferences {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            enabled: bool,
            desktop: bool,
            sound: bool,
            notify_when_focused: bool,
            match_found: bool,
            private_messages: bool,
            mentions: bool,
            friend_online: bool,
            friend_offline: bool,
            friend_playing: bool,
            new_custom_games: bool,
            new_custom_games_friends_only: bool,
            game_full: bool,
            game_launched: bool,
            review_reminder: bool,
            party_invites: bool,
            volume: u8,
        }

        impl Default for Wire {
            fn default() -> Self {
                let defaults = NotificationPreferences::default();
                Self {
                    enabled: defaults.enabled,
                    desktop: defaults.desktop,
                    sound: defaults.sound,
                    notify_when_focused: defaults.notify_when_focused,
                    match_found: defaults.match_found,
                    private_messages: defaults.private_messages,
                    mentions: defaults.mentions,
                    friend_online: defaults.friend_online,
                    friend_offline: defaults.friend_offline,
                    friend_playing: defaults.friend_playing,
                    new_custom_games: defaults.new_custom_games,
                    new_custom_games_friends_only: defaults.new_custom_games_friends_only,
                    game_full: defaults.game_full,
                    game_launched: defaults.game_launched,
                    review_reminder: defaults.review_reminder,
                    party_invites: defaults.party_invites,
                    volume: defaults.volume,
                }
            }
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            enabled: wire.enabled,
            desktop: wire.desktop,
            sound: wire.sound,
            notify_when_focused: wire.notify_when_focused,
            match_found: wire.match_found,
            private_messages: wire.private_messages,
            mentions: wire.mentions,
            friend_online: wire.friend_online,
            friend_offline: wire.friend_offline,
            friend_playing: wire.friend_playing,
            new_custom_games: wire.new_custom_games,
            new_custom_games_friends_only: wire.new_custom_games_friends_only,
            game_full: wire.game_full,
            game_launched: wire.game_launched,
            review_reminder: wire.review_reminder,
            party_invites: wire.party_invites,
            volume: wire.volume,
        })
    }
}

impl NotificationPreferences {
    fn normalized(mut self) -> Self {
        self.volume = self.volume.min(100);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatNameColors {
    /// Empty strings mean that the category uses the ordinary text colour.
    pub self_color: String,
    pub friends: String,
    pub foes: String,
    pub moderators: String,
    pub admins: String,
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
            name_colors: ChatNameColors::default(),
            hide_foe_messages: true,
            visible_message_limit: 500,
            auto_join_channels: Vec::new(),
            auto_join_language_channel: true,
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
            name_colors: ChatNameColors,
            hide_foe_messages: bool,
            visible_message_limit: u16,
            auto_join_channels: Vec<String>,
            auto_join_language_channel: bool,
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
                    name_colors: defaults.name_colors,
                    hide_foe_messages: defaults.hide_foe_messages,
                    visible_message_limit: defaults.visible_message_limit,
                    auto_join_channels: defaults.auto_join_channels,
                    auto_join_language_channel: defaults.auto_join_language_channel,
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
            name_colors: wire.name_colors,
            hide_foe_messages: wire.hide_foe_messages,
            visible_message_limit: wire.visible_message_limit,
            auto_join_channels: wire.auto_join_channels,
            auto_join_language_channel: wire.auto_join_language_channel,
            muted_players: wire.muted_players,
            read_markers: wire.read_markers,
            hidden_roster_categories: wire.hidden_roster_categories,
        })
    }
}

impl ChatPreferences {
    fn normalized(mut self) -> Self {
        self.roster_width = self.roster_width.clamp(200, 600);
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

/// Which connectivity backend starts games.
///
/// The long-standing Java `faf-ice-adapter` is the production default used by
/// the established clients. The newer Go faf-pioneer remains available for
/// explicit testing while it is experimental.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum IceAdapter {
    /// `faf-ice-adapter`, driven over JSON-RPC.
    #[default]
    Java,
    /// Experimental faf-pioneer backend. Owns a local GPGNet relay the Java
    /// adapter has no equivalent of.
    Go,
}

impl IceAdapter {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Java => "Java (faf-ice-adapter)",
            Self::Go => "Go (faf-pioneer)",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectivityPreferences {
    pub adapter: IceAdapter,
    /// Version of the explicit adapter choice. Version zero was written by
    /// builds where Pioneer was the implicit/default path, so a stored `go`
    /// value from that era is not evidence that the user opted into an
    /// experimental backend.
    pub selection_version: u8,
}

const CONNECTIVITY_SELECTION_VERSION: u8 = 1;

impl Default for ConnectivityPreferences {
    fn default() -> Self {
        Self {
            adapter: IceAdapter::Java,
            selection_version: CONNECTIVITY_SELECTION_VERSION,
        }
    }
}

impl<'de> Deserialize<'de> for ConnectivityPreferences {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Default, Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            adapter: IceAdapter,
            selection_version: u8,
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            adapter: if wire.selection_version < CONNECTIVITY_SELECTION_VERSION
                && wire.adapter == IceAdapter::Go
            {
                IceAdapter::Java
            } else {
                wire.adapter
            },
            selection_version: CONNECTIVITY_SELECTION_VERSION,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GamePreferences {
    /// Additional literal arguments prepended to both live-game and replay
    /// launches. Each entry is one process argument; no shell is involved.
    #[serde(default)]
    pub additional_arguments: Vec<String>,
    /// Automatically generate missing Neroxis maps when joining a lobby.
    #[serde(default = "default_true")]
    pub auto_generate_maps: bool,
}

fn default_true() -> bool {
    true
}

impl Default for GamePreferences {
    fn default() -> Self {
        Self {
            additional_arguments: Vec::new(),
            auto_generate_maps: true,
        }
    }
}

impl GamePreferences {
    fn normalized(mut self) -> Self {
        self.additional_arguments = self
            .additional_arguments
            .into_iter()
            .map(|argument| argument.trim().to_owned())
            .filter(|argument| !argument.is_empty())
            .take(32)
            .collect();
        self
    }
}

/// Discord Rich Presence: what the client tells Discord you are doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscordPreferences {
    /// Publish presence at all.
    ///
    /// The Java client has no such switch: its only off-switch is shipping
    /// without a configured application id, which no user can do. Presence
    /// broadcasts your game title and lobby to a third party, so it gets a
    /// real toggle here: defaulted on, matching Java's effective behaviour.
    pub enabled: bool,
    /// Withhold the join secret, so nobody can jump into your lobby from your
    /// Discord status. Java's `disallowJoinsViaDiscord`, and it gates both
    /// ends there too: the secret is never published, and an inbound join is
    /// refused even if someone still holds one.
    pub disallow_joins: bool,
}

impl Default for DiscordPreferences {
    fn default() -> Self {
        Self {
            enabled: true,
            disallow_joins: false,
        }
    }
}

// Same reason as `ChatPreferences`: an existing settings file has a complete
// `discord` object once written, and must gain later fields at their defaults
// rather than at `false`.
impl<'de> Deserialize<'de> for DiscordPreferences {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            enabled: bool,
            disallow_joins: bool,
        }

        impl Default for Wire {
            fn default() -> Self {
                let defaults = DiscordPreferences::default();
                Self {
                    enabled: defaults.enabled,
                    disallow_joins: defaults.disallow_joins,
                }
            }
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            enabled: wire.enabled,
            disallow_joins: wire.disallow_joins,
        })
    }
}

/// Client self-update: whether to look for a newer build, and which ones count.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePreferences {
    /// Check for a newer release at startup.
    ///
    /// Defaulted on, matching the Java client, which checks unconditionally.
    /// The switch exists because the check is an outbound request to GitHub
    /// that some users would rather not make on every launch.
    pub automatic: bool,
    /// Also offer prereleases. Java's `preReleaseCheckEnabled`, where it picks
    /// between two entirely separate check tasks.
    pub pre_release: bool,
}

impl Default for UpdatePreferences {
    fn default() -> Self {
        Self {
            automatic: true,
            pre_release: false,
        }
    }
}

impl UpdatePreferences {
    pub fn channel(&self) -> super::ReleaseChannel {
        if self.pre_release {
            super::ReleaseChannel::PreRelease
        } else {
            super::ReleaseChannel::Stable
        }
    }
}

// Same reason as `ChatPreferences` and `DiscordPreferences`: a settings file
// written before a field existed must gain it at its default, not at `false`,
// which here would silently switch update checks off for every existing user.
impl<'de> Deserialize<'de> for UpdatePreferences {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            automatic: bool,
            pre_release: bool,
        }

        impl Default for Wire {
            fn default() -> Self {
                let defaults = UpdatePreferences::default();
                Self {
                    automatic: defaults.automatic,
                    pre_release: defaults.pre_release,
                }
            }
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            automatic: wire.automatic,
            pre_release: wire.pre_release,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CustomGameView {
    #[default]
    Tiles,
    List,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CustomGameSort {
    #[default]
    Players,
    Rating,
    Map,
    Host,
    Age,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CustomGameFilterField {
    Title,
    Host,
    Map,
    Mod,
    Rating,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CustomGameFilterConstraint {
    Contains,
    Starts,
    Ends,
    Equals,
    NotEquals,
    Above,
    Below,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CustomGameFilterRule {
    pub field: CustomGameFilterField,
    pub constraint: CustomGameFilterConstraint,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CustomGameBrowserPreferences {
    pub sort: CustomGameSort,
    pub hide_private: bool,
    pub hide_modded: bool,
    pub apply_filters: bool,
    pub rules: Vec<CustomGameFilterRule>,
}

impl<'de> Deserialize<'de> for CustomGameBrowserPreferences {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Default, Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            sort: CustomGameSort,
            hide_private: bool,
            hide_modded: bool,
            apply_filters: bool,
            rules: Vec<CustomGameFilterRule>,
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            sort: wire.sort,
            hide_private: wire.hide_private,
            hide_modded: wire.hide_modded,
            apply_filters: wire.apply_filters,
            rules: wire.rules,
        })
    }
}

impl CustomGameBrowserPreferences {
    fn normalized(mut self) -> Self {
        let mut rules = Vec::new();
        for mut rule in self.rules {
            rule.value = truncate_trimmed(rule.value, 128);
            if rule.value.is_empty()
                || rules.iter().any(|existing: &CustomGameFilterRule| {
                    existing.field == rule.field
                        && existing.constraint == rule.constraint
                        && existing.value.eq_ignore_ascii_case(&rule.value)
                })
            {
                continue;
            }
            rules.push(rule);
            if rules.len() == 64 {
                break;
            }
        }
        self.rules = rules;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LiveReplayFilters {
    pub search: String,
    pub game_type: String,
    pub featured_mod: String,
    pub active_players: String,
    pub max_players: String,
    pub hide_modded: bool,
    pub hide_single_player: bool,
    pub friends_only: bool,
}

/// Last successfully submitted custom-game form. Both reference clients retain
/// these values so reopening Host is a continuation rather than a reset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HostGamePreferences {
    pub title: String,
    pub featured_mod: String,
    pub visibility: String,
    pub map: String,
    pub password_enabled: bool,
    pub password: String,
    pub enforce_rating_range: bool,
    pub rating_min: i32,
    pub rating_max: i32,
}

impl<'de> Deserialize<'de> for HostGamePreferences {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            title: String,
            featured_mod: String,
            visibility: String,
            map: String,
            password_enabled: bool,
            password: String,
            enforce_rating_range: bool,
            rating_min: i32,
            rating_max: i32,
        }

        impl Default for Wire {
            fn default() -> Self {
                let defaults = HostGamePreferences::default();
                Self {
                    title: defaults.title,
                    featured_mod: defaults.featured_mod,
                    visibility: defaults.visibility,
                    map: defaults.map,
                    password_enabled: defaults.password_enabled,
                    password: defaults.password,
                    enforce_rating_range: defaults.enforce_rating_range,
                    rating_min: defaults.rating_min,
                    rating_max: defaults.rating_max,
                }
            }
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            title: wire.title,
            featured_mod: wire.featured_mod,
            visibility: wire.visibility,
            map: wire.map,
            password_enabled: wire.password_enabled,
            password: wire.password,
            enforce_rating_range: wire.enforce_rating_range,
            rating_min: wire.rating_min,
            rating_max: wire.rating_max,
        })
    }
}

impl Default for HostGamePreferences {
    fn default() -> Self {
        Self {
            title: String::new(),
            featured_mod: "faf".into(),
            visibility: "public".into(),
            map: String::new(),
            password_enabled: false,
            password: String::new(),
            enforce_rating_range: false,
            rating_min: 800,
            rating_max: 1_500,
        }
    }
}

impl HostGamePreferences {
    fn normalized(mut self) -> Self {
        self.title = truncate_trimmed(self.title, 128);
        self.featured_mod = truncate_trimmed(self.featured_mod, 128);
        if self.featured_mod.is_empty() {
            self.featured_mod = "faf".into();
        }
        self.visibility = match self.visibility.trim().to_ascii_lowercase().as_str() {
            "friends" => "friends".into(),
            _ => "public".into(),
        };
        self.map = truncate_trimmed(self.map, 256);
        self.password = self.password.chars().take(25).collect();
        self.rating_min = self.rating_min.clamp(-9_999, 9_999);
        self.rating_max = self.rating_max.clamp(-9_999, 9_999);
        if self.rating_min > self.rating_max {
            std::mem::swap(&mut self.rating_min, &mut self.rating_max);
        }
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowsingPreferences {
    pub custom_games_view: CustomGameView,
    pub replays_view: CustomGameView,
    pub custom_games_browser: CustomGameBrowserPreferences,
    pub matchmaker_unselected_queues: Vec<String>,
    pub matchmaker_factions: Vec<String>,
    pub live_replay_filters: LiveReplayFilters,
    pub host_game: HostGamePreferences,
    /// Stable map folder names starred by the user. Python persists the same
    /// key and uses it in the host picker and generated-map cleanup.
    pub favorite_maps: Vec<String>,
    /// Active preset filter in the map vault ("recommended", "favorites", "rating", "newest", "played", "all").
    pub map_vault_preset: String,
    /// Active preset filter in the mod vault ("recommended", "rating", "ui", "newest", "all").
    pub mod_vault_preset: String,
    /// Named mod sets the host dialog can re-apply in one click.
    ///
    /// Only the word is shared with `mod_vault_preset` above, which is a vault
    /// *filter*. These are the user's own saved selections.
    pub mod_presets: Vec<ModPreset>,
    /// Visible column keys in the rating leaderboard table.
    pub leaderboard_rating_columns: Vec<String>,
    /// Set after the webview has offered its pre-0.2 browser-storage values to
    /// the backend. Kept in the settings file so the compatibility read really
    /// is one-time and the old keys can be removed on a later confirmed load.
    pub legacy_storage_migrated: bool,
}

pub const DEFAULT_LEADERBOARD_RATING_COLUMNS: [&str; 5] =
    ["rating", "games", "wins", "winRate", "updated"];
pub const VALID_LEADERBOARD_RATING_COLUMNS: [&str; 7] = [
    "rating",
    "mean",
    "deviation",
    "games",
    "wins",
    "winRate",
    "updated",
];

impl Default for BrowsingPreferences {
    fn default() -> Self {
        Self {
            custom_games_view: CustomGameView::Tiles,
            replays_view: CustomGameView::Tiles,
            custom_games_browser: CustomGameBrowserPreferences::default(),
            matchmaker_unselected_queues: Vec::new(),
            matchmaker_factions: MATCHMAKER_FACTIONS
                .iter()
                .map(|faction| (*faction).to_owned())
                .collect(),
            live_replay_filters: LiveReplayFilters::default(),
            host_game: HostGamePreferences::default(),
            favorite_maps: Vec::new(),
            map_vault_preset: "recommended".into(),
            mod_vault_preset: "recommended".into(),
            mod_presets: Vec::new(),
            leaderboard_rating_columns: DEFAULT_LEADERBOARD_RATING_COLUMNS
                .iter()
                .map(|col| (*col).to_owned())
                .collect(),
            legacy_storage_migrated: false,
        }
    }
}

impl<'de> Deserialize<'de> for BrowsingPreferences {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            custom_games_view: CustomGameView,
            replays_view: CustomGameView,
            custom_games_browser: CustomGameBrowserPreferences,
            matchmaker_unselected_queues: Vec<String>,
            matchmaker_factions: Vec<String>,
            live_replay_filters: LiveReplayFilters,
            host_game: HostGamePreferences,
            favorite_maps: Vec<String>,
            map_vault_preset: String,
            mod_vault_preset: String,
            mod_presets: Vec<ModPreset>,
            leaderboard_rating_columns: Vec<String>,
            legacy_storage_migrated: bool,
        }

        impl Default for Wire {
            fn default() -> Self {
                let defaults = BrowsingPreferences::default();
                Self {
                    custom_games_view: defaults.custom_games_view,
                    replays_view: defaults.replays_view,
                    custom_games_browser: defaults.custom_games_browser,
                    matchmaker_unselected_queues: defaults.matchmaker_unselected_queues,
                    matchmaker_factions: defaults.matchmaker_factions,
                    live_replay_filters: defaults.live_replay_filters,
                    host_game: defaults.host_game,
                    favorite_maps: defaults.favorite_maps,
                    map_vault_preset: defaults.map_vault_preset,
                    mod_vault_preset: defaults.mod_vault_preset,
                    mod_presets: defaults.mod_presets,
                    leaderboard_rating_columns: defaults.leaderboard_rating_columns,
                    legacy_storage_migrated: defaults.legacy_storage_migrated,
                }
            }
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            custom_games_view: wire.custom_games_view,
            replays_view: wire.replays_view,
            custom_games_browser: wire.custom_games_browser,
            matchmaker_unselected_queues: wire.matchmaker_unselected_queues,
            matchmaker_factions: wire.matchmaker_factions,
            live_replay_filters: wire.live_replay_filters,
            host_game: wire.host_game,
            favorite_maps: wire.favorite_maps,
            map_vault_preset: wire.map_vault_preset,
            mod_vault_preset: wire.mod_vault_preset,
            mod_presets: wire.mod_presets,
            leaderboard_rating_columns: wire.leaderboard_rating_columns,
            legacy_storage_migrated: wire.legacy_storage_migrated,
        })
    }
}

const MATCHMAKER_FACTIONS: [&str; 4] = ["UEF", "Aeon", "Cybran", "Seraphim"];

/// Caps for saved mod sets. Generous enough that no real user meets them, small
/// enough that a corrupt settings file cannot grow the state without limit.
const MAX_MOD_PRESETS: usize = 64;
const MAX_MOD_PRESET_NAME_CHARS: usize = 64;
const MAX_MODS_PER_PRESET: usize = 512;

impl BrowsingPreferences {
    fn normalized(mut self) -> Self {
        self.custom_games_browser = self.custom_games_browser.normalized();
        self.matchmaker_unselected_queues =
            normalize_labels(self.matchmaker_unselected_queues, 64, 128);
        let selected_factions: Vec<String> = MATCHMAKER_FACTIONS
            .iter()
            .filter(|canonical| {
                self.matchmaker_factions
                    .iter()
                    .any(|candidate| candidate.trim().eq_ignore_ascii_case(canonical))
            })
            .map(|faction| (*faction).to_owned())
            .collect();
        self.matchmaker_factions = if selected_factions.is_empty() {
            MATCHMAKER_FACTIONS
                .iter()
                .map(|faction| (*faction).to_owned())
                .collect()
        } else {
            selected_factions
        };
        self.live_replay_filters.search = truncate_trimmed(self.live_replay_filters.search, 200);
        self.live_replay_filters.game_type =
            truncate_trimmed(self.live_replay_filters.game_type, 64);
        self.live_replay_filters.featured_mod =
            truncate_trimmed(self.live_replay_filters.featured_mod, 128);
        self.live_replay_filters.active_players =
            normalize_player_count(self.live_replay_filters.active_players);
        self.live_replay_filters.max_players =
            normalize_player_count(self.live_replay_filters.max_players);
        self.host_game = self.host_game.normalized();
        self.favorite_maps = normalize_labels(self.favorite_maps, 512, 256)
            .into_iter()
            .map(|folder| folder.to_ascii_lowercase())
            .collect();
        self.map_vault_preset = match self.map_vault_preset.trim().to_ascii_lowercase().as_str() {
            "favorites" => "favorites".into(),
            // Kept even when signed out: the preset outlives the session it was
            // chosen in, and the tab decides whether it can be honoured. Folding
            // it to "recommended" here would silently undo the user's choice on
            // every round trip through the settings service.
            "mine" => "mine".into(),
            "rating" => "rating".into(),
            "newest" => "newest".into(),
            "played" => "played".into(),
            "all" => "all".into(),
            _ => "recommended".into(),
        };
        self.mod_vault_preset = match self.mod_vault_preset.trim().to_ascii_lowercase().as_str() {
            "rating" => "rating".into(),
            // Same reasoning as the map preset above: kept even when signed
            // out, because the tab, not this function, decides whether it can
            // be honoured.
            "mine" => "mine".into(),
            "ui" => "ui".into(),
            "newest" => "newest".into(),
            "all" => "all".into(),
            _ => "recommended".into(),
        };
        self.mod_presets = normalize_mod_presets(std::mem::take(&mut self.mod_presets));
        let selected_columns: Vec<String> = VALID_LEADERBOARD_RATING_COLUMNS
            .iter()
            .filter(|canonical| {
                self.leaderboard_rating_columns
                    .iter()
                    .any(|candidate| candidate.trim().eq_ignore_ascii_case(canonical))
            })
            .map(|col| (*col).to_owned())
            .collect();
        self.leaderboard_rating_columns = if selected_columns.is_empty() {
            DEFAULT_LEADERBOARD_RATING_COLUMNS
                .iter()
                .map(|col| (*col).to_owned())
                .collect()
        } else {
            selected_columns
        };
        self
    }
}

/// Persisted preferences. `#[serde(default)]` is essential for forward
/// compatibility: settings files written by older builds only contain the
/// original theme/path fields and must retain them while new groups default.
// No `Eq`: the map generator's density preferences are `f32`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsState {
    pub theme: Theme,
    pub game_path: String,
    pub replay_game_path: String,
    pub general: GeneralPreferences,
    pub appearance: AppearancePreferences,
    pub social: SocialPreferences,
    pub notifications: NotificationPreferences,
    pub chat: ChatPreferences,
    pub game: GamePreferences,
    pub discord: DiscordPreferences,
    pub connectivity: ConnectivityPreferences,
    pub updates: UpdatePreferences,
    pub browsing: BrowsingPreferences,
    /// The map generator dialog's last settings.
    ///
    /// Persisted for the same reason the Java client keeps `GeneratorPrefs`:
    /// choosing a size, spawn count and half a dozen styles is real work, and
    /// having it survive a restart is the difference between the dialog being
    /// configured once and being configured every time.
    pub map_generator: GeneratorOptions,
}

impl<'de> Deserialize<'de> for SettingsState {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        /// Read compatibility belongs at the persistence boundary, not in the
        /// exported type. Keeping `#[serde(default)]` off `SettingsState`
        /// prevents Specta from incorrectly making every TypeScript field
        /// optional while this wire shape still accepts old settings files.
        #[derive(Default, Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            theme: Theme,
            game_path: String,
            replay_game_path: String,
            general: GeneralPreferences,
            appearance: AppearancePreferences,
            social: SocialPreferences,
            notifications: NotificationPreferences,
            chat: ChatPreferences,
            game: GamePreferences,
            discord: DiscordPreferences,
            connectivity: ConnectivityPreferences,
            updates: UpdatePreferences,
            browsing: BrowsingPreferences,
            map_generator: GeneratorOptions,
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            theme: wire.theme,
            game_path: wire.game_path,
            replay_game_path: wire.replay_game_path,
            general: wire.general,
            appearance: wire.appearance,
            social: wire.social,
            notifications: wire.notifications,
            chat: wire.chat,
            game: wire.game,
            discord: wire.discord,
            connectivity: wire.connectivity,
            updates: wire.updates,
            browsing: wire.browsing,
            map_generator: wire.map_generator,
        })
    }
}

impl SettingsState {
    pub fn normalized(mut self) -> Self {
        self.chat = self.chat.normalized();
        self.social = self.social.normalized();
        self.notifications = self.notifications.normalized();
        self.game = self.game.normalized();
        self.browsing = self.browsing.normalized();
        // Clamped at the state boundary, so a hand-edited settings file cannot
        // zoom the interface to something unusable that is then hard to undo:
        // the control for fixing it would be off screen.
        self.appearance.ui_scale = self.appearance.ui_scale.clamp(MIN_UI_SCALE, MAX_UI_SCALE);
        self
    }
}

// No `Eq`: the map generator's density preferences are `f32`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum SettingsEvent {
    Loaded {
        settings: Box<SettingsState>,
    },
    ThemeChanged {
        theme: Theme,
    },
    GamePathChanged {
        path: String,
    },
    ReplayGamePathChanged {
        path: String,
    },
    GeneralChanged {
        preferences: GeneralPreferences,
    },
    AppearanceChanged {
        preferences: AppearancePreferences,
    },
    SocialChanged {
        preferences: SocialPreferences,
    },
    NotificationsChanged {
        preferences: NotificationPreferences,
    },
    /// Boxed for the same reason `Loaded` is: chat preferences carry the name
    /// colours and are far larger than any sibling variant, so an unboxed one
    /// would set the size of every `SettingsEvent` ever passed around.
    ChatChanged {
        preferences: Box<ChatPreferences>,
    },
    GameChanged {
        preferences: GamePreferences,
    },
    DiscordChanged {
        preferences: DiscordPreferences,
    },
    ConnectivityChanged {
        preferences: ConnectivityPreferences,
    },
    UpdatesChanged {
        preferences: UpdatePreferences,
    },
    BrowsingChanged {
        preferences: Box<BrowsingPreferences>,
    },
    MapGeneratorChanged {
        preferences: Box<GeneratorOptions>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum SettingsCommand {
    Load,
    SetTheme {
        theme: Theme,
    },
    SetGamePath {
        path: String,
    },
    SetReplayGamePath {
        path: String,
    },
    SetGeneral {
        preferences: GeneralPreferences,
    },
    SetAppearance {
        preferences: AppearancePreferences,
    },
    SetPlayerNote {
        player_id: i32,
        login: String,
        note: String,
    },
    SetNotifications {
        preferences: NotificationPreferences,
    },
    /// Boxed, like the event it produces.
    SetChat {
        preferences: Box<ChatPreferences>,
    },
    SetGame {
        preferences: GamePreferences,
    },
    SetDiscord {
        preferences: DiscordPreferences,
    },
    SetConnectivity {
        preferences: ConnectivityPreferences,
    },
    SetUpdates {
        preferences: UpdatePreferences,
    },
    SetMapGenerator {
        preferences: Box<GeneratorOptions>,
    },
    SetBrowsing {
        preferences: Box<BrowsingPreferences>,
    },
    CheckInstalls,
}

pub fn reduce(state: &mut SettingsState, event: &SettingsEvent) {
    match event {
        SettingsEvent::Loaded { settings } => *state = settings.as_ref().clone(),
        SettingsEvent::ThemeChanged { theme } => state.theme = *theme,
        SettingsEvent::GamePathChanged { path } => state.game_path = path.clone(),
        SettingsEvent::ReplayGamePathChanged { path } => state.replay_game_path = path.clone(),
        SettingsEvent::GeneralChanged { preferences } => state.general = preferences.clone(),
        SettingsEvent::AppearanceChanged { preferences } => state.appearance = preferences.clone(),
        SettingsEvent::SocialChanged { preferences } => {
            state.social = preferences.clone().normalized()
        }
        SettingsEvent::NotificationsChanged { preferences } => {
            state.notifications = preferences.clone()
        }
        SettingsEvent::ChatChanged { preferences } => state.chat = preferences.as_ref().clone(),
        SettingsEvent::GameChanged { preferences } => state.game = preferences.clone(),
        SettingsEvent::DiscordChanged { preferences } => state.discord = *preferences,
        SettingsEvent::ConnectivityChanged { preferences } => state.connectivity = *preferences,
        SettingsEvent::UpdatesChanged { preferences } => state.updates = *preferences,
        SettingsEvent::BrowsingChanged { preferences } => {
            state.browsing = preferences.as_ref().clone().normalized()
        }
        SettingsEvent::MapGeneratorChanged { preferences } => {
            state.map_generator = preferences.as_ref().clone()
        }
    }
}

fn truncate_trimmed(value: String, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

fn normalize_player_count(value: String) -> String {
    let value = value.trim();
    if value.is_empty() || !value.chars().all(|character| character.is_ascii_digit()) {
        return String::new();
    }
    value
        .parse::<u8>()
        .ok()
        .filter(|count| (1..=64).contains(count))
        .map(|count| count.to_string())
        .unwrap_or_default()
}

/// Bound the user's saved mod sets the way every other list here is bounded.
///
/// Names are compared case-insensitively and the first wins, so a settings file
/// that somehow holds two "Replay" presets keeps the older one rather than
/// silently swapping which one a button applies. Saving over a name is the UI's
/// job and replaces in place; this is only the repair path for a corrupt file.
fn normalize_mod_presets(presets: Vec<ModPreset>) -> Vec<ModPreset> {
    let mut normalized: Vec<ModPreset> = Vec::new();
    for preset in presets {
        let name = truncate_trimmed(preset.name, MAX_MOD_PRESET_NAME_CHARS);
        if name.is_empty()
            || normalized
                .iter()
                .any(|existing| existing.name.eq_ignore_ascii_case(&name))
        {
            continue;
        }
        normalized.push(ModPreset {
            name,
            // An empty preset is meaningful: it is "no mods at all", which is
            // exactly what someone wants before watching an old replay.
            uids: normalize_labels(preset.uids, MAX_MODS_PER_PRESET, 128),
        });
        if normalized.len() == MAX_MOD_PRESETS {
            break;
        }
    }
    normalized
}

fn normalize_labels(values: Vec<String>, limit: usize, max_chars: usize) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in values {
        let value = truncate_trimmed(value, max_chars);
        if value.is_empty()
            || normalized
                .iter()
                .any(|existing: &String| existing.eq_ignore_ascii_case(&value))
        {
            continue;
        }
        normalized.push(value);
        if normalized.len() == limit {
            break;
        }
    }
    normalized
}

fn normalize_logins(logins: Vec<String>, limit: usize) -> Vec<String> {
    let mut normalized = Vec::new();
    for login in logins {
        let login = login.trim();
        if login.is_empty() || login.len() > 64 {
            continue;
        }
        if !normalized
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(login))
        {
            normalized.push(login.to_owned());
        }
        if normalized.len() == limit {
            break;
        }
    }
    normalized.sort_by_key(|login| login.to_ascii_lowercase());
    normalized
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
    fn defaults_match_the_safe_reference_client_behaviour() {
        let settings = SettingsState::default();
        assert_eq!(settings.theme, Theme::ForgeDark);
        assert_eq!(settings.general.start_page, Tab::News);
        assert!(settings.chat.show_timestamps);
        assert!(settings.chat.hide_foe_messages);
        assert!(!settings.chat.colored_names);
        assert_eq!(settings.chat.roster_width, 280);
        assert_eq!(settings.chat.visible_message_limit, 500);
        assert!(settings.notifications.match_found);
        assert!(settings.notifications.sound);
        assert_eq!(settings.notifications.volume, 70);
        assert_eq!(settings.browsing.custom_games_view, CustomGameView::Tiles);
        assert_eq!(
            settings.browsing.matchmaker_factions,
            ["UEF", "Aeon", "Cybran", "Seraphim"]
        );
        assert!(!settings.browsing.legacy_storage_migrated);
    }

    #[test]
    fn old_settings_files_gain_new_defaults() {
        let settings: SettingsState = serde_json::from_str(
            r#"{"theme":"javaClient","gamePath":"game.exe","replayGamePath":"replay.exe"}"#,
        )
        .unwrap();
        assert_eq!(settings.theme, Theme::JavaClient);
        assert_eq!(settings.game_path, "game.exe");
        assert_eq!(settings.chat, ChatPreferences::default());
        assert!(settings.chat.read_markers.is_empty());
        assert_eq!(settings.social, SocialPreferences::default());
        // A missing group must default, and Rich Presence defaults *on*,
        // reading it as `false` would silently disable a feature that the
        // reference client has no way to turn off.
        assert!(settings.discord.enabled);
        assert!(!settings.discord.disallow_joins);
        assert_eq!(settings.browsing, BrowsingPreferences::default());
    }

    #[test]
    fn legacy_pioneer_default_migrates_to_java() {
        let settings: SettingsState =
            serde_json::from_str(r#"{"connectivity":{"adapter":"go"}}"#).unwrap();

        assert_eq!(settings.connectivity.adapter, IceAdapter::Java);
        assert_eq!(
            settings.connectivity.selection_version,
            CONNECTIVITY_SELECTION_VERSION
        );
    }

    #[test]
    fn an_explicit_current_pioneer_choice_is_preserved() {
        let settings: SettingsState =
            serde_json::from_str(r#"{"connectivity":{"adapter":"go","selectionVersion":1}}"#)
                .unwrap();

        assert_eq!(settings.connectivity.adapter, IceAdapter::Go);
        assert_eq!(
            settings.connectivity.selection_version,
            CONNECTIVITY_SELECTION_VERSION
        );
    }

    #[test]
    fn existing_notification_preferences_gain_new_event_defaults() {
        let settings: SettingsState = serde_json::from_str(
            r#"{
                "notifications": {
                    "enabled": true,
                    "desktop": false,
                    "sound": false,
                    "notifyWhenFocused": true,
                    "matchFound": false,
                    "privateMessages": true,
                    "mentions": false,
                    "friendOnline": false,
                    "partyInvites": false,
                    "volume": 22
                }
            }"#,
        )
        .unwrap();

        assert!(!settings.notifications.desktop);
        assert!(!settings.notifications.match_found);
        assert_eq!(settings.notifications.volume, 22);
        assert!(settings.notifications.friend_offline);
        assert!(settings.notifications.friend_playing);
        assert!(!settings.notifications.new_custom_games);
        assert!(settings.notifications.new_custom_games_friends_only);
        assert!(settings.notifications.game_full);
        assert!(settings.notifications.game_launched);
        assert!(settings.notifications.review_reminder);
    }

    #[test]
    fn a_settings_file_that_turned_rich_presence_off_keeps_it_off() {
        // The custom reader defaults every *absent* field, so the one field
        // the user actually set has to survive alongside the defaults.
        let settings: SettingsState =
            serde_json::from_str(r#"{"discord":{"enabled":false}}"#).unwrap();
        assert!(!settings.discord.enabled);
        assert!(!settings.discord.disallow_joins);
    }

    #[test]
    fn an_older_settings_file_keeps_update_checks_switched_on() {
        // The failure this guards against is silent: reading a missing group
        // as `false` would turn automatic update checks off for every user who
        // has ever saved a setting, and nothing would ever say so.
        let settings: SettingsState = serde_json::from_str(r#"{"theme":"forgeDark"}"#).unwrap();
        assert!(settings.updates.automatic);
        assert!(!settings.updates.pre_release);
        assert_eq!(
            settings.updates.channel(),
            super::super::ReleaseChannel::Stable
        );
    }

    #[test]
    fn opting_into_prereleases_survives_a_reload_and_selects_the_channel() {
        let settings: SettingsState =
            serde_json::from_str(r#"{"updates":{"preRelease":true}}"#).unwrap();
        assert!(settings.updates.pre_release);
        assert!(
            settings.updates.automatic,
            "the absent field still defaults"
        );
        assert_eq!(
            settings.updates.channel(),
            super::super::ReleaseChannel::PreRelease
        );
    }

    #[test]
    fn normalization_bounds_lists_and_cleans_channels() {
        let settings = SettingsState {
            chat: ChatPreferences {
                visible_message_limit: 5,
                auto_join_channels: vec![" aeolus ".into(), "#AEOLUS".into(), String::new()],
                muted_players: vec![" Aurora ".into(), "aurora".into(), String::new()],
                ..ChatPreferences::default()
            },
            game: GamePreferences {
                additional_arguments: vec![" /windowed ".into(), String::new()],
                ..Default::default()
            },
            ..SettingsState::default()
        }
        .normalized();

        assert_eq!(settings.chat.visible_message_limit, 50);
        assert_eq!(settings.chat.auto_join_channels, vec!["#aeolus"]);
        assert_eq!(settings.chat.muted_players, vec!["Aurora"]);
        assert_eq!(settings.game.additional_arguments, vec!["/windowed"]);
    }

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
    fn browsing_preferences_are_normalized_at_the_state_boundary() {
        let settings = SettingsState {
            browsing: BrowsingPreferences {
                custom_games_view: CustomGameView::List,
                replays_view: CustomGameView::List,
                custom_games_browser: CustomGameBrowserPreferences {
                    sort: CustomGameSort::Host,
                    hide_private: true,
                    hide_modded: true,
                    apply_filters: true,
                    rules: vec![
                        CustomGameFilterRule {
                            field: CustomGameFilterField::Title,
                            constraint: CustomGameFilterConstraint::Contains,
                            value: "  no rush  ".into(),
                        },
                        CustomGameFilterRule {
                            field: CustomGameFilterField::Title,
                            constraint: CustomGameFilterConstraint::Contains,
                            value: "NO RUSH".into(),
                        },
                        CustomGameFilterRule {
                            field: CustomGameFilterField::Map,
                            constraint: CustomGameFilterConstraint::Equals,
                            value: String::new(),
                        },
                    ],
                },
                matchmaker_unselected_queues: vec![
                    "  ladder_1v1  ".into(),
                    "LADDER_1V1".into(),
                    String::new(),
                ],
                matchmaker_factions: vec!["cybran".into(), "unknown".into()],
                live_replay_filters: LiveReplayFilters {
                    search: format!("  {}  ", "x".repeat(250)),
                    game_type: "  matchmaker  ".into(),
                    featured_mod: " faf ".into(),
                    active_players: "04".into(),
                    max_players: "999".into(),
                    hide_modded: true,
                    hide_single_player: false,
                    friends_only: true,
                },
                host_game: HostGamePreferences {
                    title: "  Friday night  ".into(),
                    featured_mod: "  ".into(),
                    visibility: "FRIENDS".into(),
                    map: " scmp_009 ".into(),
                    password_enabled: true,
                    password: "  secret  ".into(),
                    enforce_rating_range: true,
                    rating_min: 1_500,
                    rating_max: 800,
                },
                favorite_maps: vec![
                    "  Adaptive_Tabula.v0006  ".into(),
                    "adaptive_tabula.v0006".into(),
                    String::new(),
                ],
                map_vault_preset: "  NEWEST  ".into(),
                mod_vault_preset: "  UI  ".into(),
                mod_presets: Vec::new(),
                leaderboard_rating_columns: vec![
                    "rating".into(),
                    "MEAN".into(),
                    "invalid_col".into(),
                ],
                legacy_storage_migrated: true,
            },
            ..SettingsState::default()
        }
        .normalized();

        assert_eq!(settings.browsing.custom_games_view, CustomGameView::List);
        assert_eq!(
            settings.browsing.custom_games_browser.sort,
            CustomGameSort::Host
        );
        assert!(settings.browsing.custom_games_browser.hide_private);
        assert_eq!(settings.browsing.custom_games_browser.rules.len(), 1);
        assert_eq!(
            settings.browsing.custom_games_browser.rules[0].value,
            "no rush"
        );
        assert_eq!(
            settings.browsing.matchmaker_unselected_queues,
            ["ladder_1v1"]
        );
        assert_eq!(settings.browsing.matchmaker_factions, ["Cybran"]);
        assert_eq!(
            settings.browsing.live_replay_filters.search.chars().count(),
            200
        );
        assert_eq!(
            settings.browsing.live_replay_filters.game_type,
            "matchmaker"
        );
        assert_eq!(settings.browsing.live_replay_filters.active_players, "4");
        assert!(settings.browsing.live_replay_filters.max_players.is_empty());
        assert!(settings.browsing.live_replay_filters.hide_modded);
        assert!(settings.browsing.live_replay_filters.friends_only);
        assert_eq!(settings.browsing.host_game.title, "Friday night");
        assert_eq!(settings.browsing.host_game.featured_mod, "faf");
        assert_eq!(settings.browsing.host_game.visibility, "friends");
        assert_eq!(settings.browsing.host_game.map, "scmp_009");
        assert_eq!(settings.browsing.host_game.password, "  secret  ");
        assert_eq!(settings.browsing.host_game.rating_min, 800);
        assert_eq!(settings.browsing.host_game.rating_max, 1_500);
        assert_eq!(settings.browsing.favorite_maps, ["adaptive_tabula.v0006"]);
        assert_eq!(settings.browsing.map_vault_preset, "newest");
        assert_eq!(settings.browsing.mod_vault_preset, "ui");
        assert_eq!(
            settings.browsing.leaderboard_rating_columns,
            ["rating", "mean"]
        );
        assert!(settings.browsing.legacy_storage_migrated);
    }

    #[test]
    fn mod_presets_are_bounded_and_deduplicated_but_may_be_empty() {
        let mut settings = SettingsState::default();
        settings.browsing.mod_presets = vec![
            ModPreset {
                name: "  Replay watching  ".into(),
                uids: vec!["  a  ".into(), "A".into(), String::new(), "b".into()],
            },
            // An empty selection is a legitimate preset: "no mods at all".
            ModPreset {
                name: "Vanilla".into(),
                uids: Vec::new(),
            },
            // Same name in a different case: the first one wins, so a button
            // does not silently start applying a different set.
            ModPreset {
                name: "REPLAY WATCHING".into(),
                uids: vec!["z".into()],
            },
            ModPreset {
                name: "   ".into(),
                uids: vec!["c".into()],
            },
        ];

        let settings = settings.normalized();

        let presets = &settings.browsing.mod_presets;
        assert_eq!(
            presets.len(),
            2,
            "unnamed and duplicate presets are dropped"
        );
        assert_eq!(presets[0].name, "Replay watching");
        assert_eq!(
            presets[0].uids,
            ["a", "b"],
            "uids are trimmed and deduplicated"
        );
        assert_eq!(presets[1].name, "Vanilla");
        assert!(presets[1].uids.is_empty());
    }

    #[test]
    fn the_my_maps_preset_survives_normalisation() {
        // The bug this pins: "mine" was missing from the whitelist, so every
        // round trip through the settings service folded it to "recommended"
        // and the tab snapped back the instant it was chosen.
        let mut browsing = BrowsingPreferences {
            map_vault_preset: "  MINE  ".into(),
            ..BrowsingPreferences::default()
        };
        browsing = browsing.normalized();
        assert_eq!(browsing.map_vault_preset, "mine");

        // Still nothing else gets through.
        let junk = BrowsingPreferences {
            map_vault_preset: "not-a-preset".into(),
            mod_vault_preset: "not-a-preset".into(),
            ..BrowsingPreferences::default()
        }
        .normalized();
        assert_eq!(junk.map_vault_preset, "recommended");
        assert_eq!(junk.mod_vault_preset, "recommended");

        // The mod vault has the same preset, and had the same bug.
        let mods = BrowsingPreferences {
            mod_vault_preset: "Mine".into(),
            ..BrowsingPreferences::default()
        }
        .normalized();
        assert_eq!(mods.mod_vault_preset, "mine");
    }

    #[test]
    fn an_empty_or_unknown_faction_set_falls_back_to_all_factions() {
        for factions in [Vec::new(), vec!["Nomads".into()]] {
            let preferences = BrowsingPreferences {
                matchmaker_factions: factions,
                ..BrowsingPreferences::default()
            }
            .normalized();
            assert_eq!(
                preferences.matchmaker_factions,
                ["UEF", "Aeon", "Cybran", "Seraphim"]
            );
        }
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

    #[test]
    fn player_notes_are_keyed_by_id_bounded_and_clearable() {
        let mut preferences = SocialPreferences::default();
        preferences.set_player_note(42, " OldName ".into(), " first note ".into());
        preferences.set_player_note(
            42,
            "NewName".into(),
            "é".repeat(PLAYER_NOTE_CHARACTER_LIMIT + 20),
        );
        preferences.set_player_note(7, "EarlierId".into(), "keep me".into());

        assert_eq!(preferences.player_notes[0].player_id, 7);
        let note = preferences.note_for(42).unwrap();
        assert_eq!(note.login, "NewName");
        assert_eq!(note.note.chars().count(), PLAYER_NOTE_CHARACTER_LIMIT);

        preferences.set_player_note(42, "NewName".into(), "   ".into());
        assert!(preferences.note_for(42).is_none());
        assert_eq!(preferences.player_notes.len(), 1);
    }

    #[test]
    fn malformed_persisted_player_notes_are_normalized_away() {
        let settings = SettingsState {
            social: SocialPreferences {
                player_notes: vec![
                    PlayerNote {
                        player_id: -1,
                        login: "Invalid".into(),
                        note: "ignored".into(),
                    },
                    PlayerNote {
                        player_id: 3,
                        login: " Aurora ".into(),
                        note: " useful ".into(),
                    },
                ],
            },
            ..SettingsState::default()
        }
        .normalized();

        assert_eq!(settings.social.player_notes.len(), 1);
        assert_eq!(settings.social.player_notes[0].login, "Aurora");
        assert_eq!(settings.social.player_notes[0].note, "useful");
    }
}
