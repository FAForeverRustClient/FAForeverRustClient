//! Withdrawing your own map version from the vault, and the way back.
//!
//! Two things worth pinning. The reducer corrects the page in place rather than
//! refetching, so the entry the user just acted on has to be the one that
//! changes. And the two directions are not authorised alike: FAF lets an author
//! hide a version and only a map administrator unhide one, so the refusal has
//! to arrive as the server's own sentence rather than a status code.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{MapSearchPage, MapsPort};
use faf_app::{App, Ports};
use faf_domain::protocol::vault_query::MapVaultQuery;
use faf_domain::state::{
    InstalledMap, MapVisibilityStatus, MapsCommand, MatchmakerMapPool, VaultMap,
};

/// Records the patches it was asked for, and answers with a scripted outcome.
struct StubMaps {
    seen: Arc<Mutex<Vec<(i32, bool)>>>,
    outcome: Result<(), String>,
}

#[async_trait]
impl MapsPort for StubMaps {
    async fn list_vault(&self) -> Result<Vec<VaultMap>, String> {
        Ok(Vec::new())
    }

    async fn search_vault(&self, _query: MapVaultQuery) -> Result<MapSearchPage, String> {
        Ok(MapSearchPage {
            maps: vec![
                vault_map(1, 11, "scmp_009.v0001"),
                vault_map(2, 22, "open_palms.v0001"),
            ],
            total_pages: Some(1),
            total_records: Some(2),
        })
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

    async fn set_map_version_hidden(&self, version_id: i32, hidden: bool) -> Result<(), String> {
        self.seen.lock().unwrap().push((version_id, hidden));
        self.outcome.clone()
    }
}

fn vault_map(map_id: i32, version_id: i32, folder_name: &str) -> VaultMap {
    VaultMap {
        map_id,
        version_id,
        display_name: folder_name.into(),
        author: Some("Rackover".into()),
        author_id: Some(4711),
        folder_name: folder_name.into(),
        version: "1".into(),
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

/// An app whose browsed page already holds two of the player's own maps.
async fn app_with(outcome: Result<(), String>) -> (App, Arc<Mutex<Vec<(i32, bool)>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        maps: Arc::new(StubMaps {
            seen: seen.clone(),
            outcome,
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());

    // Seeded through the real path: "my maps" is a search like any other, and
    // the entries it puts in `browse` are what the buttons then act on.
    app.dispatch_and_wait(
        MapsCommand::SearchVault {
            query: MapVaultQuery {
                author_id: Some(4711),
                include_hidden: true,
                ..Default::default()
            },
        }
        .into(),
    )
    .await
    .unwrap();
    (app, seen)
}

#[tokio::test]
async fn hiding_a_version_patches_it_and_marks_only_that_entry() {
    let (app, seen) = app_with(Ok(())).await;

    app.dispatch_and_wait(
        MapsCommand::SetMapVersionHidden {
            version_id: 22,
            hidden: true,
        }
        .into(),
    )
    .await
    .unwrap();

    assert_eq!(seen.lock().unwrap().as_slice(), [(22, true)]);
    let maps = app.snapshot().maps;
    assert_eq!(maps.visibility_status, MapVisibilityStatus::Idle);
    assert!(!maps.browse[0].hidden, "the other version is untouched");
    assert!(maps.browse[1].hidden);
}

#[tokio::test]
async fn a_refusal_keeps_the_reason_and_leaves_the_flag_alone() {
    // The refusal an author will actually meet: unhiding needs the ADMIN_MAP
    // role, which is why the message has to say so instead of showing a 403.
    let (app, seen) = app_with(Err(
        "FAF only lets a map administrator put a hidden version back in the vault".into(),
    ))
    .await;

    app.dispatch_and_wait(
        MapsCommand::SetMapVersionHidden {
            version_id: 22,
            hidden: false,
        }
        .into(),
    )
    .await
    .unwrap();

    assert_eq!(seen.lock().unwrap().as_slice(), [(22, false)]);
    let maps = app.snapshot().maps;
    assert!(
        matches!(
            &maps.visibility_status,
            MapVisibilityStatus::Failed { reason } if reason.contains("map administrator")
        ),
        "{:?}",
        maps.visibility_status
    );
    assert!(!maps.browse[1].hidden, "a refused change changes nothing");
}
