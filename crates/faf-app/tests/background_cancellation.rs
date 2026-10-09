//! Background work called off from where it is shown: the status bar's task,
//! its dialog, or a replay panel closing.
//!
//! Each test holds one long-running port call open, calls it off with the
//! operation's own cancel command (all of them in the priority lane, so none
//! waits behind the work it stops), and checks three things: the state ends
//! idle rather than failed, the port's work was really stopped (its future was
//! dropped, or it saw the call-off), and nothing is left holding the
//! operation's key, so the next one of its kind runs.
//!
//! What is left on disk is the adapters' half, pinned against real files by
//! their own unit tests: `infra::vault_install`, `infra::game_updater::maps`,
//! `infra::replay::vault` and `infra::uploads`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakeMaps, FakeMods, FakeReplay};
use faf_app::ports::{
    ClientUpdatePort, DownloadProgress, MapSearchPage, MapsPort, ModPrepFailure, ModSearchPage,
    ModsPort, ReplayDetailsPort, ReplayVaultPort, UploadsPort, VaultInstallProgress,
    VaultInstallStep, VaultSearchResult,
};
use faf_app::{App, Ports};
use faf_domain::protocol::vault_query::{MapVaultQuery, ModVaultQuery};
use faf_domain::state::replays::ReplayDownloadStatus;
use faf_domain::state::{
    replay_read_key, ClientRelease, ClientUpdateCommand, ClientUpdateEvent, ClientUpdateStatus,
    InstalledMap, InstalledMod, LocalReplay, LocalReplayStatus, MapInstallStatus, MapsCommand,
    MapsEvent, MatchmakerMapPool, ModDownloadSize, ModDownloadTarget, ModInstallStatus, ModType,
    ModsCommand, ModsEvent, ReplayAnalysis, ReplayCommand, ReplayDetails, ReplayEvent, ReplayQuery,
    UploadKind, UploadRequest, UploadStatus, UploadsCommand, UploadsEvent, VaultMap, VaultMod,
};
use faf_domain::{AppCommand, AppEvent};
use tokio::sync::{broadcast, mpsc, Notify};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

// ── Harness ────────────────────────────────────────────────────────────────

fn start(ports: Ports) -> Arc<App> {
    start_as("test", ports)
}

/// A client running `version`: an update is only offered to a released build.
fn start_as(version: &str, ports: Ports) -> Arc<App> {
    let (app, app_loop) = App::new(version, ports);
    tokio::spawn(app_loop.run());
    Arc::new(app)
}

/// Dispatch without waiting, and hand back the command's completion.
fn spawn_command(app: &Arc<App>, command: impl Into<AppCommand>) -> JoinHandle<()> {
    let app = app.clone();
    let command = command.into();
    tokio::spawn(async move {
        app.dispatch_and_wait(command)
            .await
            .expect("command completes");
    })
}

async fn run(app: &Arc<App>, command: impl Into<AppCommand>) {
    app.dispatch_and_wait(command.into())
        .await
        .expect("command completes");
}

/// Await a command that was called off. The timeout is a safety net, not an
/// ordering: a cancel that did not reach the work leaves it waiting forever.
async fn finish(command: JoinHandle<()>) {
    tokio::time::timeout(Duration::from_secs(10), command)
        .await
        .expect("the called-off command never finished")
        .expect("the called-off command panicked");
}

/// Wait for the first event `wanted` accepts. Subscribe before dispatching.
async fn until(events: &mut broadcast::Receiver<AppEvent>, wanted: impl Fn(&AppEvent) -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match events.recv().await {
                Ok(event) if wanted(&event) => return,
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => panic!("the event stream closed"),
            }
        }
    })
    .await
    .expect("the awaited event never came");
}

fn assert_nothing_announced(app: &App) {
    assert!(
        app.snapshot().notifications.items.is_empty(),
        "a call-off was announced as if something had gone wrong"
    );
}

/// Raised when the future holding it is dropped, which is how a service
/// calls a port's work off.
struct DroppedFlag(Arc<AtomicBool>);

impl Drop for DroppedFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// Hold an install open until it is called off: report half of a download,
/// then wait for the call-off it was handed.
async fn half_downloaded_until_called_off(
    progress: &VaultInstallProgress,
    called_off: &CancellationToken,
    saw_call_off: &AtomicBool,
) {
    progress(VaultInstallStep::Downloading {
        received_bytes: 50,
        total_bytes: Some(100),
    });
    called_off.cancelled().await;
    saw_call_off.store(true, Ordering::SeqCst);
}

// ── Map installs ───────────────────────────────────────────────────────────

const MAP: &str = "setons_clutch.v0003";

fn installed_map(folder: &str) -> InstalledMap {
    InstalledMap {
        folder_name: folder.into(),
        display_name: "Seton's Clutch".into(),
        max_players: 8,
        width: 1024,
        height: 1024,
        version: None,
        description: None,
        installed_at: None,
    }
}

