//! [`SettingsState`] itself: every group together as it is persisted, how an
//! older settings file is read, and the bounds the whole is held to.

use super::*;

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CachedGameVersion {
    pub name: String,
    pub version: i32,
    pub file_count: u32,
    pub size_bytes: f64,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GameCacheInfo {
    pub total_size_bytes: f64,
    pub total_files: u32,
    pub versions: Vec<CachedGameVersion>,
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
    pub paths: PathPreferences,
    pub general: GeneralPreferences,
    pub appearance: AppearancePreferences,
    pub social: SocialPreferences,
    pub notifications: NotificationPreferences,
    pub chat: ChatPreferences,
    pub game: GamePreferences,
    pub discord: DiscordPreferences,
    pub connectivity: ConnectivityPreferences,
    pub debug: DebugPreferences,
    pub updates: UpdatePreferences,
    pub browsing: BrowsingPreferences,
    pub events: EventsPreferences,
    /// Generated maps the user asked to keep, by folder name.
    ///
    /// Written when a run finishes with [`GeneratorOptions::keep_maps`] set,
    /// and read by the Maps tab's sweep, which spares everything named here.
    /// Persisted rather than derived because nothing on disk distinguishes a
    /// map somebody wants from one they generated once and forgot.
    #[serde(default)]
    pub kept_generated_maps: Vec<String>,
    /// The map generator dialog's last settings.
    ///
    /// Persisted for the same reason the Java client keeps `GeneratorPrefs`:
    /// choosing a size, spawn count and half a dozen styles is real work, and
    /// having it survive a restart is the difference between the dialog being
    /// configured once and being configured every time.
    pub map_generator: GeneratorOptions,
    /// The matchmaker map vetoes this account last saved.
    ///
    /// Kept here because the server does not keep them. A player's vetoes live
    /// on their `Player` object for the life of the session and are gone the
    /// moment they log out: there is no table behind them and no command to
    /// read them back, so a client that only listens is a client whose vetoes
    /// are always empty at login, which is the report.
    ///
    /// So the client remembers what it sent and sends it again once the lobby
    /// authenticates. The server validates and caps the selection against the
    /// current pools exactly as it does for a fresh one, and tells us when it
    /// had to adjust it, so a pool that changed between sessions corrects
    /// itself rather than being replayed wrong forever.
    #[serde(default)]
    pub matchmaker_vetoes: Vec<PlayerVeto>,
    /// The map pools each matchmaker queue had when the client last looked,
    /// so a new one can be announced (#406). Nothing else in FAF says that a
    /// pool changed: the client compares what it is served with this.
    #[serde(default)]
    pub map_pools_seen: Vec<MapPoolsSeen>,
    /// The avatars this account was seen choosing, newest first; an empty
    /// string is a choice of none. When the newest stops being allowed (a
    /// tournament avatar rotating to the next winner), the client selects the
    /// most recent one that still is. See `lobby::reconcile_avatar`.
    #[serde(default)]
    pub avatar_history: Vec<String>,
    #[serde(default)]
    pub cache_info: GameCacheInfo,
}

/// The queues whose map pools changed since they were last seen. A queue seen
/// for the first time is not news: it is how every queue starts, and
/// announcing all of them on the first login after an update would be noise.
pub fn changed_map_pools(seen: &[MapPoolsSeen], current: &[MapPoolsSeen]) -> Vec<String> {
    current
        .iter()
        .filter(|now| {
            seen.iter()
                .find(|before| before.queue_name == now.queue_name)
                .is_some_and(|before| before.assignments != now.assignments)
        })
        .map(|now| now.queue_name.clone())
        .collect()
}

/// One queue's map pools as last seen: the pool-map assignment ids of all its
/// brackets, sorted. A new release changes them whether it reuses the pool or
/// brings a new one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MapPoolsSeen {
    pub queue_name: String,
    pub assignments: Vec<i32>,
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
            paths: PathPreferences,
            general: GeneralPreferences,
            appearance: AppearancePreferences,
            social: SocialPreferences,
            notifications: NotificationPreferences,
            chat: ChatPreferences,
            game: GamePreferences,
            discord: DiscordPreferences,
            connectivity: ConnectivityPreferences,
            debug: DebugPreferences,
            updates: UpdatePreferences,
            browsing: BrowsingPreferences,
            events: EventsPreferences,
            kept_generated_maps: Vec<String>,
            map_generator: GeneratorOptions,
            matchmaker_vetoes: Vec<PlayerVeto>,
            map_pools_seen: Vec<MapPoolsSeen>,
            avatar_history: Vec<String>,
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            theme: wire.theme,
            game_path: wire.game_path,
            replay_game_path: wire.replay_game_path,
            paths: wire.paths,
            general: wire.general,
            appearance: wire.appearance,
            social: wire.social,
            notifications: wire.notifications,
            chat: wire.chat,
            game: wire.game,
            discord: wire.discord,
            connectivity: wire.connectivity,
            debug: wire.debug,
            updates: wire.updates,
            browsing: wire.browsing,
            events: wire.events,
            kept_generated_maps: wire.kept_generated_maps,
            map_generator: wire.map_generator,
            matchmaker_vetoes: wire.matchmaker_vetoes,
            map_pools_seen: wire.map_pools_seen,
            avatar_history: wire.avatar_history,
            cache_info: GameCacheInfo::default(),
        })
    }
}

