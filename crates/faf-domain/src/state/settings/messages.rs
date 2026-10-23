//! The commands the settings page sends and the events the service answers
//! with.

use super::*;

// No `Eq`: the map generator's density preferences are `f32`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
// `rename_all_fields` matters from `KeptGeneratedMaps` onwards: every earlier
// variant carries a single-word field, so camelCase was silently identical to
// snake_case and its absence never showed.
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
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
    PathsChanged {
        preferences: PathPreferences,
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
    DebugChanged {
        preferences: DebugPreferences,
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
    EventsChanged {
        preferences: Box<EventsPreferences>,
    },
    /// Generated maps a finished run asked to keep. Additive: a later run that
    /// keeps nothing must not release what an earlier one kept.
    KeptGeneratedMaps {
        map_names: Vec<String>,
    },
    CacheInfoUpdated {
        info: GameCacheInfo,
    },
    /// The matchmaker veto selection to replay at the next login, replacing
    /// whatever was remembered before. Not additive, unlike
    /// [`SettingsEvent::KeptGeneratedMaps`]: this is one whole selection, and
    /// clearing every veto has to be able to clear it.
    MatchmakerVetoesChanged {
        vetoes: Vec<PlayerVeto>,
    },
    /// The map pools seen this session, replacing the remembered ones. See
    /// [`SettingsState::map_pools_seen`].
    MapPoolsSeen {
        seen: Vec<MapPoolsSeen>,
    },
    /// The remembered avatar choices, replaced whole; see
    /// [`SettingsState::avatar_history`].
    AvatarHistoryChanged {
        history: Vec<String>,
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
    // The `Patch*` commands carry only the fields that changed, merged into
    // the authoritative group by the service; see `preference_patch!` for why
    // a whole group is never sent any more.
    PatchPaths {
        patch: PathPreferencesPatch,
    },
    PatchGeneral {
        patch: GeneralPreferencesPatch,
    },
    PatchAppearance {
        patch: AppearancePreferencesPatch,
    },
    SetPlayerNote {
        player_id: i32,
        login: String,
        note: String,
    },
    /// Write or clear the private note and tags on one replay (#324).
    #[serde(rename_all = "camelCase")]
    SetReplayNote {
        replay_id: i32,
        /// The file, for a replay whose header names no game: the note is
        /// kept on that instead. Ignored when `replay_id` names a game.
        #[serde(default)]
        local_path: Option<String>,
        comment: String,
        tags: Vec<String>,
    },
    /// Rename a replay tag everywhere, or delete it when `to` is empty (#324).
    RenameReplayTag {
        from: String,
        to: String,
    },
    PatchNotifications {
        patch: Box<NotificationPreferencesPatch>,
    },
    /// Delete one sound the player added, after pointing every notification
    /// that plays it back at a shipped tone.
    ///
    /// One command rather than a settings write followed by a file delete in
    /// the webview, because the order is the whole point: the file may only go
    /// once no saved setting names it, and a webview firing both cannot know
    /// when, or whether, the first one landed. Failure is reported as a
    /// notification; the file is kept whenever the settings could not be
    /// written first.
    RemoveNotificationSound {
        name: String,
    },
    /// Boxed, like the event it produces.
    PatchChat {
        patch: Box<ChatPreferencesPatch>,
    },
    PatchGame {
        patch: Box<GamePreferencesPatch>,
    },
    PatchDiscord {
        patch: DiscordPreferencesPatch,
    },
    PatchConnectivity {
        patch: ConnectivityPreferencesPatch,
    },
    PatchDebug {
        patch: DebugPreferencesPatch,
    },
    PatchUpdates {
        patch: UpdatePreferencesPatch,
    },
    /// Whole, unlike the groups above: the generator options are one recipe
    /// the dialog edits as a unit and saves as a unit.
    SetMapGenerator {
        preferences: Box<GeneratorOptions>,
    },
    PatchBrowsing {
        patch: Box<BrowsingPreferencesPatch>,
    },
    PatchEvents {
        patch: Box<EventsPreferencesPatch>,
    },
    // The commands below change one entry of a list or map. A `Patch*` field
    // would carry the whole collection as the webview last saw it, so two
    // quick toggles of the same list would still lose the first; these are
    // applied to the backend's copy instead. See `PreferenceList`.
    /// Add `value` to one string list (`member`), or remove it.
    SetListMember {
        list: PreferenceList,
        value: String,
        member: bool,
    },
    /// Give one player's name a chat colour, or clear the one it has.
    SetPlayerNameColor {
        player: String,
        color: Option<String>,
    },
    /// Save a named mod set, replacing one of the same name in place.
    SaveModPreset {
        preset: ModPreset,
    },
    /// Delete the named mod set.
    DeleteModPreset {
        name: String,
    },
    /// Save a named search preset for one list, replacing one of the same name
    /// in place.
    SaveSearchPreset {
        preset: SearchPreset,
    },
    /// Delete the named search preset from one list.
    DeleteSearchPreset {
        list: String,
        name: String,
    },
    CheckInstalls,
    RefreshGameCache,
    ClearGameCache,
}
