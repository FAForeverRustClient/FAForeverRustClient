//! "Check for updates" in Installed mods has to read the catalogue again.
//!
//! `LoadVault` deliberately refuses a second crawl, and the check used to send
//! it: the comparison then ran against the catalogue from the start of the
//! session and reported "every installed mod is up to date" without looking.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{ModPrepFailure, ModSearchPage, ModsPort};
use faf_app::{App, Ports};
use faf_domain::protocol::vault_query::ModVaultQuery;
use faf_domain::state::{
    InstalledMod, ModDownloadSize, ModDownloadTarget, ModListStatus, ModsCommand, VaultMod,
};

/// A vault that always answers, and counts how often it was asked.
#[derive(Default)]
struct CountingVault {
    crawls: Arc<AtomicUsize>,
}

#[async_trait]
impl ModsPort for CountingVault {
    async fn list_vault(&self) -> Result<Vec<VaultMod>, String> {
        self.crawls.fetch_add(1, Ordering::SeqCst);
        Ok(Vec::new())
    }
    async fn search_vault(&self, _query: ModVaultQuery) -> Result<ModSearchPage, String> {
        Err("not used".into())
    }
    async fn list_installed(&self) -> Result<Vec<InstalledMod>, String> {
        Err("not used".into())
    }
    async fn download_sizes(&self, _targets: Vec<ModDownloadTarget>) -> Vec<ModDownloadSize> {
        Vec::new()
    }
    async fn install_mod(&self, _uid: String, _url: String) -> Result<Vec<InstalledMod>, String> {
        Err("not used".into())
    }
    async fn update_mod(
        &self,
        _uid: String,
        _folder_name: String,
        _url: String,
    ) -> Result<Vec<InstalledMod>, String> {
        Err("not used".into())
    }
    async fn uninstall_mod(&self, _folder_name: String) -> Result<Vec<InstalledMod>, String> {
        Err("not used".into())
    }
    async fn toggle_mod(&self, _uid: String, _enabled: bool) -> Result<Vec<InstalledMod>, String> {
        Err("not used".into())
    }
    async fn set_active_mods(&self, _uids: Vec<String>) -> Result<Vec<InstalledMod>, String> {
        Err("not used".into())
    }
    async fn ensure_game_mods(
        &self,
        _mods: &BTreeMap<String, String>,
        _replace_conflicts: bool,
    ) -> Result<(), ModPrepFailure> {
        Ok(())
    }
}

async fn wait_until_ready(app: &App) {
    for _ in 0..200 {
        if app.snapshot().mods.vault_status == ModListStatus::Ready {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the catalogue never reported ready");
}

#[tokio::test]
async fn a_reload_reads_the_catalogue_again_where_a_load_would_not() {
    let vault = CountingVault::default();
    let crawls = vault.crawls.clone();
    let ports = Ports {
        mods: Arc::new(vault),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());

    app.dispatch_and_wait(ModsCommand::LoadVault.into())
        .await
        .unwrap();
    wait_until_ready(&app).await;
    assert_eq!(crawls.load(Ordering::SeqCst), 1);

    // The guard that keeps the catalogue to one crawl per session still holds.
    app.dispatch_and_wait(ModsCommand::LoadVault.into())
        .await
        .unwrap();
    assert_eq!(
        crawls.load(Ordering::SeqCst),
        1,
        "a second LoadVault must not crawl"
    );

    // And the reload goes past it.
    app.dispatch_and_wait(ModsCommand::ReloadVault.into())
        .await
        .unwrap();
    wait_until_ready(&app).await;
    assert_eq!(crawls.load(Ordering::SeqCst), 2);
}
