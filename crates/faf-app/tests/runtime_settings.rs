//! Startup settings are applied through the service boundary, not by the shell.
//!
//! This guards the ownership seam removed from `src-tauri`: loading persisted
//! settings must reconfigure the process port before startup can continue.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{
    DiscoveredInstallPaths, GameLaunchParams, InstallPresence, ProcessPort, ReplayPort,
    SettingsPort, VaultSearchResult,
};
use faf_app::{App, Ports};
use faf_domain::state::{
    LiveReplayTarget, LocalReplay, ReplayQuery, SettingsCommand, SettingsState,
};

/// Records only what this file asserts on: which install the replay preparation
/// steps were pointed at. Everything else is unreachable here.
struct RecordingReplay {
    install_dirs: Arc<Mutex<Vec<Option<PathBuf>>>>,
}

#[async_trait]
impl ReplayPort for RecordingReplay {
    async fn watch_live(
        &self,
        _target: LiveReplayTarget,
        _player: String,
    ) -> Result<Option<String>, String> {
        unreachable!()
    }
    async fn play_file(&self, _path: PathBuf) -> Result<Option<String>, String> {
        unreachable!()
    }
    async fn search_vault(&self, _query: ReplayQuery) -> Result<VaultSearchResult, String> {
        unreachable!()
    }
    async fn list_featured_mods(&self) -> Result<Vec<String>, String> {
        unreachable!()
    }
    async fn watch_vault(&self, _uid: i32) -> Result<Option<String>, String> {
        unreachable!()
    }
    async fn download_vault(&self, _uid: i32) -> Result<LocalReplay, String> {
        unreachable!()
    }
    async fn list_local(&self) -> Result<Vec<LocalReplay>, String> {
        Ok(Vec::new())
    }
    async fn delete_local(&self, _path: PathBuf) -> Result<(), String> {
        unreachable!()
    }

    fn set_install_dir(&self, dir: Option<PathBuf>) {
        self.install_dirs.lock().unwrap().push(dir);
    }
}

struct StoredSettings(SettingsState);

#[async_trait]
impl SettingsPort for StoredSettings {
    async fn load(&self) -> SettingsState {
        self.0.clone()
    }

    async fn save(&self, _settings: &SettingsState) {}
}

struct RecordingSettings {
    loaded: SettingsState,
    saved: Arc<Mutex<Vec<SettingsState>>>,
}

#[async_trait]
impl SettingsPort for RecordingSettings {
    async fn load(&self) -> SettingsState {
        self.loaded.clone()
    }

    async fn save(&self, settings: &SettingsState) {
        self.saved.lock().unwrap().push(settings.clone());
    }
}

#[derive(Default)]
struct RecordingProcess {
    paths: Arc<Mutex<Vec<(String, String)>>>,
    discovered: DiscoveredInstallPaths,
}

#[async_trait]
impl ProcessPort for RecordingProcess {
    fn supports_live_launch(&self) -> bool {
        false
    }

    async fn launch_game(&self, _params: GameLaunchParams) -> Result<(), String> {
        Err("not used in this test".into())
    }

    async fn launch_offline(&self, _featured_mod: String, _map: String) -> Result<(), String> {
        Err("not used in this test".into())
    }

    async fn launch_replay(&self, _args: Vec<String>) -> Result<(), String> {
        Err("not used in this test".into())
    }

    fn kill(&self) {}

    fn set_paths(&self, game_path: String, replay_game_path: String) {
        self.paths
            .lock()
            .unwrap()
            .push((game_path, replay_game_path));
    }

    fn set_additional_arguments(&self, _arguments: Vec<String>) {}

    fn game_install_dir(&self) -> Option<PathBuf> {
        None
    }

    /// Same derivation as the real process port: two directories up from the
    /// executable (…/replaydata/bin/FA.exe → …/replaydata).
    fn replay_install_dir(&self) -> Option<PathBuf> {
        let (_, replay) = self.paths.lock().unwrap().last()?.clone();
        PathBuf::from(replay).parent()?.parent().map(PathBuf::from)
    }