/// A map vault whose installs hold half-way until they are called off, and
/// then end the way the real adapter ends one: in time, with nothing on disk,
/// or, `too_late`, with the map already renamed into place.
#[derive(Default)]
struct HeldMaps {
    too_late: bool,
    saw_call_off: AtomicBool,
    uninstalls: AtomicUsize,
}

#[async_trait]
impl MapsPort for HeldMaps {
    async fn list_vault(&self) -> Result<Vec<VaultMap>, String> {
        FakeMaps.list_vault().await
    }
    async fn search_vault(&self, query: MapVaultQuery) -> Result<MapSearchPage, String> {
        FakeMaps.search_vault(query).await
    }
    async fn list_installed(&self) -> Result<Vec<InstalledMap>, String> {
        Ok(Vec::new())
    }
    async fn list_matchmaker_pools(&self, queue: String) -> Result<Vec<MatchmakerMapPool>, String> {
        FakeMaps.list_matchmaker_pools(queue).await
    }
    async fn install_map(&self, folder: String, _url: String) -> Result<Vec<InstalledMap>, String> {
        Ok(vec![installed_map(&folder)])
    }
    async fn install_map_reporting(
        &self,
        folder: String,
        _url: String,
        progress: VaultInstallProgress,
        called_off: CancellationToken,
    ) -> Result<Option<Vec<InstalledMap>>, String> {
        half_downloaded_until_called_off(&progress, &called_off, &self.saw_call_off).await;
        if !self.too_late {
            return Ok(None);
        }
        // In place already; the maps folder is still being listed.
        tokio::task::yield_now().await;
        Ok(Some(vec![installed_map(&folder)]))
    }
    async fn uninstall_map(&self, _folder: String) -> Result<Vec<InstalledMap>, String> {
        self.uninstalls.fetch_add(1, Ordering::SeqCst);
        Ok(Vec::new())
    }
    async fn set_map_version_hidden(&self, version: i32, hidden: bool) -> Result<(), String> {
        FakeMaps.set_map_version_hidden(version, hidden).await
    }
}

/// Start installing [`MAP`] and wait until half of it is downloaded.
async fn install_map_half_way(app: &Arc<App>) -> JoinHandle<()> {
    let mut events = app.subscribe();
    let install = spawn_command(
        app,
        MapsCommand::InstallMap {
            folder_name: MAP.into(),
            download_url: format!("https://content.faforever.com/maps/{MAP}.zip"),
        },
    );
    until(&mut events, |event| {
        matches!(
            event,
            AppEvent::Maps(MapsEvent::InstallProgressed {
                progress: Some(50),
                ..
            })
        )
    })
    .await;
    install
}

#[tokio::test]
async fn cancelling_a_map_install_stops_its_download_and_frees_the_maps_folder() {
    let maps = Arc::new(HeldMaps::default());
    let app = start(Ports {
        maps: maps.clone(),
        ..fake_ports()
    });

    let install = install_map_half_way(&app).await;
    assert_eq!(
        app.snapshot().maps.install_status,
        MapInstallStatus::Installing {
            folder_name: MAP.into(),
            progress: Some(50),
        },
        "the bar shows the measured download"
    );

    // Another map's cancel does not reach it; its own does, in any case.
    run(
        &app,
        MapsCommand::CancelInstall {
            folder_name: "another.v0001".into(),
        },
    )
    .await;
    assert!(!maps.saw_call_off.load(Ordering::SeqCst));
    run(
        &app,
        MapsCommand::CancelInstall {
            folder_name: MAP.to_uppercase(),
        },
    )
    .await;
    finish(install).await;

    assert!(
        maps.saw_call_off.load(Ordering::SeqCst),
        "the install never saw the call-off"
    );
    let state = app.snapshot().maps;
    assert_eq!(state.install_status, MapInstallStatus::Idle);
    assert!(state.installed.is_empty(), "nothing was installed");
    assert_nothing_announced(&app);

    // The maps folder's turn is free: the next write runs.
    run(
        &app,
        MapsCommand::UninstallMap {
            folder_name: "old.v0001".into(),
        },
    )
    .await;
    assert_eq!(maps.uninstalls.load(Ordering::SeqCst), 1);
}

