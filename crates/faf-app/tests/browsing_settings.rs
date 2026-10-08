//! Browsing preferences must cross the command loop and reach persistence.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::SettingsPort;
use faf_app::{App, Ports};
use faf_domain::state::{
    BrowsingPreferences, CustomGameBrowserPreferences, CustomGameFilterConstraint,
    CustomGameFilterField, CustomGameFilterRule, CustomGameSort, CustomGameView, FilterMemory,
    HostGamePreferences, LiveReplayFilters, ReplayChatTransfers, SettingsCommand, SettingsState,
};

#[derive(Default)]
struct RecordingSettings {
    saved: Arc<Mutex<Vec<SettingsState>>>,
}

#[async_trait]
impl SettingsPort for RecordingSettings {
    async fn load(&self) -> SettingsState {
        SettingsState {
            // Off, so the startup cache pass this test has to run cannot sweep
            // the real game-files cache on whoever is running the suite. The
            // measuring half only reads. See `cache_dir` in `infra`, which is
            // not injectable.
            game: faf_domain::state::GamePreferences {
                cache_lifetime_days: None,
                ..faf_domain::state::GamePreferences::default()
            },
            ..SettingsState::default()
        }
    }

    async fn save(&self, settings: &SettingsState) -> Result<(), String> {
        self.saved.lock().unwrap().push(settings.clone());
        Ok(())
    }
}