    fn installs_present(&self) -> InstallPresence {
        InstallPresence::default()
    }

    fn install_path_is_present(&self, path: &str) -> bool {
        path.starts_with("configured-")
    }

    fn discover_install_paths(&self) -> DiscoveredInstallPaths {
        self.discovered.clone()
    }
}

#[tokio::test]
async fn loading_settings_reconfigures_process_paths_before_settling() {
    let paths = Arc::new(Mutex::new(Vec::new()));
    let settings = SettingsState {
        game_path: "configured-game.exe".into(),
        replay_game_path: "configured-replay.exe".into(),
        ..SettingsState::default()
    };

    let ports = Ports {
        settings: Arc::new(StoredSettings(settings)),
        process: Arc::new(RecordingProcess {
            paths: paths.clone(),
            discovered: DiscoveredInstallPaths {
                game: Some("other-client-game.exe".into()),
                replay: Some("other-client-replay.exe".into()),
            },
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());

    app.dispatch_and_wait(SettingsCommand::Load.into())
        .await
        .unwrap();

    assert_eq!(
        *paths.lock().unwrap(),
        vec![("configured-game.exe".into(), "configured-replay.exe".into())]
    );
    assert_eq!(app.snapshot().settings.game_path, "configured-game.exe");
    assert_eq!(
        app.snapshot().settings.replay_game_path,
        "configured-replay.exe"
    );
}

/// The replay preparation steps (engine version match, map staging) run against
/// whatever directory the replay port was last told about. That used to be
/// derived from `FAF_REPLAY_GAME_PATH` once at startup, so choosing the install
/// in Settings, the only way the UI offers, left it unset: every preparation
/// step was skipped and FA opened a replay it could not load, landing the user
/// on the main menu with no error reported anywhere.
#[tokio::test]
async fn loading_settings_points_replay_preparation_at_the_configured_install() {
    let install_dirs = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        settings: Arc::new(StoredSettings(SettingsState {
            game_path: "C:/faf/bin/ForgedAlliance.exe".into(),
            replay_game_path: "C:/faf/replaydata/bin/ForgedAlliance.exe".into(),
            ..SettingsState::default()
        })),
        process: Arc::new(RecordingProcess {
            paths: Arc::new(Mutex::new(Vec::new())),
            discovered: DiscoveredInstallPaths::default(),
        }),
        replay: Arc::new(RecordingReplay {
            install_dirs: install_dirs.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());

    app.dispatch_and_wait(SettingsCommand::Load.into())
        .await
        .unwrap();

    assert_eq!(
        *install_dirs.lock().unwrap(),
        vec![Some(PathBuf::from("C:/faf/replaydata"))],
        "the replay updater must target the install Settings configured"
    );
}

#[tokio::test]
async fn loading_imports_and_persists_discovered_reference_client_installs() {
    let paths = Arc::new(Mutex::new(Vec::new()));
    let saved = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        settings: Arc::new(RecordingSettings {
            loaded: SettingsState::default(),
            saved: saved.clone(),
        }),
        process: Arc::new(RecordingProcess {
            paths: paths.clone(),
            discovered: DiscoveredInstallPaths {
                game: Some("java-managed-game.exe".into()),
                replay: Some("python-managed-replay.exe".into()),
            },
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());

    app.dispatch_and_wait(SettingsCommand::Load.into())
        .await
        .unwrap();

    let snapshot = app.snapshot();
    assert_eq!(snapshot.settings.game_path, "java-managed-game.exe");
    assert_eq!(
        snapshot.settings.replay_game_path,
        "python-managed-replay.exe"
    );
    assert_eq!(
        *paths.lock().unwrap(),
        vec![(
            "java-managed-game.exe".into(),
            "python-managed-replay.exe".into()
        )]
    );
    let persisted = saved.lock().unwrap();
    assert_eq!(persisted.len(), 1);
    assert_eq!(persisted[0].game_path, "java-managed-game.exe");
}
