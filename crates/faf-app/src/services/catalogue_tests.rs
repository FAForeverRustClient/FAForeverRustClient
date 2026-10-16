//! Catalogue service regressions with a shared in-memory disk-cache stand-in.
use crate::{
    infra::fake_ports,
    ports::{
        catalogue::{CachedCatalogue, CatalogueBatch},
        MapSearchPage, MapsPort, ModPrepFailure, ModSearchPage, ModsPort,
    },
    App, Ports,
};
use async_trait::async_trait;
use chrono::{Duration, Utc};
use faf_domain::{
    state::{
        InstalledMap, InstalledMod, MapListStatus, MapsCommand, MapsEvent, MatchmakerMapPool,
        ModDownloadSize, ModDownloadTarget, ModListStatus, ModType, ModsCommand, ModsEvent,
        VaultMap, VaultMod,
    },
    AppEvent,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tokio::sync::{mpsc, Notify};

const CHANGE: &str = "2026-10-01T12:00:00Z";
const NEW_CHANGE: &str = "2026-10-02T12:00:00Z";
struct Script<T> {
    cache: Mutex<Option<CachedCatalogue<T>>>,
    answer: Mutex<Result<CatalogueBatch<T>, String>>,
    requests: Mutex<Vec<String>>,
    block: AtomicBool,
    entered: Notify,
    release: Notify,
}
impl<T: Clone> Script<T> {
    fn new(cache: Option<CachedCatalogue<T>>, entries: Vec<T>) -> Arc<Self> {
        Arc::new(Self {
            cache: Mutex::new(cache),
            answer: Mutex::new(Ok(CatalogueBatch {
                entries,
                newest_change: NEW_CHANGE.into(),
                removed_ids: vec![],
                pages: 1,
            })),
            requests: Mutex::new(vec![]),
            block: AtomicBool::new(false),
            entered: Notify::new(),
            release: Notify::new(),
        })
    }
    async fn read(&self, request: &str) -> Result<CatalogueBatch<T>, String> {
        self.requests.lock().unwrap().push(request.into());
        self.entered.notify_one();
        if self.block.load(Ordering::SeqCst) {
            self.release.notified().await;
        }
        self.answer.lock().unwrap().clone()
    }
}
fn saved<T>(entries: Vec<T>, days: i64) -> CachedCatalogue<T> {
    CachedCatalogue {
        full_at: (Utc::now() - Duration::days(days)).to_rfc3339(),
        newest_change: CHANGE.into(),
        entries,
    }
}
fn map(id: i32, version: i32) -> VaultMap {
    VaultMap {
        map_id: id,
        version_id: version,
        ..vault_map(&format!("map_{id}.v{version}"))
    }
}
fn mod_entry(id: i32, version: i32) -> VaultMod {
    VaultMod {
        mod_id: id,
        version_id: version,
        ..vault_mod(&format!("uid_{id}_{version}"))
    }
}
fn vault_map(folder_name: &str) -> VaultMap {
    VaultMap {
        map_id: 1,
        version_id: 1,
        display_name: "Seton's Clutch".into(),
        author: Some("Rackover".into()),
        author_id: Some(4711),
        folder_name: folder_name.into(),
        version: "1".into(),
        description: "A classic team map.".into(),
        map_type: "skirmish".into(),
        max_players: 8,
        width: 1024,
        height: 1024,
        games_played: 42,
        version_games_played: 40,
        ranked: true,
        hidden: false,
        recommended: false,
        rating_tenths: 45,
        reviews: 12,
        created_at: "2026-01-01T00:00:00Z".into(),
        download_url: "https://content.faforever.com/maps/setons_clutch.zip".into(),
        thumbnail_url: "https://content.faforever.com/maps/setons_clutch.small.png".into(),
        thumbnail_url_large: "https://content.faforever.com/maps/setons_clutch.large.png".into(),
    }
}
fn vault_mod(uid: &str) -> VaultMod {
    VaultMod {
        mod_id: 1,
        version_id: 1,
        display_name: "Total Mayhem".into(),
        author: "Some Author".into(),
        uploader: "Uploader".into(),
        uploader_id: Some(4711),
        uid: uid.into(),
        version: "12".into(),
        description: "Adds new units and experimentals.".into(),
        filename: "total_mayhem.zip".into(),
        mod_type: ModType::Sim,
        ranked: false,
        recommended: false,
        rating_tenths: 44,
        reviews: 21,
        created_at: "2025-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
        download_url: "https://content.faforever.com/mods/total_mayhem.zip".into(),
        thumbnail_url: "https://content.faforever.com/mods/total_mayhem.png".into(),
    }
}
#[async_trait]
impl MapsPort for Script<VaultMap> {
    async fn load_catalogue_cache(&self) -> Option<CachedCatalogue<VaultMap>> {
        self.cache.lock().unwrap().clone()
    }
    async fn save_catalogue_cache(&self, cache: CachedCatalogue<VaultMap>) -> Result<(), String> {
        *self.cache.lock().unwrap() = Some(cache);
        Ok(())
    }
    async fn catalogue_full(
        &self,
        progress: Option<mpsc::Sender<faf_domain::state::maps::CatalogueProgress>>,
    ) -> Result<CatalogueBatch<VaultMap>, String> {
        if let Some(progress) = progress {
            let _ = progress
                .send(faf_domain::state::maps::CatalogueProgress {
                    pages: 1,
                    total_pages: Some(3),
                })
                .await;
        }
        self.read("full").await
    }
    async fn catalogue_delta(&self, since: &str) -> Result<CatalogueBatch<VaultMap>, String> {
        self.read(since).await
    }
    async fn list_vault(&self) -> Result<Vec<VaultMap>, String> {
        unreachable!()
    }
    async fn search_vault(
        &self,
        _query: faf_domain::protocol::vault_query::MapVaultQuery,
    ) -> Result<MapSearchPage, String> {
        unreachable!()
    }
    async fn list_installed(&self) -> Result<Vec<InstalledMap>, String> {
        unreachable!()
    }
    async fn list_matchmaker_pools(&self, _: String) -> Result<Vec<MatchmakerMapPool>, String> {
        unreachable!()
    }
    async fn install_map(&self, _: String, _: String) -> Result<Vec<InstalledMap>, String> {
        unreachable!()
    }
    async fn uninstall_map(&self, _: String) -> Result<Vec<InstalledMap>, String> {
        unreachable!()
    }
    async fn set_map_version_hidden(&self, _: i32, _: bool) -> Result<(), String> {
        unreachable!()
    }
}
fn maps_app(script: Arc<Script<VaultMap>>) -> Arc<App> {
    let (app, runner) = App::new(
        "test",
        Ports {
            maps: script,
            ..fake_ports()
        },
    );
    tokio::spawn(runner.run());
    Arc::new(app)
}
#[async_trait]
impl ModsPort for Script<VaultMod> {
    async fn load_catalogue_cache(&self) -> Option<CachedCatalogue<VaultMod>> {
        self.cache.lock().unwrap().clone()
    }
    async fn save_catalogue_cache(&self, cache: CachedCatalogue<VaultMod>) -> Result<(), String> {
        *self.cache.lock().unwrap() = Some(cache);
        Ok(())
    }
    async fn catalogue_full(
        &self,
        progress: Option<mpsc::Sender<faf_domain::state::maps::CatalogueProgress>>,
    ) -> Result<CatalogueBatch<VaultMod>, String> {
        if let Some(progress) = progress {
            let _ = progress
                .send(faf_domain::state::maps::CatalogueProgress {
                    pages: 1,
                    total_pages: Some(3),
                })
                .await;
        }
        self.read("full").await
    }
    async fn catalogue_delta(&self, since: &str) -> Result<CatalogueBatch<VaultMod>, String> {
        self.read(since).await
    }
    async fn list_vault(&self) -> Result<Vec<VaultMod>, String> {
        unreachable!()
    }
    async fn search_vault(
        &self,
        _query: faf_domain::protocol::vault_query::ModVaultQuery,
    ) -> Result<ModSearchPage, String> {
        unreachable!()
    }
    async fn list_installed(&self) -> Result<Vec<InstalledMod>, String> {
        unreachable!()
    }
    async fn download_sizes(&self, _: Vec<ModDownloadTarget>) -> Vec<ModDownloadSize> {
        unreachable!()
    }
    async fn install_mod(&self, _: String, _: String) -> Result<Vec<InstalledMod>, String> {
        unreachable!()
    }
    async fn update_mod(
        &self,
        _: String,
        _: String,
        _: String,
    ) -> Result<Vec<InstalledMod>, String> {
        unreachable!()
    }
    async fn uninstall_mod(&self, _: String) -> Result<Vec<InstalledMod>, String> {
        unreachable!()
    }
    async fn toggle_mod(&self, _: String, _: bool) -> Result<Vec<InstalledMod>, String> {
        unreachable!()
    }
    async fn set_active_mods(&self, _: Vec<String>) -> Result<Vec<InstalledMod>, String> {
        unreachable!()
    }
    async fn ensure_game_mods(
        &self,
        _: &std::collections::BTreeMap<String, String>,
        _: bool,
    ) -> Result<(), ModPrepFailure> {
        unreachable!()
    }
}
fn mods_app(script: Arc<Script<VaultMod>>) -> Arc<App> {
    let (app, runner) = App::new(
        "test",
        Ports {
            mods: script,
            ..fake_ports()
        },
    );
    tokio::spawn(runner.run());
    Arc::new(app)
}

#[tokio::test]
async fn catalogue_cold_then_warm_start_uses_a_delta_and_preserves_fields() {
    let script = Script::new(None, vec![map(1, 11), map(2, 22)]);
    script.block.store(true, Ordering::SeqCst);
    let app = maps_app(script.clone());
    let cold = {
        let app = app.clone();
        tokio::spawn(async move {
            app.dispatch_and_wait(MapsCommand::LoadVault.into())
                .await
                .unwrap()
        })
    };
    script.entered.notified().await;
    assert_eq!(app.snapshot().maps.vault_status, MapListStatus::Loading);
    assert_eq!(
        app.snapshot().maps.vault_progress.as_ref().unwrap().pages,
        1
    );
    script.release.notify_one();
    cold.await.unwrap();
    assert_eq!(*script.requests.lock().unwrap(), ["full"]);
    assert_eq!(
        script.cache.lock().unwrap().as_ref().unwrap().entries,
        app.snapshot().maps.vault
    );
    assert_eq!(
        app.snapshot().maps.vault[0].description,
        map(1, 11).description
    );
    let full_at = script
        .cache
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .full_at
        .clone();
    let changed = map(1, 12);
    *script.answer.lock().unwrap() = Ok(CatalogueBatch {
        entries: vec![
            changed.clone(),
            map(3, 33),
            VaultMap {
                hidden: true,
                ..map(2, 22)
            },
        ],
        newest_change: NEW_CHANGE.into(),
        removed_ids: vec![],
        pages: 1,
    });
    script.block.store(true, Ordering::SeqCst);
    let app = maps_app(script.clone());
    let (mut events, _) = app.subscribe_with_snapshot();
    let task = {
        let app = app.clone();
        tokio::spawn(async move {
            app.dispatch_and_wait(MapsCommand::LoadVault.into())
                .await
                .unwrap()
        })
    };
    script.entered.notified().await;
    assert_eq!(app.snapshot().maps.vault_status, MapListStatus::Ready);
    assert_eq!(app.snapshot().maps.vault.len(), 2);
    assert!(app.snapshot().maps.vault_progress.is_none());
    script.release.notify_one();
    task.await.unwrap();
    assert_eq!(app.snapshot().maps.vault, vec![changed, map(3, 33)]);
    let cache = script.cache.lock().unwrap().clone().unwrap();
    assert_eq!(cache.entries, app.snapshot().maps.vault);
    assert_eq!(cache.full_at, full_at);
    assert_eq!(script.requests.lock().unwrap()[1], NEW_CHANGE);
    while let Ok(event) = events.try_recv() {
        assert!(!matches!(
            event,
            AppEvent::Maps(MapsEvent::VaultLoading | MapsEvent::VaultProgress { .. })
        ));
    }
}

#[tokio::test]
async fn catalogue_aged_cache_refreshes_quietly_and_removes_deleted_records() {
    let script = Script::new(
        Some(saved(vec![map(1, 11), map(2, 22)], 8)),
        vec![map(1, 12)],
    );
    script.block.store(true, Ordering::SeqCst);
    let app = maps_app(script.clone());
    let (mut events, _) = app.subscribe_with_snapshot();
    let task = {
        let app = app.clone();
        tokio::spawn(async move {
            app.dispatch_and_wait(MapsCommand::LoadVault.into())
                .await
                .unwrap()
        })
    };
    script.entered.notified().await;
    assert_eq!(app.snapshot().maps.vault_status, MapListStatus::Ready);
    assert_eq!(app.snapshot().maps.vault.len(), 2);
    script.release.notify_one();
    task.await.unwrap();
    assert_eq!(*script.requests.lock().unwrap(), ["full"]);
    assert_eq!(app.snapshot().maps.vault, vec![map(1, 12)]);
    assert!(!script
        .cache
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .needs_full_refresh(Utc::now()));
    while let Ok(event) = events.try_recv() {
        assert!(!matches!(
            event,
            AppEvent::Maps(MapsEvent::VaultLoading | MapsEvent::VaultProgress { .. })
        ));
    }
}

#[tokio::test]
async fn catalogue_background_failure_and_cancellation_preserve_the_snapshot() {
    for (days, cancel) in [(0, false), (8, false), (0, true), (8, true)] {
        let before = saved(vec![map(1, 11)], days);
        let script = Script::new(Some(before.clone()), vec![]);
        *script.answer.lock().unwrap() = Err("offline".into());
        script.block.store(cancel, Ordering::SeqCst);
        let app = maps_app(script.clone());
        let task = {
            let app = app.clone();
            tokio::spawn(async move {
                app.dispatch_and_wait(MapsCommand::LoadVault.into())
                    .await
                    .unwrap()
            })
        };
        script.entered.notified().await;
        if cancel {
            app.dispatch_and_wait(MapsCommand::CancelVaultLoad.into())
                .await
                .unwrap();
        }
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(app.snapshot().maps.vault_status, MapListStatus::Ready);
        assert_eq!(app.snapshot().maps.vault, before.entries);
        assert_eq!(*script.cache.lock().unwrap(), Some(before));
    }
}

#[tokio::test]
async fn catalogue_mod_reload_requests_a_delta_and_reports_completion() {
    let script = Script::new(
        Some(saved(vec![mod_entry(1, 11), mod_entry(2, 22)], 0)),
        vec![mod_entry(1, 12)],
    );
    script.answer.lock().unwrap().as_mut().unwrap().removed_ids = vec![2];
    let app = mods_app(script.clone());
    app.dispatch_and_wait(ModsCommand::LoadVault.into())
        .await
        .unwrap();
    assert_eq!(app.snapshot().mods.vault, vec![mod_entry(1, 12)]);
    let full_at = script
        .cache
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .full_at
        .clone();
    app.dispatch_and_wait(ModsCommand::LoadVault.into())
        .await
        .unwrap();
    assert_eq!(script.requests.lock().unwrap().len(), 1);
    let (mut events, _) = app.subscribe_with_snapshot();
    *script.answer.lock().unwrap() = Ok(CatalogueBatch {
        entries: vec![],
        newest_change: NEW_CHANGE.into(),
        removed_ids: vec![],
        pages: 1,
    });
    app.dispatch_and_wait(ModsCommand::ReloadVault.into())
        .await
        .unwrap();
    assert_eq!(*script.requests.lock().unwrap(), [CHANGE, NEW_CHANGE]);
    assert_eq!(
        script.cache.lock().unwrap().as_ref().unwrap().full_at,
        full_at
    );
    assert_eq!(app.snapshot().mods.vault_status, ModListStatus::Ready);
    assert_eq!(app.snapshot().mods.vault, vec![mod_entry(1, 12)]);
    let mut loading = false;
    let mut completed = false;
    while let Ok(event) = events.try_recv() {
        match event {
            AppEvent::Mods(ModsEvent::VaultLoading) => loading = true,
            AppEvent::Mods(ModsEvent::VaultUpdated { .. }) => {
                assert!(loading);
                completed = true;
            }
            _ => {}
        }
    }
    assert!(completed);
}

#[tokio::test]
async fn catalogue_manual_mod_check_waits_for_a_quiet_startup_refresh() {
    let script = Script::new(
        Some(saved(vec![mod_entry(1, 11)], 0)),
        vec![mod_entry(1, 12)],
    );
    script.block.store(true, Ordering::SeqCst);
    let app = mods_app(script.clone());
    let startup = {
        let app = app.clone();
        tokio::spawn(async move {
            app.dispatch_and_wait(ModsCommand::LoadVault.into())
                .await
                .unwrap()
        })
    };
    script.entered.notified().await;
    assert_eq!(app.snapshot().mods.vault_status, ModListStatus::Ready);
    let reload = {
        let app = app.clone();
        tokio::spawn(async move {
            app.dispatch_and_wait(ModsCommand::ReloadVault.into())
                .await
                .unwrap()
        })
    };
    tokio::task::yield_now().await;
    assert_eq!(script.requests.lock().unwrap().len(), 1);
    script.release.notify_one();
    startup.await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), script.entered.notified())
        .await
        .unwrap();
    assert_eq!(app.snapshot().mods.vault_status, ModListStatus::Loading);
    script.release.notify_one();
    reload.await.unwrap();
    assert_eq!(*script.requests.lock().unwrap(), [CHANGE, NEW_CHANGE]);
    assert_eq!(app.snapshot().mods.vault_status, ModListStatus::Ready);
}

#[tokio::test]
async fn catalogue_mod_cached_reads_remain_ready_on_failure_and_cancellation() {
    for (days, cancel) in [(0, false), (8, false), (0, true), (8, true)] {
        let before = saved(vec![mod_entry(1, 11)], days);
        let script = Script::new(Some(before.clone()), vec![]);
        *script.answer.lock().unwrap() = Err("offline".into());
        script.block.store(cancel, Ordering::SeqCst);
        let app = mods_app(script.clone());
        let task = {
            let app = app.clone();
            tokio::spawn(async move {
                app.dispatch_and_wait(ModsCommand::LoadVault.into())
                    .await
                    .unwrap()
            })
        };
        script.entered.notified().await;
        assert_eq!(app.snapshot().mods.vault_status, ModListStatus::Ready);
        if cancel {
            app.dispatch_and_wait(ModsCommand::CancelVaultLoad.into())
                .await
                .unwrap();
        }
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(app.snapshot().mods.vault_status, ModListStatus::Ready);
        assert_eq!(app.snapshot().mods.vault, before.entries);
        assert_eq!(*script.cache.lock().unwrap(), Some(before));
    }
}