#[tokio::test]
async fn browsing_preferences_are_normalized_reduced_and_persisted() {
    let saved = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        settings: Arc::new(RecordingSettings {
            saved: saved.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());

    // The settings file has to have been read before anything may be written
    // back over it, so the startup load comes first here as it does in the
    // client. See `crates/faf-app/tests/settings_startup.rs`.
    app.dispatch_and_wait(SettingsCommand::Load.into())
        .await
        .unwrap();
    saved.lock().unwrap().clear();

    app.dispatch(
        SettingsCommand::PatchBrowsing {
            patch: Box::new(
                BrowsingPreferences {
                    custom_games_view: CustomGameView::List,
                    replays_view: CustomGameView::List,
                    live_replay_view: CustomGameView::List,
                    custom_games_browser: CustomGameBrowserPreferences {
                        sort: CustomGameSort::Age,
                        sort_reversed: false,
                        hide_private: true,
                        hide_modded: false,
                        hide_unranked: false,
                        hide_foes: false,
                        apply_filters: true,
                        rules: vec![CustomGameFilterRule {
                            field: CustomGameFilterField::Map,
                            constraint: CustomGameFilterConstraint::Contains,
                            value: "  gap  ".into(),
                        }],
                        column_widths: Vec::new(),
                        column_order: Vec::new(),
                        detail_width: 0,
                        detail_hidden: false,
                    },
                    matchmaker_unselected_queues: vec!["  ladder_1v1 ".into()],
                    matchmaker_factions: vec!["cybran".into()],
                    matchmaker_chat_width: 0,
                    live_replay_filters: LiveReplayFilters {
                        search: "  tournament  ".into(),
                        active_players: "04".into(),
                        ..LiveReplayFilters::default()
                    },
                    host_game: HostGamePreferences::default(),
                    host_coop: HostGamePreferences::default(),
                    favorite_maps: vec!["adaptive_tabula.v0006".into()],
                    favorite_mods: vec!["eco_graph".into()],
                    map_vault_preset: "newest".into(),
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
                    mod_vault_preset: "rating".into(),
                    mod_presets: Vec::new(),
                    leaderboard_rating_columns: vec![
                        "deviation".into(),
                        "GAMES".into(),
                        "invalid".into(),
                    ],
                    leaderboard_include_former_names: true,
                    replay_vault_player: "VindexNoob".into(),
                    replay_chat_channel: "Allies".into(),
                    replay_chat_transfers: ReplayChatTransfers::Only,
                    legacy_storage_migrated: true,
                    remembered_filters: Default::default(),
                }
                .into(),
            ),
        }
        .into(),
    )
    .await
    .unwrap();

    for _ in 0..100 {
        if !saved.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let state = app.snapshot().settings.browsing;
    assert_eq!(state.custom_games_view, CustomGameView::List);
    assert_eq!(state.custom_games_browser.sort, CustomGameSort::Age);
    assert!(state.custom_games_browser.hide_private);
    assert!(state.custom_games_browser.apply_filters);
    assert_eq!(state.custom_games_browser.rules[0].value, "gap");
    assert_eq!(state.matchmaker_unselected_queues, ["ladder_1v1"]);
    assert_eq!(state.matchmaker_factions, ["Cybran"]);
    assert_eq!(state.live_replay_filters.search, "tournament");
    assert_eq!(state.live_replay_filters.active_players, "4");
    assert_eq!(state.favorite_maps, ["adaptive_tabula.v0006"]);
    assert_eq!(state.favorite_mods, ["eco_graph"]);
    assert_eq!(state.map_vault_preset, "newest");
    assert_eq!(state.mod_vault_preset, "rating");
    assert_eq!(state.leaderboard_rating_columns, ["deviation", "games"]);
    assert!(state.leaderboard_include_former_names);
    assert_eq!(state.replay_vault_player, "VindexNoob");
    assert_eq!(state.replay_chat_channel, "allies");
    assert_eq!(state.replay_chat_transfers, ReplayChatTransfers::Only);
    assert!(state.legacy_storage_migrated);
    assert_eq!(saved.lock().unwrap().last().unwrap().browsing, state);
}

/// A settings file holding a filter in every kind of place one is kept, read
/// with the given answer to "how long are filters remembered".
struct FilteredSettings(FilterMemory);

#[async_trait]
impl SettingsPort for FilteredSettings {
    async fn load(&self) -> SettingsState {
        let mut settings = SettingsState::default();
        settings.game.cache_lifetime_days = None;
        settings.general.filter_memory = self.0;
        let browsing = &mut settings.browsing;
        browsing.custom_games_browser.hide_private = true;
        browsing.live_replay_filters.search = "1500+".into();
        browsing.map_vault_preset = "favorites".into();
        browsing.map_vault_sort = "rating".into();
        browsing
            .remembered_filters
            .insert("installedMods".into(), r#"{"search":"ui"}"#.into());
        settings
    }

    async fn save(&self, _settings: &SettingsState) -> Result<(), String> {
        Ok(())
    }
}

async fn browsing_after_startup(memory: FilterMemory) -> BrowsingPreferences {
    let ports = Ports {
        settings: Arc::new(FilteredSettings(memory)),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    app.dispatch_and_wait(SettingsCommand::Load.into())
        .await
        .unwrap();
    app.snapshot().settings.browsing
}

/// #447: a filter set before a restart is still there afterwards only when
/// the player chose that; the default is one session.
#[tokio::test]
async fn filters_survive_a_restart_only_when_asked_to() {
    for memory in [FilterMemory::Never, FilterMemory::Session] {
        let browsing = browsing_after_startup(memory).await;
        assert!(!browsing.custom_games_browser.hide_private, "{memory:?}");
        assert!(browsing.live_replay_filters.search.is_empty(), "{memory:?}");
        assert_eq!(browsing.map_vault_preset, "recommended", "{memory:?}");
        assert!(browsing.remembered_filters.is_empty(), "{memory:?}");
        // A sort order is not a filter.
        assert_eq!(browsing.map_vault_sort, "rating", "{memory:?}");
    }

    let kept = browsing_after_startup(FilterMemory::Restart).await;
    assert!(kept.custom_games_browser.hide_private);
    assert_eq!(kept.live_replay_filters.search, "1500+");
    assert_eq!(kept.map_vault_preset, "favorites");
    assert_eq!(kept.remembered_filters.len(), 1);
}
