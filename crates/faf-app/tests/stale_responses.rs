//! Answers that arrive after the user has moved on must not land.
//!
//! Commands run concurrently, so request order is not response order. Each test
//! here holds one port call open behind a gate, lets a newer request (or a
//! close, or a cleared field) overtake it, and then lets the old one answer.
//! The state must still describe the newer request.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakePlayerCard};
use faf_app::ports::{
    MapSearchPage, MapsPort, ModPrepFailure, ModSearchPage, ModsPort, PlayerCardPort, RequestError,
};
use faf_app::{App, Ports};
use faf_domain::protocol::vault_query::{MapVaultQuery, ModVaultQuery};
use faf_domain::state::{
    ClanCommand, InstalledMap, InstalledMod, MapListStatus, MapsCommand, MatchmakerMapPool,
    MatchmakerPlayerProfile, ModDownloadSize, ModDownloadTarget, ModListStatus, ModsCommand,
    PlayerCardProfile, PlayerLeaguePlacement, PlayerMapStats, PlayerSummary, RatingHistoryPage,
    RatingHistoryQuery, ReportingCommand, VaultMap, VaultMod,
};
use faf_domain::AppCommand;
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;

/// One held-open call, keyed by whatever the request is about.
struct Gate {
    entered: AtomicBool,
    open: Semaphore,
}

/// Closed until released: the semaphore starts with no permits.
impl Default for Gate {
    fn default() -> Self {
        Self {
            entered: AtomicBool::new(false),
            open: Semaphore::new(0),
        }
    }
}

/// Port calls that wait until the test lets them answer.
#[derive(Default, Clone)]
struct Gates(Arc<Mutex<HashMap<String, Arc<Gate>>>>);

impl Gates {
    fn gate(&self, key: &str) -> Arc<Gate> {
        self.0
            .lock()
            .expect("gates poisoned")
            .entry(key.to_string())
            .or_default()
            .clone()
    }

    /// Called by a port: record the call, then wait to be let through.
    async fn pass(&self, key: &str) {
        let gate = self.gate(key);
        gate.entered.store(true, Ordering::SeqCst);
        gate.open.acquire().await.expect("gate closed").forget();
    }

    fn release(&self, key: &str) {
        self.gate(key).open.add_permits(1);
    }

