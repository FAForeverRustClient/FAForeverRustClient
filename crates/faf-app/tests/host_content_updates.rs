//! Hosting on the newest map version and mods, when the player switched
//! `auto_update_map_and_mods` on, and never otherwise.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakeAuth, FakeLobby};
use faf_app::ports::{
    GameLaunchParams, GamePreparation, GameUpdaterPort, InstallPresence, LatestModVersion,
    MapSearchPage, MapsPort, ModPrepFailure, ModSearchPage, ModsPort, ProcessPort, UpdateProgress,
};
use faf_app::{App, Ports};
use faf_domain::protocol::vault_query::{MapVaultQuery, ModVaultQuery};
use faf_domain::state::settings::GamePreferencesPatch;
use faf_domain::state::{
    HostGameConfig, InstalledMap, InstalledMod, LobbyCommand, MatchmakerMapPool, ModDownloadSize,
    ModDownloadTarget, ModType, Player, SettingsCommand, VaultMap, VaultMod,
};
use tokio::sync::mpsc;

fn newest_dualgap() -> VaultMap {
    VaultMap {
        map_id: 1,
        version_id: 5,
        display_name: "Dual Gap".into(),
        author: None,
        author_id: None,
        folder_name: "dualgap.v0005".into(),
        version: "5".into(),
        description: String::new(),
        map_type: "skirmish".into(),
        max_players: 8,
        width: 1024,
        height: 1024,
        games_played: 0,
        version_games_played: 0,
        ranked: false,
        hidden: false,
        recommended: false,
        rating_tenths: 0,
        reviews: 0,
        created_at: "2026-01-01T00:00:00Z".into(),
        download_url: String::new(),
        thumbnail_url: String::new(),
        thumbnail_url_large: String::new(),
    }
}

/// A vault that knows one newer map version.
#[derive(Default)]
struct Maps {
    lookups: Mutex<Vec<String>>,
}

#[async_trait]
impl MapsPort for Maps {
    async fn list_vault(&self) -> Result<Vec<VaultMap>, String> {
        Ok(Vec::new())
    }
    async fn search_vault(&self, _query: MapVaultQuery) -> Result<MapSearchPage, String> {
        Err("not searched in this test".into())
    }
    async fn list_installed(&self) -> Result<Vec<InstalledMap>, String> {
        Ok(Vec::new())
    }
    async fn find_vault_maps_by_folder(
        &self,
        folder_names: &[String],
    ) -> Result<Vec<VaultMap>, String> {
        self.lookups
            .lock()
            .unwrap()
            .extend(folder_names.iter().cloned());
        Ok(folder_names
            .iter()
            .filter(|name| name.starts_with("dualgap"))
            .map(|_| newest_dualgap())
            .collect())
    }
    async fn list_matchmaker_pools(
        &self,
        _queue: String,
    ) -> Result<Vec<MatchmakerMapPool>, String> {
        Ok(Vec::new())
    }
    async fn install_map(
        &self,
        _folder_name: String,
        _download_url: String,
    ) -> Result<Vec<InstalledMap>, String> {
        Ok(Vec::new())
    }
    async fn uninstall_map(&self, _folder_name: String) -> Result<Vec<InstalledMap>, String> {
        Ok(Vec::new())
    }
    async fn set_map_version_hidden(&self, _version_id: i32, _hidden: bool) -> Result<(), String> {
        Ok(())
    }
}

/// Three installed mods: an enabled one with a newer version, a disabled one
/// with a newer version, and an enabled one the vault has never seen.
#[derive(Default)]
struct Mods {
    updates: Mutex<Vec<(String, String, String)>>,
}

fn installed(uid: &str, folder: &str, enabled: bool) -> InstalledMod {
    InstalledMod {
        folder_name: folder.into(),
        uid: uid.into(),
        display_name: folder.into(),
        version: "1".into(),
        author: String::new(),
        description: String::new(),
        mod_type: ModType::Sim,
        enabled,
    }
}

#[async_trait]
impl ModsPort for Mods {
    async fn list_vault(&self) -> Result<Vec<VaultMod>, String> {
        Ok(Vec::new())
    }
    async fn search_vault(&self, _query: ModVaultQuery) -> Result<ModSearchPage, String> {
        Err("not searched in this test".into())
    }
    async fn list_installed(&self) -> Result<Vec<InstalledMod>, String> {
        Ok(vec![
            installed("outdated-1", "BrewLAN", true),
            installed("disabled-1", "Sorian", false),
            installed("local-build", "MyMod", true),
        ])
    }
    async fn download_sizes(&self, _targets: Vec<ModDownloadTarget>) -> Vec<ModDownloadSize> {
        Vec::new()
    }
    async fn install_mod(
        &self,
        _uid: String,
        _download_url: String,
    ) -> Result<Vec<InstalledMod>, String> {
        Ok(Vec::new())
    }
    async fn update_mod(
        &self,
        uid: String,
        folder_name: String,
        download_url: String,
    ) -> Result<Vec<InstalledMod>, String> {
        self.updates
            .lock()
            .unwrap()
            .push((uid, folder_name, download_url));
        Ok(Vec::new())
    }
    async fn uninstall_mod(&self, _folder_name: String) -> Result<Vec<InstalledMod>, String> {
        Ok(Vec::new())
    }
    async fn toggle_mod(&self, _uid: String, _enabled: bool) -> Result<Vec<InstalledMod>, String> {
        Ok(Vec::new())
    }
    async fn set_active_mods(&self, _uids: Vec<String>) -> Result<Vec<InstalledMod>, String> {
        Ok(Vec::new())
    }
    async fn ensure_game_mods(
        &self,
        _mods: &BTreeMap<String, String>,
        _replace: bool,
    ) -> Result<(), ModPrepFailure> {
        Ok(())
    }
    async fn latest_mod_version(&self, uid: &str) -> Result<Option<LatestModVersion>, String> {
        Ok(match uid {
            "outdated-1" => Some(LatestModVersion {
                uid: "outdated-2".into(),
                version: "2".into(),
                download_url: "https://content.faforever.com/mods/brewlan.v2.zip".into(),
            }),
            "disabled-1" => Some(LatestModVersion {
                uid: "disabled-2".into(),
                version: "2".into(),
                download_url: "https://content.faforever.com/mods/sorian.v2.zip".into(),
            }),
            _ => None,
        })
    }
}