/// Cancel pressed once the map is already renamed into place, while the
/// maps folder is listed after it. The cancel used to win anyway: the vault
/// said the install was called off, and the installed list never got the
/// map that was on disk.
#[tokio::test]
async fn a_map_install_called_off_too_late_is_reported_installed() {
    let maps = Arc::new(HeldMaps {
        too_late: true,
        ..HeldMaps::default()
    });
    let app = start(Ports {
        maps: maps.clone(),
        ..fake_ports()
    });

    let install = install_map_half_way(&app).await;
    run(
        &app,
        MapsCommand::CancelInstall {
            folder_name: MAP.into(),
        },
    )
    .await;
    finish(install).await;

    assert!(maps.saw_call_off.load(Ordering::SeqCst));
    let state = app.snapshot().maps;
    assert_eq!(state.install_status, MapInstallStatus::Idle);
    assert_eq!(
        state.installed,
        vec![installed_map(MAP)],
        "the map on disk is in the installed list"
    );
    assert_nothing_announced(&app);
}

// ── Mod installs and updates ───────────────────────────────────────────────

const MOD_UID: &str = "mod-uid-2";

fn installed_mod(uid: &str) -> InstalledMod {
    InstalledMod {
        folder_name: "totalmayhem".into(),
        uid: uid.into(),
        display_name: "Total Mayhem".into(),
        version: "1".into(),
        author: "Some Author".into(),
        description: String::new(),
        mod_type: ModType::Sim,
        enabled: true,
    }
}

/// A mod vault whose installs and updates hold until they see the call-off
/// they are handed. An install then ends in time, or, `too_late`, with the
/// mod already in place, as [`HeldMaps`] does.
#[derive(Default)]
struct HeldMods {
    too_late: bool,
    install_saw_call_off: AtomicBool,
    update_saw_call_off: AtomicBool,
    toggles: AtomicUsize,
}

#[async_trait]
impl ModsPort for HeldMods {
    async fn list_vault(&self) -> Result<Vec<VaultMod>, String> {
        FakeMods.list_vault().await
    }
    async fn search_vault(&self, query: ModVaultQuery) -> Result<ModSearchPage, String> {
        FakeMods.search_vault(query).await
    }
    async fn list_installed(&self) -> Result<Vec<InstalledMod>, String> {
        Ok(vec![installed_mod("old-uid")])
    }
    async fn download_sizes(&self, targets: Vec<ModDownloadTarget>) -> Vec<ModDownloadSize> {
        FakeMods.download_sizes(targets).await
    }
    async fn install_mod(&self, uid: String, _url: String) -> Result<Vec<InstalledMod>, String> {
        Ok(vec![installed_mod(&uid)])
    }
    async fn install_mod_reporting(
        &self,
        uid: String,
        _url: String,
        progress: VaultInstallProgress,
        called_off: CancellationToken,
    ) -> Result<Option<Vec<InstalledMod>>, String> {
        half_downloaded_until_called_off(&progress, &called_off, &self.install_saw_call_off).await;
        if !self.too_late {
            return Ok(None);
        }
        // In place already; the mods folder is still being listed.
        tokio::task::yield_now().await;
        Ok(Some(vec![installed_mod("old-uid"), installed_mod(&uid)]))
    }
    async fn update_mod(
        &self,
        uid: String,
        _folder: String,
        _url: String,
    ) -> Result<Vec<InstalledMod>, String> {
        Ok(vec![installed_mod(&uid)])
    }
    async fn update_mod_reporting(
        &self,
        _uid: String,
        _folder: String,
        _url: String,
        progress: VaultInstallProgress,
        called_off: tokio_util::sync::CancellationToken,
    ) -> Result<Option<Vec<InstalledMod>>, String> {
        // Still downloading: the old version is untouched, and the call-off
        // stops it there.
        progress(VaultInstallStep::Downloading {
            received_bytes: 30,
            total_bytes: Some(100),
        });
        called_off.cancelled().await;
        self.update_saw_call_off.store(true, Ordering::SeqCst);
        Ok(None)
    }
    async fn uninstall_mod(&self, folder: String) -> Result<Vec<InstalledMod>, String> {
        FakeMods.uninstall_mod(folder).await
    }
    async fn toggle_mod(&self, uid: String, enabled: bool) -> Result<Vec<InstalledMod>, String> {
        self.toggles.fetch_add(1, Ordering::SeqCst);
        FakeMods.toggle_mod(uid, enabled).await
    }
    async fn set_active_mods(&self, uids: Vec<String>) -> Result<Vec<InstalledMod>, String> {
        FakeMods.set_active_mods(uids).await
    }
    async fn ensure_game_mods(
        &self,
        mods: &BTreeMap<String, String>,
        replace: bool,
    ) -> Result<(), ModPrepFailure> {
        FakeMods.ensure_game_mods(mods, replace).await
    }
}

/// Start installing [`MOD_UID`], wait until half of it is downloaded, and
/// call it off.
async fn install_mod_then_call_it_off(app: &Arc<App>) {
    let mut events = app.subscribe();
    let install = spawn_command(
        app,
        ModsCommand::InstallMod {
            uid: MOD_UID.into(),
            download_url: "https://content.faforever.com/mods/totalmayhem.zip".into(),
        },
    );
    until(&mut events, |event| {
        matches!(
            event,
            AppEvent::Mods(ModsEvent::InstallProgressed {
                progress: Some(50),
                ..
            })
        )
    })
    .await;
    run(
        app,
        ModsCommand::CancelInstall {
            uid: MOD_UID.into(),
        },
    )
    .await;
    finish(install).await;
}

