//! Browsing: what the lists, vaults and lobby views remember between visits,
//! from view modes and column layouts to favourites and saved mod sets.

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CustomGameView {
    #[default]
    Tiles,
    List,
}

/// What a replay's chat log shows of the lines the game writes when somebody
/// shares: "Sent 1.2k energy to …", "sent 1 unit to …" and the request
/// button's "Can you give me some energy, …?".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReplayChatTransfers {
    #[default]
    Show,
    Hide,
    Only,
}

/// The widest table the client draws, plus room. Only a bound on a file.
pub const MAX_TABLE_COLUMNS: usize = 16;

/// The party chat rail's bounds. The floor is where a chat line stops being
/// readable at all; the ceiling leaves two queue cards beside it.
pub const MIN_PARTY_CHAT_PX: u32 = 260;
pub const MAX_PARTY_CHAT_PX: u32 = 900;

/// How many entries a vault page may show. The floor is a screen worth of
/// them; the ceiling is where a page stops being a page.
pub const MIN_VAULT_PAGE_SIZE: u32 = 12;
pub const MAX_VAULT_PAGE_SIZE: u32 = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowsingPreferences {
    pub custom_games_view: CustomGameView,
    pub replays_view: CustomGameView,
    /// The live-replay tab's own list-or-cards choice.
    ///
    /// Not `replays_view`, which the online and local libraries share. Those
    /// two are the same list of finished games read two ways; the live tab is
    /// a different question - what is being played right now - and the answer
    /// somebody wants there is routinely the other one. Reported as exactly
    /// that: cards in the vault, a table for what is live.
    pub live_replay_view: CustomGameView,
    pub custom_games_browser: CustomGameBrowserPreferences,
    pub matchmaker_unselected_queues: Vec<String>,
    pub matchmaker_factions: Vec<String>,
    /// Pixel width of the matchmaker's party chat rail, or `0` for the
    /// designed default.
    ///
    /// The same shape and the same reason as
    /// `CustomGameBrowserPreferences::detail_width`: how much of the tab a
    /// conversation is worth is a matter of what somebody is doing with it,
    /// and the tab has a queue grid on the other side of the divider that
    /// wants the same pixels. Stored rather than kept in the browser so it
    /// survives a reinstall, like every other browsing preference here.
    pub matchmaker_chat_width: u32,
    pub live_replay_filters: LiveReplayFilters,
    pub host_game: HostGamePreferences,
    /// The co-op host dialog's own copy of the same form.
    ///
    /// Separate from `host_game` on purpose, and for the same reason the co-op
    /// launch surface is separate in both reference clients: a mission's
    /// lobby name has no business replacing the one somebody set up for
    /// skirmishes. That separation is also why the co-op dialog remembered
    /// nothing at all - and why switching to the chat tab, which unmounts the
    /// whole play view, threw away the title, the password and the mission.
    ///
    /// `map` holds the chosen mission's map folder, which is what `map` means
    /// for the custom dialog too: the thing that will be hosted.
    pub host_coop: HostGamePreferences,
    /// Stable map folder names starred by the user. Python persists the same
    /// key and uses it in the host picker and generated-map cleanup.
    pub favorite_maps: Vec<String>,
    /// Stable mod UIDs starred by the user.
    pub favorite_mods: Vec<String>,
    /// Hosts whose games the game browser always shows, by login (#492).
    ///
    /// The exception to every hide switch and filter rule rather than one
    /// more of them: somebody who hides modded and unranked games still wants
    /// to see what a particular host has opened. Not a filter in
    /// `FilterMemory`'s sense either, because it narrows nothing, so
    /// [`BrowsingPreferences::without_filters`] leaves it as it is.
    pub whitelisted_hosts: Vec<String>,
    /// Active preset filter in the map vault ("recommended", "favorites", "rating", "newest", "played", "all").
    pub map_vault_preset: String,
    /// Active preset filter in the mod vault ("recommended", "favorites", "rating", "ui", "newest", "all").
    pub mod_vault_preset: String,
    /// Chosen sort order in the map vault, empty to follow the preset.
    ///
    /// Persisted for the same reason the preset is: leaving a tab and coming
    /// back put the list in an order nobody asked for, and the order is the
    /// half of a browse that a preset does not decide.
    pub map_vault_sort: String,
    /// Chosen sort order in the mod vault, empty to follow the preset.
    pub mod_vault_sort: String,
    /// How many entries a vault page shows, or `0` for the designed default.
    ///
    /// One number for maps and mods, installed and vault alike: the question
    /// is about how much of the screen a reader wants filled, and answering it
    /// four times over would be four settings saying the same thing.
    pub vault_page_size: u32,
    /// Column widths in the replay list, in pixels and in the order the
    /// columns are drawn. Empty means the designed widths.
    ///
    /// The same shape and the same reason as
    /// `CustomGameBrowserPreferences::column_widths`: the columns worth
    /// widening are the ones whose contents the reader is scanning, and which
    /// those are differs per person. Stored rather than kept in the browser so
    /// it survives a reinstall, like every other browsing preference here.
    pub replay_list_columns: Vec<u32>,
    /// The replay list's columns in the order they are drawn, as indexes into
    /// the designed order. Empty is the designed order; anything that is not
    /// exactly one of each column is dropped to empty.
    pub replay_list_order: Vec<u32>,
    /// The same for the live-replay table, which is a different table with
    /// different columns and therefore a different set of widths. Sharing one
    /// list between them would have a drag in one tab move the other.
    pub live_replay_columns: Vec<u32>,
    /// The live-replay table's columns in the order they are drawn, as indexes
    /// into the designed order. Empty is the designed order; anything that is
    /// not exactly one of each column is dropped to empty.
    pub live_replay_order: Vec<u32>,
    /// And for the co-op leaderboard.
    pub coop_board_columns: Vec<u32>,
    /// And for the matchmaker tab's recent games (#301).
    pub matchmaker_recent_columns: Vec<u32>,
    /// The recent games' columns in the order they are drawn, the same way.
    pub matchmaker_recent_order: Vec<u32>,
    /// And for the party invite dialog's player list.
    pub matchmaker_invite_columns: Vec<u32>,
    /// The invite list's columns in the order they are drawn, the same way.
    pub matchmaker_invite_order: Vec<u32>,
    /// Named mod sets the host dialog can re-apply in one click.
    ///
    /// Only the word is shared with `mod_vault_preset` above, which is a vault
    /// *filter*. These are the user's own saved selections.
    pub mod_presets: Vec<ModPreset>,
    /// Visible column keys in the rating leaderboard table.
    pub leaderboard_rating_columns: Vec<String>,
    /// Whether the rating leaderboard's player search also matches names a
    /// player used to go by (#424).
    ///
    /// Off for a fresh install, because it turns a lookup into a list of
    /// candidates, but a way of searching rather than a fact about one search:
    /// somebody who ticks it ticks it every time, and the box reset itself
    /// whenever the tab was opened again.
    pub leaderboard_include_former_names: bool,
    /// Last searched player username in the replay vault. When empty, defaults
    /// to the currently authenticated player name.
    pub replay_vault_player: String,
    /// The channel a replay's chat log is filtered to: `all`, `allies`, or
    /// empty for every channel.
    ///
    /// Remembered across replays because it is a way of reading chat, not a
    /// fact about one game. A whisper is not kept: its channel is an army
    /// number, which names a different player in every game.
    pub replay_chat_channel: String,
    /// What a replay's chat log shows of the sharing lines.
    pub replay_chat_transfers: ReplayChatTransfers,
    /// Set after the webview has offered its pre-0.2 browser-storage values to
    /// the backend. Kept in the settings file so the compatibility read really
    /// is one-time and the old keys can be removed on a later confirmed load.
    pub legacy_storage_migrated: bool,
    /// The filters of the lists that keep theirs in the webview, by list, each
    /// one a JSON document only that list reads (#447).
    ///
    /// Only written while `GeneralPreferences::filter_memory` is `Restart`,
    /// and emptied at startup otherwise. The lists whose filters were stored
    /// before this existed keep their own fields above; this is for the rest,
    /// so a new list does not need a new field and a new binding to be
    /// remembered across a restart.
    pub remembered_filters: BTreeMap<String, String>,
}

