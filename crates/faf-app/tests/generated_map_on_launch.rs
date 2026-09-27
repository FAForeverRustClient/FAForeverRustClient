//! A map the launcher had to build counts as installed afterwards.
//!
//! There are two places a generated map gets produced, and they used to disagree
//! about what happens next. A deliberate run from the Generate map dialog went
//! through `services::map_generator::drain`, which reads the new folder's
//! preview art and re-scans the maps directory. A lobby join or a host whose map
//! was missing went through `services::launcher::ensure_generated_map`, which
//! forwarded the progress statuses and stopped there: the folder was on disk,
//! the game started, and the client still showed the map as missing with no
//! preview until something else happened to re-scan.
//!
//! The reported symptom was exactly that, from somebody already in the game:
//! "the preview doesn't update", "the client doesn't know I have the map".
//!
//! Driven through `Host` rather than `Join`, because both reach the same
//! `prepare_map_and_mod` and hosting lets the test name the map.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{
    GameLaunchParams, GamePreparation, GameUpdaterPort, InstallPresence, MapSearchPage, MapsPort,
    ProcessPort, UpdateProgress,
};
use faf_app::{App, Ports};
use faf_domain::protocol::vault_query::MapVaultQuery;
use faf_domain::state::{
    GamePreferences, HostGameConfig, InstalledMap, LobbyCommand, MatchmakerMapPool,
    SettingsCommand, VaultMap,
};
use tokio::sync::mpsc;

/// A generated map name, which is the whole point: `is_generated_map` has to
/// recognise it or the launcher never calls the generator at all.
const GENERATED: &str = "neroxis_map_generator_1.7.7_aaaaaaaaaaaaa_aaaaa";

/// Claims live launch is available, so `LobbyCommand::Host` actually prepares.
struct LaunchableProcess;

#[async_trait]
impl ProcessPort for LaunchableProcess {
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
        Some(PathBuf::from("C:/faf"))
    }
    fn replay_install_dir(&self) -> Option<PathBuf> {
        None
    }
    fn installs_present(&self) -> InstallPresence {
        InstallPresence::default()
    }
}

/// Succeeds at everything and records nothing: the download half is not under
/// test here, only that it is reached with the generated map left out of it.
struct SilentUpdater {
    requests: Arc<Mutex<Vec<GamePreparation>>>,
}

#[async_trait]
impl GameUpdaterPort for SilentUpdater {
    async fn prepare(&self, request: GamePreparation) -> mpsc::Receiver<UpdateProgress> {
        self.requests.lock().unwrap().push(request);
        let (tx, rx) = mpsc::channel(4);
        let _ = tx.send(UpdateProgress::Finished(Ok(()))).await;
        rx
    }
}

/// Counts directory re-scans. Everything else is the vault, which is untouched.
#[derive(Default)]
struct CountingMaps {
    scans: Arc<AtomicUsize>,
}

#[async_trait]
impl MapsPort for CountingMaps {
    async fn list_vault(&self) -> Result<Vec<VaultMap>, String> {
        Ok(Vec::new())
    }
    async fn search_vault(&self, _query: MapVaultQuery) -> Result<MapSearchPage, String> {
        unreachable!("this test never searches the vault")
    }
    async fn list_installed(&self) -> Result<Vec<InstalledMap>, String> {
        self.scans.fetch_add(1, Ordering::SeqCst);
        Ok(Vec::new())
    }
    async fn list_matchmaker_pools(
        &self,
        _queue_name: String,
    ) -> Result<Vec<MatchmakerMapPool>, String> {
        Ok(Vec::new())
    }
    async fn install_map(
        &self,
        _folder_name: String,
        _download_url: String,
    ) -> Result<Vec<InstalledMap>, String> {
        unreachable!()
    }
    async fn uninstall_map(&self, _folder_name: String) -> Result<Vec<InstalledMap>, String> {
        unreachable!()
    }
    async fn set_map_version_hidden(&self, _version_id: i32, _hidden: bool) -> Result<(), String> {
        unreachable!()
    }
}

struct Harness {
    app: App,
    scans: Arc<AtomicUsize>,
    requests: Arc<Mutex<Vec<GamePreparation>>>,
}

async fn harness() -> Harness {
    let scans = Arc::new(AtomicUsize::new(0));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        process: Arc::new(LaunchableProcess),
        updater: Arc::new(SilentUpdater {
            requests: requests.clone(),
        }),
        maps: Arc::new(CountingMaps {
            scans: scans.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    Harness {
        app,
        scans,
        requests,
    }
}

async fn host(app: &App, map: &str) {
    app.dispatch_and_wait(
        LobbyCommand::Host {
            config: HostGameConfig {
                title: "Generated".into(),
                mod_name: "faf".into(),
                visibility: "public".into(),
                map: map.into(),
                password: None,
                enforce_rating_range: false,
                rating_min: None,
                rating_max: None,
            },
        }
        .into(),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn a_map_built_for_a_launch_is_re_scanned_like_any_other() {
    let h = harness().await;
    let before = h.scans.load(Ordering::SeqCst);

    host(&h.app, GENERATED).await;

    assert!(
        h.scans.load(Ordering::SeqCst) > before,
        "the launcher built a map and nothing looked at the maps folder again, \
         so the client still believes the map is missing",
    );
}

#[tokio::test]
async fn an_ordinary_map_is_downloaded_and_nothing_is_generated() {
    // The counterpart, so the test above cannot pass by re-scanning on every
    // host: an ordinary map is the updater's job and the generator is never
    // involved.
    let h = harness().await;
    let before = h.scans.load(Ordering::SeqCst);

    host(&h.app, "scmp_009").await;

    assert_eq!(
        h.scans.load(Ordering::SeqCst),
        before,
        "nothing was generated, so there is no new folder to find",
    );
    assert_eq!(
        h.requests.lock().unwrap().first().unwrap().map_folder,
        Some("scmp_009".to_string()),
        "an ordinary map comes from the vault",
    );
}

#[tokio::test]
async fn a_built_map_reaches_the_keep_list_from_the_launch_path_too() {
    // `keep_generated_maps` is a standing preference, and the launcher's own
    // generation used to be exempt from it by accident rather than by decision:
    // it never reached the code that records the names.
    let h = harness().await;
    h.app
        .dispatch_and_wait(
            SettingsCommand::SetGame {
                preferences: GamePreferences {
                    keep_generated_maps: true,
                    ..GamePreferences::default()
                },
            }
            .into(),
        )
        .await
        .unwrap();

    host(&h.app, GENERATED).await;

    assert_eq!(
        h.app.snapshot().settings.kept_generated_maps,
        vec![GENERATED.to_string()],
    );
    // And the download request leaves it out, because the vault has never heard
    // of it.
    assert_eq!(
        h.requests.lock().unwrap().first().unwrap().map_folder,
        None,
        "asking the CDN for a generated map is a guaranteed 404",
    );
}

/// Guards the constant above: if `is_generated_map` stops recognising this name
/// every test in the file passes for the wrong reason.
#[test]
fn the_test_map_name_is_one_the_client_recognises() {
    assert!(faf_domain::protocol::map_generator::is_generated_map(
        GENERATED
    ));
}