#[tokio::test]
async fn cancelling_a_mod_install_stops_its_download_and_frees_the_mods_folder() {
    let mods = Arc::new(HeldMods::default());
    let app = start(Ports {
        mods: mods.clone(),
        ..fake_ports()
    });

    install_mod_then_call_it_off(&app).await;

    assert!(
        mods.install_saw_call_off.load(Ordering::SeqCst),
        "the install never saw the call-off"
    );
    assert_eq!(app.snapshot().mods.install_status, ModInstallStatus::Idle);
    assert_nothing_announced(&app);

    // The mods folder's turn is free: the next write runs.
    run(
        &app,
        ModsCommand::ToggleMod {
            uid: "old-uid".into(),
            enabled: false,
        },
    )
    .await;
    assert_eq!(mods.toggles.load(Ordering::SeqCst), 1);
}

/// The mod's version of [`a_map_install_called_off_too_late_is_reported_installed`].
#[tokio::test]
async fn a_mod_install_called_off_too_late_is_reported_installed() {
    let mods = Arc::new(HeldMods {
        too_late: true,
        ..HeldMods::default()
    });
    let app = start(Ports {
        mods: mods.clone(),
        ..fake_ports()
    });
    run(&app, ModsCommand::LoadInstalled).await;

    install_mod_then_call_it_off(&app).await;

    assert!(mods.install_saw_call_off.load(Ordering::SeqCst));
    let state = app.snapshot().mods;
    assert_eq!(state.install_status, ModInstallStatus::Idle);
    assert_eq!(
        state.installed,
        vec![installed_mod("old-uid"), installed_mod(MOD_UID)],
        "the mod on disk is in the installed list"
    );
    assert_nothing_announced(&app);
}

/// An update is called off through the token the port is handed, not by
/// dropping it: only the port knows when the old version starts going. One
/// called off during its download ends idle, with the installed version
/// still listed.
#[tokio::test]
async fn cancelling_a_mod_update_during_its_download_keeps_the_installed_version() {
    let mods = Arc::new(HeldMods::default());
    let app = start(Ports {
        mods: mods.clone(),
        ..fake_ports()
    });
    run(&app, ModsCommand::LoadInstalled).await;
    let mut events = app.subscribe();

    let update = spawn_command(
        &app,
        ModsCommand::UpdateMod {
            uid: MOD_UID.into(),
            folder_name: "totalmayhem".into(),
            download_url: "https://content.faforever.com/mods/totalmayhem.v2.zip".into(),
        },
    );
    until(&mut events, |event| {
        matches!(
            event,
            AppEvent::Mods(ModsEvent::InstallProgressed {
                progress: Some(30),
                ..
            })
        )
    })
    .await;
    run(
        &app,
        ModsCommand::CancelInstall {
            uid: MOD_UID.into(),
        },
    )
    .await;
    finish(update).await;

    assert!(mods.update_saw_call_off.load(Ordering::SeqCst));
    let state = app.snapshot().mods;
    assert_eq!(state.install_status, ModInstallStatus::Idle);
    assert_eq!(state.installed, vec![installed_mod("old-uid")]);
    assert_nothing_announced(&app);
}

// ── Replay downloads into the library ──────────────────────────────────────

fn local_replay(uid: i32) -> LocalReplay {
    LocalReplay {
        path: format!("C:/replays/{uid}.fafreplay"),
        file_name: format!("{uid}.fafreplay"),
        uid: Some(uid),
        map: "scmp_009".into(),
        mod_name: "faf".into(),
        title: "Ladder night".into(),
        recorder: String::new(),
        start_time: None,
        duration_seconds: None,
        modified_time: 0,
        file_size_bytes: 1_024,
        num_players: 2,
        teams: Vec::new(),
        average_rating: None,
        sim_mods: Vec::new(),
        status: LocalReplayStatus::Complete,
        watchable: true,
        game_version: None,
    }
}

/// A replay vault whose first download holds half-way until it is dropped;
/// later ones answer at once.
#[derive(Default)]
struct HeldVault {
    dropped: Arc<AtomicBool>,
    downloads: AtomicUsize,
}