/// Live launches supported, with an install, so the host prepares.
struct Process;

#[async_trait]
impl ProcessPort for Process {
    fn supports_live_launch(&self) -> bool {
        true
    }
    async fn launch_game(&self, _params: GameLaunchParams) -> Result<(), String> {
        Ok(())
    }
    async fn launch_offline(&self, _featured_mod: String, _map: String) -> Result<(), String> {
        Ok(())
    }
    async fn launch_replay(&self, _args: Vec<String>) -> Result<(), String> {
        Ok(())
    }
    fn kill(&self) {}
    async fn wait_for_exit(&self) {
        std::future::pending::<()>().await
    }
    fn set_paths(&self, _game_path: String, _replay_game_path: String) {}
    fn set_additional_arguments(&self, _arguments: Vec<String>) {}
    fn game_install_dir(&self) -> Option<PathBuf> {
        Some(PathBuf::from("C:/fake-fa-install"))
    }
    fn replay_install_dir(&self) -> Option<PathBuf> {
        None
    }
    fn installs_present(&self) -> InstallPresence {
        InstallPresence::default()
    }
}

/// Records what each preparation was asked to stage.
struct Updater(Arc<Mutex<Vec<GamePreparation>>>);

#[async_trait]
impl GameUpdaterPort for Updater {
    async fn prepare(&self, request: GamePreparation) -> mpsc::Receiver<UpdateProgress> {
        self.0.lock().unwrap().push(request);
        let (tx, rx) = mpsc::channel(1);
        let _ = tx.send(UpdateProgress::Finished(Ok(()))).await;
        rx
    }
}

struct Harness {
    app: App,
    lobby: FakeLobby,
    maps: Arc<Maps>,
    mods: Arc<Mods>,
    prepared: Arc<Mutex<Vec<GamePreparation>>>,
}

fn harness() -> Harness {
    let lobby = FakeLobby::default();
    let maps = Arc::new(Maps::default());
    let mods = Arc::new(Mods::default());
    let prepared = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        auth: Arc::new(FakeAuth {
            player: Player::new(7, "Ada"),
            delay: Duration::ZERO,
            fail_with: None,
        }),
        lobby: Arc::new(lobby.clone()),
        maps: maps.clone(),
        mods: mods.clone(),
        process: Arc::new(Process),
        updater: Arc::new(Updater(prepared.clone())),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    Harness {
        app,
        lobby,
        maps,
        mods,
        prepared,
    }
}

fn config(map: &str) -> HostGameConfig {
    HostGameConfig {
        title: "Friday game".into(),
        mod_name: "faf".into(),
        visibility: "public".into(),
        map: map.into(),
        password: None,
        enforce_rating_range: false,
        rating_min: None,
        rating_max: None,
    }
}

async fn host(h: &Harness, map: &str) {
    h.app
        .dispatch(
            LobbyCommand::Host {
                config: config(map),
            }
            .into(),
        )
        .await
        .unwrap();
    for _ in 0..200 {
        if !h.lobby.hosted_configs().is_empty() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the host request never reached the lobby");
}

async fn switch_on(h: &Harness) {
    h.app
        .dispatch_and_wait(
            SettingsCommand::PatchGame {
                patch: Box::new(GamePreferencesPatch {
                    auto_update_map_and_mods: Some(true),
                    ..GamePreferencesPatch::default()
                }),
            }
            .into(),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn hosting_on_the_newest_map_and_mods_when_switched_on() {
    let h = harness();
    switch_on(&h).await;

    host(&h, "dualgap.v0003").await;

    assert_eq!(h.lobby.hosted_configs()[0].map, "dualgap.v0005");
    assert_eq!(
        h.prepared.lock().unwrap()[0].map_folder.as_deref(),
        Some("dualgap.v0005"),
        "the newest version is the one staged"
    );
    assert_eq!(
        *h.mods.updates.lock().unwrap(),
        vec![(
            "outdated-2".to_string(),
            "BrewLAN".to_string(),
            "https://content.faforever.com/mods/brewlan.v2.zip".to_string(),
        )],
        "only the enabled mod with a published newer version is updated"
    );
}

#[tokio::test]
async fn an_official_map_is_never_swapped() {
    let h = harness();
    switch_on(&h).await;

    host(&h, "SCMP_009").await;

    assert_eq!(h.lobby.hosted_configs()[0].map, "SCMP_009");
    assert!(h.maps.lookups.lock().unwrap().is_empty());
}

#[tokio::test]
async fn nothing_is_updated_by_default() {
    let h = harness();

    host(&h, "dualgap.v0003").await;

    assert_eq!(h.lobby.hosted_configs()[0].map, "dualgap.v0003");
    assert!(h.maps.lookups.lock().unwrap().is_empty());
    assert!(h.mods.updates.lock().unwrap().is_empty());
}