pub const DEFAULT_LEADERBOARD_RATING_COLUMNS: [&str; 2] = ["games", "updated"];
/// The columns the table can draw beside the boards themselves, in the order
/// it draws them.
///
/// Three names have left this list. Win rate and won games, because the API
/// counts won games over a different set of games than it counts played ones:
/// the quotient was wrong and so is the count, and a column that cannot be
/// correct is worse than no column. Rating, because every board has a column of
/// its own now, the ranked one included, so a "Rating" column would be one of
/// them printed twice.
///
/// A stored selection naming any of the three is dropped by the filter below,
/// the way any other unknown key is, so nothing has to migrate.
pub const VALID_LEADERBOARD_RATING_COLUMNS: [&str; 4] = ["mean", "deviation", "games", "updated"];

impl Default for BrowsingPreferences {
    fn default() -> Self {
        Self {
            // Tiles for a fresh install in the Play and the replay tabs, the
            // list for live games, which is a table of what is being played
            // right now and read as one. A saved choice wins.
            custom_games_view: CustomGameView::Tiles,
            replays_view: CustomGameView::Tiles,
            live_replay_view: CustomGameView::List,
            custom_games_browser: CustomGameBrowserPreferences::default(),
            matchmaker_unselected_queues: Vec::new(),
            matchmaker_factions: MATCHMAKER_FACTIONS
                .iter()
                .map(|faction| (*faction).to_owned())
                .collect(),
            matchmaker_chat_width: 0,
            live_replay_filters: LiveReplayFilters::default(),
            host_game: HostGamePreferences::default(),
            host_coop: HostGamePreferences::default(),
            favorite_maps: Vec::new(),
            favorite_mods: Vec::new(),
            whitelisted_hosts: Vec::new(),
            map_vault_preset: "recommended".into(),
            mod_vault_preset: "recommended".into(),
            map_vault_sort: String::new(),
            mod_vault_sort: String::new(),
            vault_page_size: 0,
            replay_list_columns: Vec::new(),
            replay_list_order: Vec::new(),
            live_replay_columns: Vec::new(),
            live_replay_order: Vec::new(),
            coop_board_columns: Vec::new(),
            matchmaker_recent_columns: Vec::new(),
            matchmaker_recent_order: Vec::new(),
            matchmaker_invite_columns: Vec::new(),
            matchmaker_invite_order: Vec::new(),
            mod_presets: Vec::new(),
            leaderboard_rating_columns: DEFAULT_LEADERBOARD_RATING_COLUMNS
                .iter()
                .map(|col| (*col).to_owned())
                .collect(),
            leaderboard_include_former_names: false,
            replay_vault_player: String::new(),
            replay_chat_channel: String::new(),
            replay_chat_transfers: ReplayChatTransfers::Show,
            legacy_storage_migrated: false,
            remembered_filters: BTreeMap::new(),
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
            #[serde(default)]
            live_replay_view: CustomGameView,
            custom_games_browser: CustomGameBrowserPreferences,
            matchmaker_unselected_queues: Vec<String>,
            matchmaker_factions: Vec<String>,
            #[serde(default)]
            matchmaker_chat_width: u32,
            live_replay_filters: LiveReplayFilters,
            host_game: HostGamePreferences,
            host_coop: HostGamePreferences,
            favorite_maps: Vec<String>,
            favorite_mods: Vec<String>,
            whitelisted_hosts: Vec<String>,
            map_vault_preset: String,
            mod_vault_preset: String,
            map_vault_sort: String,
            mod_vault_sort: String,
            vault_page_size: u32,
            #[serde(default)]
            replay_list_columns: Vec<u32>,
            #[serde(default)]
            replay_list_order: Vec<u32>,
            #[serde(default)]
            live_replay_columns: Vec<u32>,
            #[serde(default)]
            live_replay_order: Vec<u32>,
            #[serde(default)]
            coop_board_columns: Vec<u32>,
            matchmaker_recent_columns: Vec<u32>,
            #[serde(default)]
            matchmaker_recent_order: Vec<u32>,
            matchmaker_invite_columns: Vec<u32>,
            #[serde(default)]
            matchmaker_invite_order: Vec<u32>,
            mod_presets: Vec<ModPreset>,
            leaderboard_rating_columns: Vec<String>,
            #[serde(default)]
            leaderboard_include_former_names: bool,
            replay_vault_player: String,
            #[serde(default)]
            replay_chat_channel: String,
            #[serde(default)]
            replay_chat_transfers: ReplayChatTransfers,
            legacy_storage_migrated: bool,
            #[serde(default)]
            remembered_filters: BTreeMap<String, String>,
        }

        impl Default for Wire {
            fn default() -> Self {
                let defaults = BrowsingPreferences::default();
                Self {
                    custom_games_view: defaults.custom_games_view,
                    replays_view: defaults.replays_view,
                    live_replay_view: defaults.live_replay_view,
                    custom_games_browser: defaults.custom_games_browser,
                    matchmaker_unselected_queues: defaults.matchmaker_unselected_queues,
                    matchmaker_factions: defaults.matchmaker_factions,
                    matchmaker_chat_width: defaults.matchmaker_chat_width,
                    live_replay_filters: defaults.live_replay_filters,
                    host_game: defaults.host_game,
                    host_coop: defaults.host_coop,
                    favorite_maps: defaults.favorite_maps,
                    favorite_mods: defaults.favorite_mods,
                    whitelisted_hosts: defaults.whitelisted_hosts,
                    map_vault_preset: defaults.map_vault_preset,
                    mod_vault_preset: defaults.mod_vault_preset,
                    map_vault_sort: defaults.map_vault_sort,
                    mod_vault_sort: defaults.mod_vault_sort,
                    vault_page_size: defaults.vault_page_size,
                    replay_list_columns: defaults.replay_list_columns,
                    replay_list_order: defaults.replay_list_order,
                    live_replay_columns: defaults.live_replay_columns,
                    live_replay_order: defaults.live_replay_order,
                    coop_board_columns: defaults.coop_board_columns,
                    matchmaker_recent_columns: defaults.matchmaker_recent_columns,
                    matchmaker_recent_order: defaults.matchmaker_recent_order,
                    matchmaker_invite_columns: defaults.matchmaker_invite_columns,
                    matchmaker_invite_order: defaults.matchmaker_invite_order,
                    mod_presets: defaults.mod_presets,
                    leaderboard_rating_columns: defaults.leaderboard_rating_columns,
                    leaderboard_include_former_names: defaults.leaderboard_include_former_names,
                    replay_vault_player: defaults.replay_vault_player,
                    replay_chat_channel: defaults.replay_chat_channel,
                    replay_chat_transfers: defaults.replay_chat_transfers,
                    legacy_storage_migrated: defaults.legacy_storage_migrated,
                    remembered_filters: defaults.remembered_filters,
                }
            }
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            custom_games_view: wire.custom_games_view,
            replays_view: wire.replays_view,
            live_replay_view: wire.live_replay_view,
            custom_games_browser: wire.custom_games_browser,
            matchmaker_unselected_queues: wire.matchmaker_unselected_queues,
            matchmaker_factions: wire.matchmaker_factions,
            matchmaker_chat_width: wire.matchmaker_chat_width,
            live_replay_filters: wire.live_replay_filters,
            host_game: wire.host_game,
            host_coop: wire.host_coop,
            favorite_maps: wire.favorite_maps,
            favorite_mods: wire.favorite_mods,
            whitelisted_hosts: wire.whitelisted_hosts,
            map_vault_preset: wire.map_vault_preset,
            mod_vault_preset: wire.mod_vault_preset,
            map_vault_sort: wire.map_vault_sort,
            mod_vault_sort: wire.mod_vault_sort,
            vault_page_size: wire.vault_page_size,
            replay_list_columns: wire.replay_list_columns,
            replay_list_order: wire.replay_list_order,
            live_replay_columns: wire.live_replay_columns,
            live_replay_order: wire.live_replay_order,
            coop_board_columns: wire.coop_board_columns,
            matchmaker_recent_columns: wire.matchmaker_recent_columns,
            matchmaker_recent_order: wire.matchmaker_recent_order,
            matchmaker_invite_columns: wire.matchmaker_invite_columns,
            matchmaker_invite_order: wire.matchmaker_invite_order,
            mod_presets: wire.mod_presets,
            leaderboard_rating_columns: wire.leaderboard_rating_columns,
            leaderboard_include_former_names: wire.leaderboard_include_former_names,
            replay_vault_player: wire.replay_vault_player,
            replay_chat_channel: wire.replay_chat_channel,
            replay_chat_transfers: wire.replay_chat_transfers,
            legacy_storage_migrated: wire.legacy_storage_migrated,
            remembered_filters: wire.remembered_filters,
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
    pub(super) fn normalized(mut self) -> Self {
        self.custom_games_browser = self.custom_games_browser.normalized();
        self.map_vault_sort = truncate_trimmed(self.map_vault_sort, 32);
        self.mod_vault_sort = truncate_trimmed(self.mod_vault_sort, 32);
        if self.vault_page_size != 0 {
            self.vault_page_size = self
                .vault_page_size
                .clamp(MIN_VAULT_PAGE_SIZE, MAX_VAULT_PAGE_SIZE);
        }
        self.matchmaker_unselected_queues =
            normalize_labels(self.matchmaker_unselected_queues, 64, 128);
        if self.matchmaker_chat_width != 0 {
            self.matchmaker_chat_width = self
                .matchmaker_chat_width
                .clamp(MIN_PARTY_CHAT_PX, MAX_PARTY_CHAT_PX);
        }
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
        // Room for several choices: these hold comma-separated lists now.
        self.live_replay_filters.game_type =
            truncate_trimmed(self.live_replay_filters.game_type, 256);
        self.live_replay_filters.featured_mod =
            truncate_trimmed(self.live_replay_filters.featured_mod, 512);
        self.live_replay_filters.active_players =
            normalize_player_count(self.live_replay_filters.active_players);
        self.live_replay_filters.max_players =
            normalize_player_count(self.live_replay_filters.max_players);
        self.host_game = self.host_game.normalized();
        self.host_coop = self.host_coop.normalized();
        self.favorite_maps = normalize_labels(self.favorite_maps, 512, 256)
            .into_iter()
            .map(|folder| folder.to_ascii_lowercase())
            .collect();
        self.favorite_mods = normalize_labels(self.favorite_mods, 512, 256)
            .into_iter()
            .map(|uid| uid.to_ascii_lowercase())
            .collect();
        self.whitelisted_hosts = normalize_logins(self.whitelisted_hosts, 256);
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
            "favorites" => "favorites".into(),
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
        self.replay_vault_player = truncate_trimmed(self.replay_vault_player, 64);
        self.replay_chat_channel = match self
            .replay_chat_channel
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "all" => "all".into(),
            "allies" => "allies".into(),
            _ => String::new(),
        };
        self.replay_list_columns = normalize_column_widths(self.replay_list_columns);
        self.replay_list_order = normalize_column_order(self.replay_list_order);
        self.live_replay_columns = normalize_column_widths(self.live_replay_columns);
        self.live_replay_order = normalize_column_order(self.live_replay_order);
        self.coop_board_columns = normalize_column_widths(self.coop_board_columns);
        self.matchmaker_recent_columns = normalize_column_widths(self.matchmaker_recent_columns);
        self.matchmaker_recent_order = normalize_column_order(self.matchmaker_recent_order);
        self.matchmaker_invite_columns = normalize_column_widths(self.matchmaker_invite_columns);
        self.matchmaker_invite_order = normalize_column_order(self.matchmaker_invite_order);
        self.remembered_filters = normalize_remembered_filters(self.remembered_filters);
        self
    }

    /// The same preferences with every filter back at its default (#447).
    ///
    /// What `FilterMemory` calls a filter: whatever narrows a list. The game
    /// browser's switches and rules, the live replay filters, the vault
    /// presets and the replay vault's player, and every list's entry in
    /// `remembered_filters`. Sort orders, columns, views and favourites are
    /// not filters and are left exactly as they were.
    pub fn without_filters(mut self) -> Self {
        let defaults = Self::default();
        let browser = &mut self.custom_games_browser;
        browser.hide_private = defaults.custom_games_browser.hide_private;
        browser.hide_modded = defaults.custom_games_browser.hide_modded;
        browser.hide_unranked = defaults.custom_games_browser.hide_unranked;
        browser.hide_foes = defaults.custom_games_browser.hide_foes;
        browser.apply_filters = defaults.custom_games_browser.apply_filters;
        browser.rules = defaults.custom_games_browser.rules;
        self.live_replay_filters = defaults.live_replay_filters;
        self.map_vault_preset = defaults.map_vault_preset;
        self.mod_vault_preset = defaults.mod_vault_preset;
        self.replay_vault_player = defaults.replay_vault_player;
        self.remembered_filters = defaults.remembered_filters;
        self
    }
}

/// Bounds on the webview's stored filters, against a corrupt or hand-edited
/// file. Far more lists than the client has, and far longer documents than
/// any filter writes.
const MAX_REMEMBERED_FILTER_LISTS: usize = 64;
const MAX_REMEMBERED_FILTER_KEY_CHARS: usize = 64;
const MAX_REMEMBERED_FILTER_CHARS: usize = 8 * 1024;

/// A list whose key or document is past the bounds is dropped whole rather
/// than cut: half a JSON document is not a filter.
fn normalize_remembered_filters(filters: BTreeMap<String, String>) -> BTreeMap<String, String> {
    filters
        .into_iter()
        .filter(|(key, value)| {
            !key.trim().is_empty()
                && key.chars().count() <= MAX_REMEMBERED_FILTER_KEY_CHARS
                && value.chars().count() <= MAX_REMEMBERED_FILTER_CHARS
        })
        .take(MAX_REMEMBERED_FILTER_LISTS)
        .collect()
}

/// Column widths as a settings file may hold them.
///
/// A zero is left alone: it is how a table says "this one keeps its designed
/// width", and clamping it up to the minimum would silently turn an unset
/// column into a narrow one. Everything else is bounded, against a corrupt or
/// hand-edited file rather than against anything a drag can produce.
fn normalize_column_widths(mut widths: Vec<u32>) -> Vec<u32> {
    widths.truncate(MAX_TABLE_COLUMNS);
    widths
}

/// A table's column order as a settings file may hold it: exactly one of each
/// column from zero up, or nothing. A half-valid order has no obvious meaning,
/// so it is dropped to the designed one rather than repaired.
fn normalize_column_order(order: Vec<u32>) -> Vec<u32> {
    let mut sorted = order.clone();
    sorted.sort_unstable();
    if order.len() <= MAX_TABLE_COLUMNS && sorted.iter().copied().eq(0..order.len() as u32) {
        order
    } else {
        Vec::new()
    }
}

preference_patch! {
    /// A change to [`BrowsingPreferences`], the group with the most writers:
    /// nearly every list, vault and lobby view remembers something here.
    BrowsingPreferencesPatch for BrowsingPreferences {
        custom_games_view: CustomGameView,
        replays_view: CustomGameView,
        live_replay_view: CustomGameView,
        matchmaker_unselected_queues: Vec<String>,
        matchmaker_factions: Vec<String>,
        matchmaker_chat_width: u32,
        favorite_maps: Vec<String>,
        favorite_mods: Vec<String>,
        whitelisted_hosts: Vec<String>,
        map_vault_preset: String,
        mod_vault_preset: String,
        map_vault_sort: String,
        mod_vault_sort: String,
        vault_page_size: u32,
        replay_list_columns: Vec<u32>,
        replay_list_order: Vec<u32>,
        live_replay_columns: Vec<u32>,
        live_replay_order: Vec<u32>,
        coop_board_columns: Vec<u32>,
        matchmaker_recent_columns: Vec<u32>,
        matchmaker_recent_order: Vec<u32>,
        matchmaker_invite_columns: Vec<u32>,
        matchmaker_invite_order: Vec<u32>,
        mod_presets: Vec<ModPreset>,
        leaderboard_rating_columns: Vec<String>,
        leaderboard_include_former_names: bool,
        replay_vault_player: String,
        replay_chat_channel: String,
        replay_chat_transfers: ReplayChatTransfers,
        legacy_storage_migrated: bool,
        remembered_filters: BTreeMap<String, String>,
    }
    nested {
        custom_games_browser: CustomGameBrowserPreferencesPatch,
        live_replay_filters: LiveReplayFiltersPatch,
        host_game: HostGamePreferencesPatch,
        host_coop: HostGamePreferencesPatch,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browsing_preferences_are_normalized_at_the_state_boundary() {
        let settings = SettingsState {
            browsing: BrowsingPreferences {
                custom_games_view: CustomGameView::List,
                replays_view: CustomGameView::List,
                live_replay_view: CustomGameView::Tiles,
                custom_games_browser: CustomGameBrowserPreferences {
                    sort: CustomGameSort::Host,
                    sort_reversed: true,
                    hide_private: true,
                    hide_modded: true,
                    hide_unranked: true,
                    hide_foes: true,
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
                    // Out of bounds in both directions, plus a seventh column
                    // the list does not have.
                    column_widths: vec![10, 5_000, 200, 200, 200, 200, 200],
                    // A column twice and one missing: not an order.
                    column_order: vec![0, 0, 2, 3, 4, 5],
                    detail_width: 40,
                    detail_hidden: false,
                },
                matchmaker_unselected_queues: vec![
                    "  ladder_1v1  ".into(),
                    "LADDER_1V1".into(),
                    String::new(),
                ],
                matchmaker_factions: vec!["cybran".into(), "unknown".into()],
                // Below the floor, so the clamp has something to do.
                matchmaker_chat_width: 40,
                live_replay_filters: LiveReplayFilters {
                    search: format!("  {}  ", "x".repeat(250)),
                    game_type: "  matchmaker  ".into(),
                    featured_mod: " faf ".into(),
                    active_players: "04".into(),
                    max_players: "999".into(),
                    hide_modded: true,
                    hide_single_player: false,
                    hide_unranked: true,
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
                    rating_min: Some(1_500),
                    rating_max: Some(800),
                },
                host_coop: HostGamePreferences {
                    title: "  Operation Ivy  ".into(),
                    featured_mod: "coop".into(),
                    visibility: "public".into(),
                    map: "  SCCA_Coop_A03.v0023  ".into(),
                    password_enabled: false,
                    password: String::new(),
                    enforce_rating_range: false,
                    rating_min: None,
                    rating_max: Some(1_500),
                },
                favorite_maps: vec![
                    "  Adaptive_Tabula.v0006  ".into(),
                    "adaptive_tabula.v0006".into(),
                    String::new(),
                ],
                favorite_mods: vec!["  Eco_Graph  ".into(), "eco_graph".into(), String::new()],
                whitelisted_hosts: Vec::new(),
                map_vault_preset: "  NEWEST  ".into(),
                map_vault_sort: "  newest  ".into(),
                mod_vault_sort: String::new(),
                vault_page_size: 5_000,
                // Out of bounds, and a zero, which is how a column says it
                // keeps its designed width.
                replay_list_columns: vec![10, 200, 0, 9_999],
                replay_list_order: Vec::new(),
                live_replay_columns: vec![1; 40],
                live_replay_order: Vec::new(),
                coop_board_columns: Vec::new(),
                matchmaker_recent_columns: Vec::new(),
                matchmaker_recent_order: Vec::new(),
                matchmaker_invite_columns: Vec::new(),
                matchmaker_invite_order: Vec::new(),
                mod_vault_preset: "  UI  ".into(),
                mod_presets: Vec::new(),
                leaderboard_rating_columns: vec![
                    "deviation".into(),
                    "MEAN".into(),
                    "invalid_col".into(),
                ],
                leaderboard_include_former_names: true,
                replay_vault_player: "  VindexNoob  ".into(),
                replay_chat_channel: "  ALLIES  ".into(),
                replay_chat_transfers: ReplayChatTransfers::Hide,
                legacy_storage_migrated: true,
                remembered_filters: BTreeMap::new(),
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
        assert!(settings.browsing.custom_games_browser.hide_foes);
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
        assert_eq!(settings.browsing.host_coop.title, "Operation Ivy");
        assert_eq!(settings.browsing.host_coop.map, "SCCA_Coop_A03.v0023");
        assert_eq!(settings.browsing.host_game.featured_mod, "faf");
        assert_eq!(settings.browsing.host_game.visibility, "friends");
        assert_eq!(settings.browsing.host_game.map, "scmp_009");
        assert_eq!(settings.browsing.host_game.password, "  secret  ");
        assert_eq!(settings.browsing.host_game.rating_min, Some(800));
        assert_eq!(settings.browsing.host_game.rating_max, Some(1_500));
        // An open end is kept open, not filled in with a default.
        assert_eq!(settings.browsing.host_coop.rating_min, None);
        assert_eq!(settings.browsing.host_coop.rating_max, Some(1_500));
        assert_eq!(settings.browsing.favorite_maps, ["adaptive_tabula.v0006"]);
        assert_eq!(settings.browsing.favorite_mods, ["eco_graph"]);
        assert_eq!(
            settings.browsing.replay_list_columns,
            [10, 200, 0, 9_999],
            "every width is kept as it was dragged: a zero still means unset,              and there is no floor or ceiling left to bound the rest against"
        );
        assert_eq!(
            settings.browsing.live_replay_columns.len(),
            MAX_TABLE_COLUMNS,
            "a file cannot describe more columns than the client draws"
        );
        assert_eq!(settings.browsing.map_vault_preset, "newest");
        assert_eq!(settings.browsing.mod_vault_preset, "ui");
        assert_eq!(settings.browsing.map_vault_sort, "newest");
        assert_eq!(
            settings.browsing.vault_page_size, MAX_VAULT_PAGE_SIZE,
            "a page size out of a hand-edited file is clamped, not obeyed"
        );
        let browser = &settings.browsing.custom_games_browser;
        assert_eq!(
            browser.column_widths,
            [10, 5_000, 200, 200, 200, 200],
            "six columns at whatever width they were dragged to, narrow or wide"
        );
        assert!(
            browser.column_order.is_empty(),
            "an order that is not one of each column is dropped"
        );
        assert_eq!(browser.detail_width, MIN_DETAIL_PX);
        assert_eq!(
            settings.browsing.leaderboard_rating_columns,
            ["mean", "deviation"],
            "kept in the order the table draws them, whatever order the file listed"
        );
        assert_eq!(settings.browsing.replay_vault_player, "VindexNoob");
        assert_eq!(settings.browsing.replay_chat_channel, "allies");
        assert_eq!(
            settings.browsing.replay_chat_transfers,
            ReplayChatTransfers::Hide
        );
        assert!(settings.browsing.legacy_storage_migrated);
    }

    #[test]
    fn a_whispers_channel_is_not_remembered_across_replays() {
        // An army number names a different player in every game.
        let mut settings = SettingsState::default();
        settings.browsing.replay_chat_channel = "3".into();
        assert!(settings
            .normalized()
            .browsing
            .replay_chat_channel
            .is_empty());
    }

    #[test]
    fn a_settings_file_from_before_the_chat_filters_reads_as_show_everything() {
        let browsing: BrowsingPreferences = serde_json::from_str("{}").unwrap();
        assert!(browsing.replay_chat_channel.is_empty());
        assert_eq!(browsing.replay_chat_transfers, ReplayChatTransfers::Show);
    }

    #[test]
    fn the_former_names_search_is_off_until_ticked_and_then_remembered() {
        // A settings file from before #424 searches current names only.
        let browsing: BrowsingPreferences = serde_json::from_str("{}").unwrap();
        assert!(!browsing.leaderboard_include_former_names);

        // The leaderboard sends the box alone; nothing else in the group moves.
        let patch: BrowsingPreferencesPatch =
            serde_json::from_str(r#"{"leaderboardIncludeFormerNames":true}"#).unwrap();
        let ticked = patch.apply_to(BrowsingPreferences::default());
        assert!(ticked.leaderboard_include_former_names);
        assert_eq!(
            BrowsingPreferences {
                leaderboard_include_former_names: false,
                ..ticked.clone()
            },
            BrowsingPreferences::default()
        );

        // And it survives the round trip through the settings file.
        let stored = serde_json::to_string(&ticked).unwrap();
        let reloaded: BrowsingPreferences = serde_json::from_str(&stored).unwrap();
        assert!(reloaded.leaderboard_include_former_names);
    }

    #[test]
    fn without_filters_clears_what_narrows_a_list_and_nothing_else() {
        let mut browsing = BrowsingPreferences::default();
        browsing.custom_games_browser.hide_private = true;
        browsing.custom_games_browser.apply_filters = true;
        browsing.custom_games_browser.rules = vec![CustomGameFilterRule {
            field: CustomGameFilterField::Map,
            constraint: CustomGameFilterConstraint::Contains,
            value: "seton".into(),
        }];
        browsing.custom_games_browser.sort_reversed = true;
        browsing.custom_games_browser.column_widths = vec![200];
        browsing.live_replay_filters.search = "1500+".into();
        browsing.map_vault_preset = "favorites".into();
        browsing.map_vault_sort = "rating".into();
        browsing.replay_vault_player = "Dog".into();
        browsing.favorite_maps = vec!["setons_clutch".into()];
        browsing.whitelisted_hosts = vec!["Nuggets".into()];
        browsing
            .remembered_filters
            .insert("installedMods".into(), r#"{"search":"ui"}"#.into());

        let cleared = browsing.without_filters();

        assert!(!cleared.custom_games_browser.hide_private);
        assert!(!cleared.custom_games_browser.apply_filters);
        assert!(cleared.custom_games_browser.rules.is_empty());
        assert_eq!(cleared.live_replay_filters, LiveReplayFilters::default());
        assert_eq!(cleared.map_vault_preset, "recommended");
        assert!(cleared.replay_vault_player.is_empty());
        assert!(cleared.remembered_filters.is_empty());
        // How the lists are sorted and laid out is not a filter.
        assert!(cleared.custom_games_browser.sort_reversed);
        assert_eq!(cleared.custom_games_browser.column_widths, vec![200]);
        assert_eq!(cleared.map_vault_sort, "rating");
        // Nor are the hosts always shown: they narrow nothing.
        assert_eq!(cleared.whitelisted_hosts, ["Nuggets"]);
        assert_eq!(cleared.favorite_maps, vec!["setons_clutch".to_owned()]);
    }

    #[test]
    fn remembered_filters_drop_what_a_list_could_not_have_written() {
        let mut filters = BTreeMap::new();
        filters.insert("maps".into(), "{}".into());
        filters.insert(" ".into(), "{}".into());
        filters.insert("x".repeat(65), "{}".into());
        filters.insert("huge".into(), "x".repeat(8 * 1024 + 1));
        let normalized = normalize_remembered_filters(filters);
        assert_eq!(normalized.keys().collect::<Vec<_>>(), vec!["maps"]);
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
}