#[async_trait]
impl ReplayVaultPort for HeldVault {
    async fn search_vault(&self, query: ReplayQuery) -> Result<VaultSearchResult, String> {
        FakeReplay.search_vault(query).await
    }
    async fn list_featured_mods(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    async fn download_vault(&self, uid: i32) -> Result<LocalReplay, String> {
        Ok(local_replay(uid))
    }
    async fn download_vault_reporting(
        &self,
        uid: i32,
        progress: Arc<dyn Fn(u64, Option<u64>) + Send + Sync>,
    ) -> Result<LocalReplay, String> {
        if self.downloads.fetch_add(1, Ordering::SeqCst) == 0 {
            let _flag = DroppedFlag(self.dropped.clone());
            progress(40, Some(100));
            std::future::pending::<()>().await;
        }
        Ok(local_replay(uid))
    }
}

#[tokio::test]
async fn cancelling_a_library_download_drops_it_and_lets_the_next_one_run() {
    let vault = Arc::new(HeldVault::default());
    let app = start(Ports {
        replay_vault: vault.clone(),
        ..fake_ports()
    });
    let mut events = app.subscribe();

    let download = spawn_command(&app, ReplayCommand::DownloadVault { uid: 42 });
    until(&mut events, |event| {
        matches!(
            event,
            AppEvent::Replays(ReplayEvent::VaultDownloadProgressed {
                uid: 42,
                progress: Some(40)
            })
        )
    })
    .await;
    run(&app, ReplayCommand::CancelDownload { uid: 41 }).await;
    assert!(
        !vault.dropped.load(Ordering::SeqCst),
        "another replay's cancel"
    );
    run(&app, ReplayCommand::CancelDownload { uid: 42 }).await;
    finish(download).await;

    assert!(
        vault.dropped.load(Ordering::SeqCst),
        "the download was not dropped"
    );
    let replays = app.snapshot().replays;
    assert_eq!(replays.download_status, ReplayDownloadStatus::Idle);
    assert!(replays.local.is_empty(), "nothing reached the library");
    assert_nothing_announced(&app);

    // Asked for again, it downloads.
    run(&app, ReplayCommand::DownloadVault { uid: 42 }).await;
    assert!(matches!(
        app.snapshot().replays.download_status,
        ReplayDownloadStatus::Downloaded { uid: 42, .. }
    ));
}

// ── Replay panel reads ─────────────────────────────────────────────────────

/// Reads of replay files whose first details and analysis reads hold until
/// they are dropped. Later reads answer at once.
#[derive(Default)]
struct HeldReader {
    entered: Notify,
    details_asked: AtomicUsize,
    analyses_asked: AtomicUsize,
    dropped: Mutex<Vec<&'static str>>,
}

/// Records which read was dropped.
struct DroppedRead<'a> {
    what: &'static str,
    into: &'a Mutex<Vec<&'static str>>,
}

impl Drop for DroppedRead<'_> {
    fn drop(&mut self) {
        self.into.lock().unwrap().push(self.what);
    }
}

#[async_trait]
impl ReplayDetailsPort for HeldReader {
    async fn load_details(
        &self,
        _uid: i32,
        _local_path: Option<PathBuf>,
    ) -> Result<ReplayDetails, String> {
        if self.details_asked.fetch_add(1, Ordering::SeqCst) == 0 {
            let _held = DroppedRead {
                what: "details",
                into: &self.dropped,
            };
            self.entered.notify_one();
            std::future::pending::<()>().await;
        }
        Ok(ReplayDetails::default())
    }

    async fn load_analysis(
        &self,
        uid: i32,
        _local_path: Option<PathBuf>,
    ) -> Result<ReplayAnalysis, String> {
        if self.analyses_asked.fetch_add(1, Ordering::SeqCst) == 0 {
            let _held = DroppedRead {
                what: "analysis",
                into: &self.dropped,
            };
            self.entered.notify_one();
            std::future::pending::<()>().await;
        }
        Ok(ReplayAnalysis {
            uid,
            ..ReplayAnalysis::default()
        })
    }
}

