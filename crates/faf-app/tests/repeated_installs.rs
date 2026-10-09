//! A second press on Install for a map or mod that the first press installed.
//!
//! Installs run one at a time, so the second waits for the first and only
//! then starts. It used to download the whole archive again and then fail
//! with "already installed", which put an error on screen straight after a
//! successful install. Now it finds the map or mod installed and does nothing.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakeMaps, FakeMods};
use faf_app::ports::{MapSearchPage, MapsPort, ModPrepFailure, ModSearchPage, ModsPort};
use faf_app::{App, Ports};
use faf_domain::protocol::vault_query::{MapVaultQuery, ModVaultQuery};
use faf_domain::state::{
    InstalledMap, InstalledMod, MapInstallStatus, MapsCommand, MatchmakerMapPool, ModDownloadSize,
    ModDownloadTarget, ModInstallStatus, ModType, ModsCommand, VaultMap, VaultMod,
};

const FOLDER: &str = "scmp_009.v0001";
const MOD_UID: &str = "mod-uid-1";

/// Installs `FOLDER` and counts how often it was asked to.
#[derive(Default)]
struct CountingMaps {
    installs: AtomicUsize,
}

#[async_trait]
impl MapsPort for CountingMaps {
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
        self.installs.fetch_add(1, Ordering::SeqCst);
        Ok(vec![InstalledMap {
            folder_name: folder,
            display_name: "Seton's Clutch".into(),
            max_players: 8,
            width: 1024,
            height: 1024,
            version: None,
            description: None,
            installed_at: None,
        }])
    }
    async fn uninstall_map(&self, folder: String) -> Result<Vec<InstalledMap>, String> {
        FakeMaps.uninstall_map(folder).await
    }
    async fn set_map_version_hidden(&self, version: i32, hidden: bool) -> Result<(), String> {
        FakeMaps.set_map_version_hidden(version, hidden).await
    }
}

/// Installs `MOD_UID` and counts how often it was asked to.
#[derive(Default)]
struct CountingMods {
    installs: AtomicUsize,
}

#[async_trait]
impl ModsPort for CountingMods {
    async fn list_vault(&self) -> Result<Vec<VaultMod>, String> {
        FakeMods.list_vault().await
    }
    async fn search_vault(&self, query: ModVaultQuery) -> Result<ModSearchPage, String> {
        FakeMods.search_vault(query).await
    }
    async fn list_installed(&self) -> Result<Vec<InstalledMod>, String> {
        Ok(Vec::new())
    }
    async fn download_sizes(&self, targets: Vec<ModDownloadTarget>) -> Vec<ModDownloadSize> {
        FakeMods.download_sizes(targets).await
    }
    async fn install_mod(&self, uid: String, _url: String) -> Result<Vec<InstalledMod>, String> {
        self.installs.fetch_add(1, Ordering::SeqCst);
        Ok(vec![InstalledMod {
            folder_name: "totalmayhem".into(),
            uid,
            display_name: "Total Mayhem".into(),
            version: "1".into(),
            author: "Some Author".into(),
            description: String::new(),
            mod_type: ModType::Sim,
            enabled: false,
        }])
    }
    async fn update_mod(
        &self,
        uid: String,
        folder: String,
        url: String,
    ) -> Result<Vec<InstalledMod>, String> {
        FakeMods.update_mod(uid, folder, url).await
    }
    async fn uninstall_mod(&self, folder: String) -> Result<Vec<InstalledMod>, String> {
        FakeMods.uninstall_mod(folder).await
    }
    async fn toggle_mod(&self, uid: String, enabled: bool) -> Result<Vec<InstalledMod>, String> {
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

fn start(ports: Ports) -> App {
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    app
}

#[tokio::test]
async fn a_second_install_of_the_same_map_downloads_nothing_and_reports_no_error() {
    let maps = Arc::new(CountingMaps::default());
    let app = start(Ports {
        maps: maps.clone(),
        ..fake_ports()
    });
    let install = || -> faf_domain::AppCommand {
        MapsCommand::InstallMap {
            folder_name: FOLDER.into(),
            download_url: "https://content.faforever.com/maps/scmp_009.v0001.zip".into(),
        }
        .into()
    };

    // Both pressed before either finished, as a double click is.
    let (first, second) = tokio::join!(
        app.dispatch_and_wait(install()),
        app.dispatch_and_wait(install())
    );
    first.unwrap();
    second.unwrap();

    assert_eq!(
        maps.installs.load(Ordering::SeqCst),
        1,
        "the map was downloaded twice"
    );
    let state = app.snapshot().maps;
    assert_eq!(state.install_status, MapInstallStatus::Idle);
    assert!(state.installed.iter().any(|map| map.folder_name == FOLDER));
}

#[tokio::test]
async fn a_second_install_of_the_same_mod_downloads_nothing_and_reports_no_error() {
    let mods = Arc::new(CountingMods::default());
    let app = start(Ports {
        mods: mods.clone(),
        ..fake_ports()
    });
    let install = || -> faf_domain::AppCommand {
        ModsCommand::InstallMod {
            uid: MOD_UID.into(),
            download_url: "https://content.faforever.com/mods/totalmayhem.zip".into(),
        }
        .into()
    };

    let (first, second) = tokio::join!(
        app.dispatch_and_wait(install()),
        app.dispatch_and_wait(install())
    );
    first.unwrap();
    second.unwrap();

    assert_eq!(
        mods.installs.load(Ordering::SeqCst),
        1,
        "the mod was downloaded twice"
    );
    let state = app.snapshot().mods;
    assert_eq!(state.install_status, ModInstallStatus::Idle);
    assert!(state
        .installed
        .iter()
        .any(|installed| installed.uid == MOD_UID));
}