impl SettingsState {
    pub fn normalized(mut self) -> Self {
        self.chat = self.chat.normalized();
        self.social = self.social.normalized();
        self.notifications = self.notifications.normalized();
        self.game = self.game.normalized();
        self.paths = self.paths.normalized();
        self.browsing = self.browsing.normalized();
        self.appearance = self.appearance.normalized();
        // Zero: pruning by the clock is the persistence boundary's job, which
        // is where the clock is. Normalising only deduplicates here.
        self.events = self.events.pruned(0);
        // After `game`, so a hand-edited limit is already bounded when the
        // list is measured against it.
        self.trim_kept_generated_maps();
        self
    }

    /// Drop the oldest kept maps until the list fits the limit.
    ///
    /// A no-op when the limit is `0`, which is what "keep them all" is spelled
    /// as: a cap of zero would mean the switch above keeps nothing, and there
    /// is already a switch for that.
    pub fn trim_kept_generated_maps(&mut self) {
        let limit = self.game.keep_generated_maps_limit as usize;
        if limit == 0 || self.kept_generated_maps.len() <= limit {
            return;
        }
        let excess = self.kept_generated_maps.len() - limit;
        self.kept_generated_maps.drain(..excess);
    }
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
        assert_eq!(settings.browsing.live_replay_view, CustomGameView::List);
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
    fn a_settings_file_written_before_vetoes_were_kept_reads_as_none() {
        let settings: SettingsState = serde_json::from_str(r#"{"theme":"forgeDark"}"#).unwrap();
        assert!(settings.matchmaker_vetoes.is_empty());
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

    /// #406: a changed pool is news, a queue seen for the first time is not.
    #[test]
    fn only_a_pool_that_changed_is_announced() {
        let seen = |queue: &str, assignments: &[i32]| MapPoolsSeen {
            queue_name: queue.into(),
            assignments: assignments.to_vec(),
        };
        let before = vec![seen("ladder1v1", &[1, 2, 3]), seen("tmm2v2", &[4, 5])];
        let now = vec![
            seen("ladder1v1", &[1, 2, 7]),
            seen("tmm2v2", &[4, 5]),
            seen("tmm4v4_full_share", &[9]),
        ];
        assert_eq!(
            changed_map_pools(&before, &now),
            vec!["ladder1v1".to_string()]
        );
        assert!(changed_map_pools(&[], &now).is_empty());
    }
}