/// The replay detail panel closes while its details and analysis are being
/// read. Both reads are called off rather than read to the end for nobody;
/// their loading lines go without a failure; and the next panel on the same
/// replay asks again and is answered, rather than waiting on a read that is
/// not coming.
#[tokio::test]
async fn closing_a_replay_panel_calls_off_its_details_and_analysis() {
    let reader = Arc::new(HeldReader::default());
    let app = start(Ports {
        replay_details: reader.clone(),
        ..fake_ports()
    });
    let key = replay_read_key(4242, None);

    let details = spawn_command(
        &app,
        ReplayCommand::LoadDetails {
            uid: 4242,
            local_path: None,
        },
    );
    let analysis = spawn_command(
        &app,
        ReplayCommand::LoadAnalysis {
            uid: 4242,
            local_path: None,
        },
    );
    reader.entered.notified().await;
    reader.entered.notified().await;

    // Another replay's panel closing leaves these alone.
    run(
        &app,
        ReplayCommand::CancelReads {
            uid: 5151,
            local_path: None,
        },
    )
    .await;
    assert!(reader.dropped.lock().unwrap().is_empty());
    run(
        &app,
        ReplayCommand::CancelReads {
            uid: 4242,
            local_path: None,
        },
    )
    .await;
    finish(details).await;
    finish(analysis).await;

    let mut dropped = reader.dropped.lock().unwrap().clone();
    dropped.sort_unstable();
    assert_eq!(dropped, ["analysis", "details"], "a read ran on for nobody");
    let replays = app.snapshot().replays;
    assert_eq!(replays.details_loading, None);
    assert_eq!(replays.analysis_loading, None);
    assert_eq!(replays.details_error, None, "a call-off is not a failure");
    assert_eq!(replays.analysis_error, None);
    assert_nothing_announced(&app);

    // The panel opened again asks again, and its reads land.
    run(
        &app,
        ReplayCommand::LoadDetails {
            uid: 4242,
            local_path: None,
        },
    )
    .await;
    run(
        &app,
        ReplayCommand::LoadAnalysis {
            uid: 4242,
            local_path: None,
        },
    )
    .await;
    assert_eq!(reader.analyses_asked.load(Ordering::SeqCst), 2);
    let replays = app.snapshot().replays;
    assert!(replays.replay_details.contains_key(&key));
    assert_eq!(replays.analysis.map(|analysis| analysis.key), Some(key));
}

// ── Publishing ─────────────────────────────────────────────────────────────

/// A publish that packs, then waits for the call-off, and ends `Idle` when
/// it comes, the way the real adapter ends a publish called off in time.
#[derive(Default)]
struct HeldUploads {
    called_off: Arc<Notify>,
    cancels: AtomicUsize,
    publishes: AtomicUsize,
}

#[async_trait]
impl UploadsPort for HeldUploads {
    async fn publish(&self, _request: UploadRequest) -> mpsc::Receiver<UploadStatus> {
        let (tx, rx) = mpsc::channel(8);
        let first = self.publishes.fetch_add(1, Ordering::SeqCst) == 0;
        let called_off = self.called_off.clone();
        tokio::spawn(async move {
            let _ = tx
                .send(UploadStatus::Uploading {
                    sent_bytes: 10,
                    total_bytes: 100,
                })
                .await;
            if first {
                called_off.notified().await;
                let _ = tx.send(UploadStatus::Idle).await;
            } else {
                let _ = tx.send(UploadStatus::Succeeded).await;
            }
        });
        rx
    }

    async fn map_preview(&self, _request: UploadRequest) -> String {
        String::new()
    }

    fn cancel_publish(&self) {
        self.cancels.fetch_add(1, Ordering::SeqCst);
        self.called_off.notify_one();
    }
}

fn upload_request() -> UploadRequest {
    UploadRequest {
        kind: UploadKind::Map,
        folder_name: "my_map.v0001".into(),
        display_name: "My Map".into(),
        ranked: false,
        source_path: None,
        rename_to: String::new(),
    }
}

/// A publish called off while its bytes are moving is asked to stop, ends
/// idle rather than failed, raises nothing, and the next publish runs.
#[tokio::test]
async fn cancelling_a_publish_ends_it_idle_and_lets_the_next_one_run() {
    let uploads = Arc::new(HeldUploads::default());
    let app = start(Ports {
        uploads: uploads.clone(),
        ..fake_ports()
    });
    run(
        &app,
        UploadsCommand::Open {
            request: upload_request(),
        },
    )
    .await;
    let mut events = app.subscribe();

    let publish = spawn_command(&app, UploadsCommand::Start);
    until(&mut events, |event| {
        matches!(
            event,
            AppEvent::Uploads(UploadsEvent::Progressed {
                status: UploadStatus::Uploading { .. }
            })
        )
    })
    .await;
    // Hidden mid-publish, as from the dialog's Hide: the bar is where the
    // Cancel is now.
    run(&app, UploadsCommand::Close).await;
    run(&app, UploadsCommand::Cancel).await;
    finish(publish).await;

    assert_eq!(uploads.cancels.load(Ordering::SeqCst), 1);
    assert_eq!(app.snapshot().uploads.status, UploadStatus::Idle);
    assert_nothing_announced(&app);

    // The single publish slot is free again.
    run(
        &app,
        UploadsCommand::Open {
            request: upload_request(),
        },
    )
    .await;
    run(&app, UploadsCommand::Start).await;
    assert_eq!(uploads.publishes.load(Ordering::SeqCst), 2);
    assert_eq!(app.snapshot().uploads.status, UploadStatus::Succeeded);
}

/// A publish whose every byte is out, waiting for the server's answer.
#[derive(Default)]
struct AnsweringUploads {
    answer: Arc<Notify>,
    cancels: AtomicUsize,
}

