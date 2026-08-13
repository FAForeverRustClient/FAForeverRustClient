//! Startup settings are applied through the service boundary, not by the shell.
//!
//! This guards the ownership seam removed from `src-tauri`: loading persisted
//! settings must reconfigure the process port before startup can continue.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{
    DiscoveredInstallPaths, GameLaunchParams, InstallPresence, ProcessPort, SettingsPort,
};
use faf_app::{App, Ports};
use faf_domain::state::{SettingsCommand, SettingsState};

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