    /// Wait until a port call for `key` is in flight, so the overtaking request
    /// is known to start after it.
    async fn wait_entered(&self, key: &str) {
        let gate = self.gate(key);
        for _ in 0..400 {
            if gate.entered.load(Ordering::SeqCst) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("no port call for {key} arrived");
    }
}

fn start(ports: Ports) -> Arc<App> {
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    Arc::new(app)
}

/// Dispatch without blocking the test, and hand back the command's completion.
fn spawn_command(app: &Arc<App>, command: AppCommand) -> JoinHandle<()> {
    let app = app.clone();
    tokio::spawn(async move {
        app.dispatch_and_wait(command)
            .await
            .expect("command completes");
    })
}

// ── Map and mod vault searches ──────────────────────────────────────────────

/// Totals that say which query an answer was for.
fn records_for(search: &str) -> Option<i32> {
    Some(if search == "new" { 2 } else { 1 })
}

struct GatedMaps(Gates);

#[async_trait]
impl MapsPort for GatedMaps {
    async fn list_vault(&self) -> Result<Vec<VaultMap>, String> {
        Ok(Vec::new())
    }
    async fn search_vault(&self, query: MapVaultQuery) -> Result<MapSearchPage, String> {
        self.0.pass(&query.search).await;
        if query.search.ends_with("-err") {
            return Err(format!("{} failed", query.search));
        }
        Ok(MapSearchPage {
            maps: Vec::new(),
            total_pages: Some(1),
            total_records: records_for(&query.search),
        })
    }
    async fn list_installed(&self) -> Result<Vec<InstalledMap>, String> {
        Ok(Vec::new())
    }
    async fn list_matchmaker_pools(&self, _: String) -> Result<Vec<MatchmakerMapPool>, String> {
        Ok(Vec::new())
    }
    async fn install_map(&self, _: String, _: String) -> Result<Vec<InstalledMap>, String> {
        unreachable!("searches only")
    }
    async fn uninstall_map(&self, _: String) -> Result<Vec<InstalledMap>, String> {
        unreachable!("searches only")
    }
    async fn set_map_version_hidden(&self, _: i32, _: bool) -> Result<(), String> {
        unreachable!("searches only")
    }
}

struct GatedMods(Gates);

#[async_trait]
impl ModsPort for GatedMods {
    async fn list_vault(&self) -> Result<Vec<VaultMod>, String> {
        Ok(Vec::new())
    }
    async fn search_vault(&self, query: ModVaultQuery) -> Result<ModSearchPage, String> {
        self.0.pass(&query.search).await;
        if query.search.ends_with("-err") {
            return Err(format!("{} failed", query.search));
        }
        Ok(ModSearchPage {
            mods: Vec::new(),
            total_pages: Some(1),
            total_records: records_for(&query.search),
        })
    }
    async fn list_installed(&self) -> Result<Vec<InstalledMod>, String> {
        Ok(Vec::new())
    }
    async fn download_sizes(&self, _: Vec<ModDownloadTarget>) -> Vec<ModDownloadSize> {
        Vec::new()
    }
    async fn install_mod(&self, _: String, _: String) -> Result<Vec<InstalledMod>, String> {
        unreachable!("searches only")
    }
    async fn update_mod(
        &self,
        _: String,
        _: String,
        _: String,
    ) -> Result<Vec<InstalledMod>, String> {
        unreachable!("searches only")
    }
    async fn uninstall_mod(&self, _: String) -> Result<Vec<InstalledMod>, String> {
        unreachable!("searches only")
    }
    async fn toggle_mod(&self, _: String, _: bool) -> Result<Vec<InstalledMod>, String> {
        unreachable!("searches only")
    }
    async fn set_active_mods(&self, _: Vec<String>) -> Result<Vec<InstalledMod>, String> {
        unreachable!("searches only")
    }
    async fn ensure_game_mods(
        &self,
        _: &BTreeMap<String, String>,
        _: bool,
    ) -> Result<(), ModPrepFailure> {
        Ok(())
    }
}

fn map_search(search: &str) -> AppCommand {
    MapsCommand::SearchVault {
        query: MapVaultQuery {
            search: search.into(),
            ..MapVaultQuery::default()
        },
    }
    .into()
}

fn mod_search(search: &str) -> AppCommand {
    ModsCommand::SearchVault {
        query: ModVaultQuery {
            search: search.into(),
            ..ModVaultQuery::default()
        },
    }
    .into()
}

/// Two older searches, one that will succeed and one that will fail, are both
/// overtaken by a newer one. Neither may replace its page, totals or status.
#[tokio::test]
async fn an_older_map_search_never_replaces_a_newer_one() {
    let gates = Gates::default();
    let app = start(Ports {
        maps: Arc::new(GatedMaps(gates.clone())),
        ..fake_ports()
    });

    let stale_ok = spawn_command(&app, map_search("old"));
    gates.wait_entered("old").await;
    let stale_err = spawn_command(&app, map_search("old-err"));
    gates.wait_entered("old-err").await;
    let newest = spawn_command(&app, map_search("new"));
    gates.wait_entered("new").await;

    gates.release("new");
    newest.await.unwrap();
    gates.release("old");
    gates.release("old-err");
    stale_ok.await.unwrap();
    stale_err.await.unwrap();

    let maps = app.snapshot().maps;
    assert_eq!(maps.browse_query.search, "new");
    assert_eq!(maps.browse_total_records, Some(2));
    assert_eq!(maps.browse_status, MapListStatus::Ready);
}

#[tokio::test]
async fn an_older_mod_search_never_replaces_a_newer_one() {
    let gates = Gates::default();
    let app = start(Ports {
        mods: Arc::new(GatedMods(gates.clone())),
        ..fake_ports()
    });

    let stale_ok = spawn_command(&app, mod_search("old"));
    gates.wait_entered("old").await;
    let stale_err = spawn_command(&app, mod_search("old-err"));
    gates.wait_entered("old-err").await;
    let newest = spawn_command(&app, mod_search("new"));
    gates.wait_entered("new").await;

    gates.release("new");
    newest.await.unwrap();
    gates.release("old");
    gates.release("old-err");
    stale_ok.await.unwrap();
    stale_err.await.unwrap();

    let mods = app.snapshot().mods;
    assert_eq!(mods.browse_query.search, "new");
    assert_eq!(mods.browse_total_records, Some(2));
    assert_eq!(mods.browse_status, ModListStatus::Ready);

    // The catalogue crawl is a separate path and still answers.
    app.dispatch_and_wait(ModsCommand::ReloadVault.into())
        .await
        .unwrap();
    assert_eq!(app.snapshot().mods.vault_status, ModListStatus::Ready);
}

// ── Player lookups: reporting by name, clan candidates ─────────────────────

/// The offline player directory, with name lookups and searches held open.
struct GatedPlayers(Gates);

#[async_trait]
impl PlayerCardPort for GatedPlayers {
    async fn search_players(
        &self,
        query: &str,
        limit: i32,
    ) -> Result<Vec<PlayerSummary>, RequestError> {
        self.0.pass(query).await;
        FakePlayerCard.search_players(query, limit).await
    }
    async fn players_by_login(
        &self,
        logins: &[String],
    ) -> Result<Vec<PlayerSummary>, RequestError> {
        self.0.pass(&logins.join(",")).await;
        FakePlayerCard.players_by_login(logins).await
    }
    async fn players_by_id(&self, ids: &[i32]) -> Result<Vec<PlayerSummary>, RequestError> {
        FakePlayerCard.players_by_id(ids).await
    }
    async fn load_profile(
        &self,
        player_id: Option<i32>,
        login: &str,
    ) -> Result<PlayerCardProfile, String> {
        FakePlayerCard.load_profile(player_id, login).await
    }
    async fn load_matchmaker_profile(
        &self,
        player_id: i32,
        login: &str,
    ) -> Result<MatchmakerPlayerProfile, String> {
        FakePlayerCard
            .load_matchmaker_profile(player_id, login)
            .await
    }
    async fn load_league_placements(
        &self,
        player_ids: &[i32],
    ) -> Result<BTreeMap<i32, Vec<PlayerLeaguePlacement>>, String> {
        FakePlayerCard.load_league_placements(player_ids).await
    }
    async fn load_rating_history(
        &self,
        query: &RatingHistoryQuery,
    ) -> Result<RatingHistoryPage, String> {
        FakePlayerCard.load_rating_history(query).await
    }
    async fn load_map_stats(&self, player_id: i32) -> Result<PlayerMapStats, String> {
        FakePlayerCard.load_map_stats(player_id).await
    }
}

fn with_gated_players() -> (Arc<App>, Gates) {
    let gates = Gates::default();
    let app = start(Ports {
        player_card: Arc::new(GatedPlayers(gates.clone())),
        ..fake_ports()
    });
    (app, gates)
}

fn report_by_name(login: &str) -> AppCommand {
    ReportingCommand::OpenByLogin {
        login: login.into(),
    }
    .into()
}

/// Closing the dialog while the name is still being looked up: the answer
/// must not open it again behind the user's back.
#[tokio::test]
async fn a_report_lookup_answering_after_close_does_not_reopen_the_dialog() {
    let (app, gates) = with_gated_players();

    let lookup = spawn_command(&app, report_by_name("Nuggets"));
    gates.wait_entered("Nuggets").await;
    app.dispatch_and_wait(ReportingCommand::Close.into())
        .await
        .unwrap();
    gates.release("Nuggets");
    lookup.await.unwrap();

    let reporting = app.snapshot().reporting;
    assert!(!reporting.open, "a closed report must stay closed");
    assert_eq!(reporting.player_id, None);
}

/// A report opened about somebody else while the first name was in flight
/// keeps its target, and the superseded lookup's failure is not announced.
#[tokio::test]
async fn a_report_lookup_answering_late_does_not_replace_a_newer_target() {
    let (app, gates) = with_gated_players();

    let found = spawn_command(&app, report_by_name("Nuggets"));
    gates.wait_entered("Nuggets").await;
    // The one name the offline directory refuses to resolve.
    let missing = spawn_command(&app, report_by_name("NotAPlayer"));
    gates.wait_entered("NotAPlayer").await;
    app.dispatch_and_wait(
        ReportingCommand::Open {
            player_id: 7,
            login: "Aurora".into(),
        }
        .into(),
    )
    .await
    .unwrap();

    gates.release("Nuggets");
    gates.release("NotAPlayer");
    found.await.unwrap();
    missing.await.unwrap();

    let state = app.snapshot();
    assert!(state.reporting.open);
    assert_eq!(state.reporting.player_id, Some(7));
    assert_eq!(state.reporting.login, "Aurora");
    assert!(
        state.notifications.items.is_empty(),
        "a lookup nobody is waiting for must not raise an error"
    );
}

/// Emptying the invite field while a search is in flight: the cleared list is
/// the newer answer, and the old matches must not come back under it.
#[tokio::test]
async fn clearing_the_invite_field_outranks_a_search_in_flight() {
    let (app, gates) = with_gated_players();

    let search = spawn_command(
        &app,
        ClanCommand::SearchCandidates { query: "Nu".into() }.into(),
    );
    gates.wait_entered("Nu").await;
    app.dispatch_and_wait(
        ClanCommand::SearchCandidates {
            query: String::new(),
        }
        .into(),
    )
    .await
    .unwrap();
    gates.release("Nu");
    search.await.unwrap();

    assert!(
        app.snapshot().clan.candidates.is_empty(),
        "matches for a cleared field reappeared"
    );
}