#[async_trait]
impl UploadsPort for AnsweringUploads {
    async fn publish(&self, _request: UploadRequest) -> mpsc::Receiver<UploadStatus> {
        let (tx, rx) = mpsc::channel(8);
        let answer = self.answer.clone();
        tokio::spawn(async move {
            let _ = tx
                .send(UploadStatus::Uploading {
                    sent_bytes: 100,
                    total_bytes: 100,
                })
                .await;
            answer.notified().await;
            let _ = tx.send(UploadStatus::Succeeded).await;
        });
        rx
    }

    async fn map_preview(&self, _request: UploadRequest) -> String {
        String::new()
    }

    fn cancel_publish(&self) {
        self.cancels.fetch_add(1, Ordering::SeqCst);
    }
}

/// Once the last byte is out the vault decides, so a cancel then does not
/// even ask the port, and the publish ends as the server says.
#[tokio::test]
async fn a_publish_whose_bytes_are_all_sent_is_not_asked_to_stop() {
    let uploads = Arc::new(AnsweringUploads::default());
    let app = start(Ports {
        uploads: uploads.clone(),
        ..fake_ports()
    });
    run(
        &app,
        UploadsCommand::Open {
            request: upload_request(),
        },
    )
    .await;
    let mut events = app.subscribe();

    let publish = spawn_command(&app, UploadsCommand::Start);
    until(&mut events, |event| {
        matches!(
            event,
            AppEvent::Uploads(UploadsEvent::Progressed {
                status: UploadStatus::Uploading {
                    sent_bytes: 100,
                    ..
                }
            })
        )
    })
    .await;
    run(&app, UploadsCommand::Cancel).await;
    uploads.answer.notify_one();
    finish(publish).await;

    assert_eq!(
        uploads.cancels.load(Ordering::SeqCst),
        0,
        "a publish the vault already has was asked to stop"
    );
    assert_eq!(app.snapshot().uploads.status, UploadStatus::Succeeded);
}

// ── The client's own update ────────────────────────────────────────────────

fn release() -> ClientRelease {
    ClientRelease {
        version: "9.9.9".into(),
        notes_url: "https://example.invalid/releases/9.9.9".into(),
        download_url: "https://example.invalid/installer".into(),
        asset_name: "installer".into(),
        size_bytes: 100,
        pre_release: false,
        published_at: "2026-02-01T00:00:00Z".into(),
    }
}

/// An installer download that reports a quarter and then waits for the
/// call-off it is handed, and ends the way the real adapter ends one.
#[derive(Default)]
struct HeldUpdates {
    downloads: AtomicUsize,
    saw_call_off: Arc<AtomicBool>,
}

#[async_trait]
impl ClientUpdatePort for HeldUpdates {
    async fn latest(
        &self,
        _channel: faf_domain::state::ReleaseChannel,
    ) -> Result<Option<ClientRelease>, String> {
        Ok(Some(release()))
    }

    async fn download(
        &self,
        _release: ClientRelease,
        called_off: tokio_util::sync::CancellationToken,
    ) -> mpsc::Receiver<DownloadProgress> {
        let (tx, rx) = mpsc::channel(8);
        let first = self.downloads.fetch_add(1, Ordering::SeqCst) == 0;
        let saw = self.saw_call_off.clone();
        tokio::spawn(async move {
            let _ = tx
                .send(DownloadProgress::Received {
                    received_bytes: 25,
                    total_bytes: 100,
                })
                .await;
            let outcome = if first {
                called_off.cancelled().await;
                saw.store(true, Ordering::SeqCst);
                Err("the download was called off".to_string())
            } else {
                Ok("installer.exe".to_string())
            };
            let _ = tx.send(DownloadProgress::Finished(outcome)).await;
        });
        rx
    }

    async fn install(&self, _path: String) -> Result<(), String> {
        Ok(())
    }
}

#[tokio::test]
async fn cancelling_the_client_update_download_stops_it_and_keeps_the_offer() {
    let updates = Arc::new(HeldUpdates::default());
    let app = start_as(
        "1.0.0",
        Ports {
            client_update: updates.clone(),
            ..fake_ports()
        },
    );
    run(&app, ClientUpdateCommand::Check).await;
    assert_eq!(
        app.snapshot().client_update.status,
        ClientUpdateStatus::Available
    );
    // The offer itself is announced; nothing after it may be.
    let announced = app.snapshot().notifications.items.len();
    let mut events = app.subscribe();

    let download = spawn_command(&app, ClientUpdateCommand::Download);
    until(&mut events, |event| {
        matches!(
            event,
            AppEvent::ClientUpdate(ClientUpdateEvent::DownloadProgressed {
                received_bytes: 25,
                ..
            })
        )
    })
    .await;
    run(&app, ClientUpdateCommand::CancelDownload).await;
    finish(download).await;

    assert!(
        updates.saw_call_off.load(Ordering::SeqCst),
        "the adapter never saw the call-off"
    );
    let state = app.snapshot().client_update;
    assert_eq!(
        state.status,
        ClientUpdateStatus::Available,
        "the offer stays"
    );
    assert_eq!(
        app.snapshot().notifications.items.len(),
        announced,
        "a call-off was announced as if something had gone wrong"
    );

    // The update key is free: the next download runs to the end.
    run(&app, ClientUpdateCommand::Download).await;
    assert_eq!(updates.downloads.load(Ordering::SeqCst), 2);
    assert_eq!(
        app.snapshot().client_update.status,
        ClientUpdateStatus::Ready {
            path: "installer.exe".into()
        }
    );
}

