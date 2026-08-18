//! The map catalogue is crawled once, not once per tab visit.
//!
//! `LoadVault` is the most expensive command this client has: it walks the whole
//! FAF map catalogue. Most callers checked `vaultStatus` before sending it, but
//! the two on the Play tab did not, so every visit to Play threw a finished
//! catalogue away and crawled it again. The guard now lives in the service, and
//! this pins it there.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{MapSearchPage, MapsPort};
use faf_app::{App, Ports};
use faf_domain::protocol::vault_query::MapVaultQuery;
use faf_domain::state::{InstalledMap, MapListStatus, MapsCommand, MatchmakerMapPool, VaultMap};

/// Counts crawls. `list_vault` is the only method under test.
#[derive(Default)]
struct CountingMaps {
    crawls: Arc<AtomicUsize>,
    fail: bool,
}

#[async_trait]
impl MapsPort for CountingMaps {
    async fn list_vault(&self) -> Result<Vec<VaultMap>, String> {
        self.crawls.fetch_add(1, Ordering::SeqCst);
        if self.fail {
            return Err("the vault is unreachable".into());
        }
        Ok(Vec::new())
    }

    async fn search_vault(&self, _query: MapVaultQuery) -> Result<MapSearchPage, String> {
        unreachable!("this test only drives the catalogue crawl")
    }

    async fn list_installed(&self) -> Result<Vec<InstalledMap>, String> {
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
}

fn app_with(fail: bool) -> (App, Arc<AtomicUsize>) {
    let crawls = Arc::new(AtomicUsize::new(0));
    let ports = Ports {
        maps: Arc::new(CountingMaps {
            crawls: crawls.clone(),
            fail,
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    (app, crawls)
}

#[tokio::test]
async fn a_loaded_catalogue_is_not_crawled_again() {
    let (app, crawls) = app_with(false);

    app.dispatch_and_wait(MapsCommand::LoadVault.into())
        .await
        .unwrap();
    assert_eq!(app.snapshot().maps.vault_status, MapListStatus::Ready);

    // Opening the Play tab, then the host dialog, then Play again.
    for _ in 0..3 {
        app.dispatch_and_wait(MapsCommand::LoadVault.into())
            .await
            .unwrap();
    }

    assert_eq!(
        crawls.load(Ordering::SeqCst),
        1,
        "the catalogue must be crawled once, however many callers ask for it"
    );
    assert_eq!(app.snapshot().maps.vault_status, MapListStatus::Ready);
}

/// The guard is about repeating *successful* work. A vault that failed, because
/// the user was offline for the first attempt, has to be retryable or the tab
/// stays empty for the rest of the session.
#[tokio::test]
async fn a_failed_catalogue_is_retried() {
    let (app, crawls) = app_with(true);

    app.dispatch_and_wait(MapsCommand::LoadVault.into())
        .await
        .unwrap();
    assert!(matches!(
        app.snapshot().maps.vault_status,
        MapListStatus::Failed { .. }
    ));

    app.dispatch_and_wait(MapsCommand::LoadVault.into())
        .await
        .unwrap();

    assert_eq!(
        crawls.load(Ordering::SeqCst),
        2,
        "a failure must be retryable"
    );
}