/// An installer download whose first attempt, once called off, takes a
/// while to clear its partial file away, the way the real adapter's worker
/// finishes its last write and deletes the file. Counts the attempts alive at
/// once: every attempt writes the same partial file.
#[derive(Default)]
struct LingeringUpdates {
    downloads: AtomicUsize,
    alive: Arc<AtomicUsize>,
    overlapped: Arc<AtomicBool>,
    saw_call_off: Arc<Notify>,
    cleared: Arc<Notify>,
}

#[async_trait]
impl ClientUpdatePort for LingeringUpdates {
    async fn latest(
        &self,
        _channel: faf_domain::state::ReleaseChannel,
    ) -> Result<Option<ClientRelease>, String> {
        Ok(Some(release()))
    }

    async fn download(
        &self,
        _release: ClientRelease,
        called_off: tokio_util::sync::CancellationToken,
    ) -> mpsc::Receiver<DownloadProgress> {
        let (tx, rx) = mpsc::channel(8);
        let first = self.downloads.fetch_add(1, Ordering::SeqCst) == 0;
        if self.alive.fetch_add(1, Ordering::SeqCst) > 0 {
            self.overlapped.store(true, Ordering::SeqCst);
        }
        let (alive, saw_call_off, cleared) = (
            self.alive.clone(),
            self.saw_call_off.clone(),
            self.cleared.clone(),
        );
        tokio::spawn(async move {
            let _ = tx
                .send(DownloadProgress::Received {
                    received_bytes: 25,
                    total_bytes: 100,
                })
                .await;
            let outcome = if first {
                called_off.cancelled().await;
                saw_call_off.notify_one();
                // Still clearing its partial file away.
                cleared.notified().await;
                Err("the download was called off".to_string())
            } else {
                Ok("installer.exe".to_string())
            };
            let _ = tx.send(DownloadProgress::Finished(outcome)).await;
            alive.fetch_sub(1, Ordering::SeqCst);
        });
        rx
    }

    async fn install(&self, _path: String) -> Result<(), String> {
        Ok(())
    }
}

/// Download pressed again straight after Cancel. The cancel used to free the
/// update at once while the called-off worker was still running, so the
/// second attempt wrote the same partial file the first was about to delete.
/// The update stays busy until that worker has ended, and only then is the
/// offer back and the next download allowed.
#[tokio::test]
async fn a_cancelled_update_download_is_over_before_the_next_one_starts() {
    let updates = Arc::new(LingeringUpdates::default());
    let app = start_as(
        "1.0.0",
        Ports {
            client_update: updates.clone(),
            ..fake_ports()
        },
    );
    run(&app, ClientUpdateCommand::Check).await;
    let mut events = app.subscribe();

    let mut download = spawn_command(&app, ClientUpdateCommand::Download);
    until(&mut events, |event| {
        matches!(
            event,
            AppEvent::ClientUpdate(ClientUpdateEvent::DownloadProgressed {
                received_bytes: 25,
                ..
            })
        )
    })
    .await;
    run(&app, ClientUpdateCommand::CancelDownload).await;
    tokio::time::timeout(Duration::from_secs(10), updates.saw_call_off.notified())
        .await
        .expect("the adapter never saw the call-off");

    // Pressed again while the first is still clearing up: not started.
    run(&app, ClientUpdateCommand::Download).await;
    assert_eq!(updates.downloads.load(Ordering::SeqCst), 1);
    assert!(
        !updates.overlapped.load(Ordering::SeqCst),
        "a second download ran beside the called-off one"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut download)
            .await
            .is_err(),
        "the cancel was reported before the download had ended"
    );

    updates.cleared.notify_one();
    finish(download).await;
    assert_eq!(
        app.snapshot().client_update.status,
        ClientUpdateStatus::Available,
        "the offer is back once the download has ended"
    );

    run(&app, ClientUpdateCommand::Download).await;
    assert_eq!(updates.downloads.load(Ordering::SeqCst), 2);
    assert!(!updates.overlapped.load(Ordering::SeqCst));
    assert_eq!(
        app.snapshot().client_update.status,
        ClientUpdateStatus::Ready {
            path: "installer.exe".into()
        }
    );
}
