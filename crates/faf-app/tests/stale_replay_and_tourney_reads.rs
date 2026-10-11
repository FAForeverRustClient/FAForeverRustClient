//! Replay listings and tournament reads: only the newest answer lands.
//!
//! Commands run concurrently, so request order is not response order. The
//! replay vault search, the local replay listing, a tournament's detail and its
//! entrants' accounts, the organiser's account search and a tournament chat
//! room each run under their own request generation for that reason. Each test
//! here holds one port call open behind a gate, lets a newer request (or a
//! delete, or a cleared field) overtake it, and then lets the old one answer.
//! The state must still describe the newer request.
//!
//! A refusal is an answer too. A stale one must not leave a failure status
//! behind, or raise a notification, any more than a stale success may replace
//! a newer listing.
//!
//! Several of these answers are also screened by the reducer (a detail for an
//! event that is no longer open, posts for a room that is no longer open, matches
//! for a word that is no longer typed). The tests that matter most are the ones
//! the reducer cannot screen: an older answer about the *same* event, room or
//! word, and refusals, which name nothing the reducer could compare.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakePlayerCard, FakeReplay, FakeTourney};
use faf_app::ports::{
    PlayerCardPort, ReplayLibraryPort, ReplayVaultPort, RequestError, TourneyChatPort,
    TourneyReadPort, VaultSearchResult,
};
use faf_app::{App, Ports};
use faf_domain::state::{
    ChatPost, ChatRoom, CopySource, EntrantRatings, LocalReplay, LocalReplayStatus,
    MatchmakerPlayerProfile, PlayerCardProfile, PlayerLeaguePlacement, PlayerMapStats,
    PlayerSummary, RatingCheck, RatingHistoryPage, RatingHistoryQuery, RenameCheck, ReplayCommand,
    ReplayQuery, SeriesDetail, Tourney, TourneyLoadStatus, TourneyPreset, TourneyRead,
    TourneySeries, VaultReplay, VaultStatus,
};
use faf_domain::AppCommand;
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;

// ── Gates ──────────────────────────────────────────────────────────────────

/// How a gated port call is to be answered.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Answer {
    /// Nobody held this call: answer at once, as the current answer.
    Fresh,
    /// Held, then let through: answer, marked as the older answer it is.
    Stale,
    /// Held, then let through: answer with a refusal.
    Refused,
}

/// One held call, keyed by whatever the request is about.
struct Gate {
    /// Whether the next call for this key is still to be caught. One-shot, so
    /// a newer request for the same key answers at once.
    armed: AtomicBool,
    refuse: bool,
    entered: AtomicBool,
    open: Semaphore,
}

/// Port calls that wait until the test lets them answer.
///
/// Opt-in per key: a call nobody asked to hold answers at once, so the reads a
/// command makes on the way (a selection's detail, a room list) do not need a
/// gate of their own.
#[derive(Default, Clone)]
struct Gates(Arc<Mutex<HashMap<String, Arc<Gate>>>>);

impl Gates {
    /// Hold the next call for `key` until [`Self::release`], and answer it
    /// with a refusal when `refuse` is set.
    fn hold(&self, key: &str, refuse: bool) {
        self.0.lock().expect("gates poisoned").insert(
            key.to_string(),
            Arc::new(Gate {
                armed: AtomicBool::new(true),
                refuse,
                entered: AtomicBool::new(false),
                // Closed until released: no permits to start with.
                open: Semaphore::new(0),
            }),
        );
    }

    fn gate(&self, key: &str) -> Arc<Gate> {
        self.0
            .lock()
            .expect("gates poisoned")
            .get(key)
            .cloned()
            .unwrap_or_else(|| panic!("nothing holds {key}"))
    }

    /// Called by a port: wait if the test holds this call, then say how to
    /// answer it.
    async fn pass(&self, key: &str) -> Answer {
        let held = self.0.lock().expect("gates poisoned").get(key).cloned();
        let Some(gate) = held.filter(|gate| gate.armed.swap(false, Ordering::SeqCst)) else {
            return Answer::Fresh;
        };
        gate.entered.store(true, Ordering::SeqCst);
        gate.open.acquire().await.expect("gate closed").forget();
        if gate.refuse {
            Answer::Refused
        } else {
            Answer::Stale
        }
    }

    fn release(&self, key: &str) {
        self.gate(key).open.add_permits(1);
    }

    /// Wait until the held call for `key` is in flight, so the overtaking
    /// request is known to start after it.
    async fn wait_entered(&self, key: &str) {
        let gate = self.gate(key);
        for _ in 0..1_000 {
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

/// Await a released command. The timeout is a safety net, not an ordering.
async fn finish(command: JoinHandle<()>) {
    tokio::time::timeout(Duration::from_secs(10), command)
        .await
        .expect("the released command never finished")
        .expect("the released command panicked");
}

fn assert_nothing_announced(app: &App) {
    assert!(
        app.snapshot().notifications.items.is_empty(),
        "an answer nobody is waiting for raised a notification"
    );
}

// ── Replay vault search ────────────────────────────────────────────────────

fn vault_key(map: &str) -> String {
    format!("vault:{map}")
}

/// One game, named after the search it was found by and whether that search
/// was the newest.
fn vault_replay(map: &str, answer: Answer) -> VaultReplay {
    VaultReplay {
        uid: if answer == Answer::Fresh { 2 } else { 1 },
        title: map.into(),
        map: map.into(),
        map_thumbnail_url: String::new(),
        mod_name: "faf".into(),
        start_time: "2026-01-01T00:00:00Z".into(),
        // A finished game: one still running is the live tab's, not the
        // vault's, and the service drops it.
        end_time: "2026-01-01T00:20:00Z".into(),
        replay_available: true,
        duration_seconds: Some(1_200),
        game_duration_seconds: None,
        teams: Vec::new(),
        average_rating: None,
        quality: None,
        reviews_average: None,
        reviews_count: None,
        game_version: None,
        validity: String::new(),
        victory_condition: String::new(),
    }
}

/// The vault, with searches held by the map they ask about.
struct GatedVault(Gates);

#[async_trait]
impl ReplayVaultPort for GatedVault {
    async fn search_vault(&self, query: ReplayQuery) -> Result<VaultSearchResult, String> {
        let answer = self.0.pass(&vault_key(&query.map)).await;
        if answer == Answer::Refused {
            return Err(format!("searching for {} failed", query.map));
        }
        Ok(VaultSearchResult {
            replays: vec![vault_replay(&query.map, answer)],
            total_pages: Some(1),
            total_records: Some(if answer == Answer::Fresh { 2 } else { 1 }),
        })
    }

    async fn list_featured_mods(&self) -> Result<Vec<String>, String> {
        FakeReplay.list_featured_mods().await
    }

    async fn download_vault(&self, uid: i32) -> Result<LocalReplay, String> {
        FakeReplay.download_vault(uid).await
    }
}

fn vault_search(map: &str) -> ReplayCommand {
    ReplayCommand::SearchVault {
        query: Box::new(ReplayQuery {
            map: map.into(),
            ..ReplayQuery::default()
        }),
    }
}

/// Two older searches, one that will find a game and one that will be refused,
/// are both overtaken by a newer one. Neither may replace its rows, its totals
/// or its status.
#[tokio::test]
async fn a_late_replay_search_never_replaces_the_newer_one() {
    let gates = Gates::default();
    let app = start(Ports {
        replay_vault: Arc::new(GatedVault(gates.clone())),
        ..fake_ports()
    });
    gates.hold(&vault_key("first"), false);
    gates.hold(&vault_key("second"), true);

    let stale_ok = spawn_command(&app, vault_search("first"));
    gates.wait_entered(&vault_key("first")).await;
    let stale_err = spawn_command(&app, vault_search("second"));
    gates.wait_entered(&vault_key("second")).await;
    run(&app, vault_search("third")).await;

    gates.release(&vault_key("first"));
    gates.release(&vault_key("second"));
    finish(stale_ok).await;
    finish(stale_err).await;

    let replays = app.snapshot().replays;
    assert_eq!(replays.vault_status, VaultStatus::Ready);
    assert_eq!(replays.vault_query.map, "third");
    assert_eq!(replays.vault_total_records, Some(2));
    assert_eq!(
        replays
            .vault
            .iter()
            .map(|replay| (replay.uid, replay.map.as_str()))
            .collect::<Vec<_>>(),
        vec![(2, "third")],
        "an older search's rows replaced the newer one's"
    );
    assert_nothing_announced(&app);
}

// ── Local replay listing ───────────────────────────────────────────────────

fn local_key(limit: u32) -> String {
    format!("local:{limit}")
}

fn local_replay(name: &str) -> LocalReplay {
    LocalReplay {
        path: format!("C:/replays/{name}.fafreplay"),
        file_name: format!("{name}.fafreplay"),
        uid: None,
        map: "scmp_009".into(),
        mod_name: "faf".into(),
        title: name.into(),
        recorder: "Host".into(),
        start_time: None,
        duration_seconds: None,
        modified_time: 1,
        file_size_bytes: 100,
        num_players: 2,
        teams: Vec::new(),
        average_rating: None,
        sim_mods: Vec::new(),
        status: LocalReplayStatus::Complete,
        watchable: true,
        game_version: None,
    }
}

/// The replay folder, as a list the test can change, with scans held by the
/// limit they were asked with.
///
/// A scan reads the folder when it starts and answers with what it read, the
/// way a directory walk does: a file deleted or added while it was out is not
/// in its answer.
struct GatedLibrary {
    gates: Gates,
    folder: Mutex<Vec<LocalReplay>>,
}

impl GatedLibrary {
    fn add(&self, replay: LocalReplay) {
        self.folder.lock().expect("folder poisoned").push(replay);
    }
}

#[async_trait]
impl ReplayLibraryPort for GatedLibrary {
    async fn list_local(&self, limit: usize) -> Result<Vec<LocalReplay>, String> {
        let read = self.folder.lock().expect("folder poisoned").clone();
        let limit = u32::try_from(limit).expect("a small limit");
        if self.gates.pass(&local_key(limit)).await == Answer::Refused {
            return Err("the replay folder could not be read".into());
        }
        Ok(read)
    }

    async fn delete_local(&self, path: PathBuf) -> Result<(), String> {
        let path = path.to_string_lossy().into_owned();
        self.folder
            .lock()
            .expect("folder poisoned")
            .retain(|replay| replay.path != path);
        Ok(())
    }
}

fn with_library(replays: &[&str]) -> (Arc<App>, Arc<GatedLibrary>) {
    let library = Arc::new(GatedLibrary {
        gates: Gates::default(),
        folder: Mutex::new(replays.iter().map(|name| local_replay(name)).collect()),
    });
    let app = start(Ports {
        replay_library: library.clone(),
        ..fake_ports()
    });
    (app, library)
}

fn local_titles(app: &App) -> Vec<String> {
    app.snapshot()
        .replays
        .local
        .into_iter()
        .map(|replay| replay.title)
        .collect()
}

/// A scan that started before a new replay was recorded answers after the scan
/// that found it.
async fn listing_overtaken(refuse: bool) {
    let (app, library) = with_library(&["one", "two"]);
    library.gates.hold(&local_key(10), refuse);

    let older = spawn_command(&app, ReplayCommand::LoadLocal { limit: 10 });
    library.gates.wait_entered(&local_key(10)).await;
    library.add(local_replay("three"));
    run(&app, ReplayCommand::LoadLocal { limit: 20 }).await;
    library.gates.release(&local_key(10));
    finish(older).await;

    assert_eq!(app.snapshot().replays.local_status, VaultStatus::Ready);
    assert_eq!(
        local_titles(&app),
        ["one", "two", "three"],
        "an older scan replaced the newer listing"
    );
    assert_nothing_announced(&app);
}

/// The older scan answers with the folder it read: two replays, not three.
#[tokio::test]
async fn a_late_local_listing_never_replaces_the_newer_one() {
    listing_overtaken(false).await;
}

/// The older scan is refused: the listing stays ready, not failed.
#[tokio::test]
async fn a_late_local_listing_refusal_never_replaces_the_newer_listing() {
    listing_overtaken(true).await;
}

/// A scan that read the folder before a replay was deleted answers after the
/// delete.
async fn listing_after_delete(refuse: bool) {
    let (app, library) = with_library(&["kept", "deleted"]);
    run(&app, ReplayCommand::LoadLocal { limit: 10 }).await;
    assert_eq!(local_titles(&app), ["kept", "deleted"]);
    library.gates.hold(&local_key(20), refuse);

    let scan = spawn_command(&app, ReplayCommand::LoadLocal { limit: 20 });
    library.gates.wait_entered(&local_key(20)).await;
    run(
        &app,
        ReplayCommand::DeleteLocal {
            path: local_replay("deleted").path,
        },
    )
    .await;
    assert_eq!(local_titles(&app), ["kept"]);
    library.gates.release(&local_key(20));
    finish(scan).await;

    assert_eq!(app.snapshot().replays.local_status, VaultStatus::Ready);
    assert_eq!(
        local_titles(&app),
        ["kept"],
        "a scan from before the delete brought the deleted replay back"
    );
    assert_nothing_announced(&app);
}

/// The scan answers with the folder as it was before the delete.
#[tokio::test]
async fn a_scan_from_before_a_delete_never_restores_the_deleted_replay() {
    listing_after_delete(false).await;
}

/// The scan is refused after the delete: the listing stays ready, not failed.
#[tokio::test]
async fn a_scan_refused_after_a_delete_never_fails_the_listing() {
    listing_after_delete(true).await;
}

// ── Tournament detail ──────────────────────────────────────────────────────

/// The event whose detail the tests hold: running, with entrants that carry
/// FAF accounts and a chat with more than one room.
const RUNNING: &str = "e9z9z";
/// The event moved to while the first one's answer is out.
const SIGNUP: &str = "e1a2b";

fn detail_key(tournament_id: &str) -> String {
    format!("detail:{tournament_id}")
}

/// What a held detail answer calls its event, so a stale bracket on screen is
/// told apart from a current one of the same event.
const STALE_MARK: &str = " (stale)";

/// The offline tournament service, with detail reads held by event.
struct GatedRead {
    inner: FakeTourney,
    gates: Gates,
}

#[async_trait]
impl TourneyReadPort for GatedRead {
    async fn detail(&self, tournament_id: &str) -> Result<Tourney, RequestError> {
        let answer = self.gates.pass(&detail_key(tournament_id)).await;
        if answer == Answer::Refused {
            return Err(RequestError::rejected("That tournament is private."));
        }
        let mut event = self.inner.detail(tournament_id).await?;
        if answer == Answer::Stale {
            event.name.push_str(STALE_MARK);
        }
        Ok(event)
    }

    // Everything else is the ordinary offline service.
    fn asset_base(&self) -> String {
        self.inner.asset_base()
    }

    async fn list(&self) -> Result<Vec<Tourney>, RequestError> {
        self.inner.list().await
    }

    async fn check_rating(&self, tournament_id: &str) -> Result<RatingCheck, RequestError> {
        self.inner.check_rating(tournament_id).await
    }

    async fn player_ratings(
        &self,
        tournament_id: &str,
        player_id: &str,
        refresh: bool,
    ) -> Result<EntrantRatings, RequestError> {
        self.inner
            .player_ratings(tournament_id, player_id, refresh)
            .await
    }

    async fn copy_sources(&self) -> Result<Vec<CopySource>, RequestError> {
        self.inner.copy_sources().await
    }

    async fn presets(&self) -> Result<Vec<TourneyPreset>, RequestError> {
        self.inner.presets().await
    }

    async fn check_renames(&self, tournament_id: &str) -> Result<RenameCheck, RequestError> {
        self.inner.check_renames(tournament_id).await
    }

    async fn series(&self) -> Result<Vec<TourneySeries>, RequestError> {
        self.inner.series().await
    }

    async fn series_detail(&self, series_id: &str) -> Result<SeriesDetail, RequestError> {
        self.inner.series_detail(series_id).await
    }

    async fn mark_news_read(&self, tournament_id: &str) -> Result<(), RequestError> {
        self.inner.mark_news_read(tournament_id).await
    }
}

/// The app over a gated detail read, the list loaded.
async fn with_gated_detail() -> (Arc<App>, Gates) {
    let gates = Gates::default();
    let app = start(Ports {
        tourney_read: Arc::new(GatedRead {
            inner: FakeTourney::new(),
            gates: gates.clone(),
        }),
        ..fake_ports()
    });
    run(&app, TourneyRead::Load).await;
    (app, gates)
}

fn select(tournament_id: &str) -> TourneyRead {
    TourneyRead::Select {
        tournament_id: tournament_id.into(),
    }
}

fn refresh(tournament_id: &str) -> TourneyRead {
    TourneyRead::RefreshDetail {
        tournament_id: tournament_id.into(),
    }
}

/// The open event's detail is the current read of `tournament_id`.
fn assert_current_detail(app: &App, tournament_id: &str) {
    let tourney = app.snapshot().tourney;
    assert_eq!(tourney.selected_id.as_deref(), Some(tournament_id));
    assert_eq!(tourney.detail_status, TourneyLoadStatus::Ready);
    let detail = tourney.detail.expect("the open event's detail");
    assert_eq!(detail.id, tournament_id);
    assert!(
        !detail.name.ends_with(STALE_MARK),
        "an older read of {tournament_id} replaced the newer one"
    );
}

/// Open event A, move to event B while A's detail is out, then let A answer.
async fn detail_after_moving_on(refuse: bool) {
    let (app, gates) = with_gated_detail().await;
    gates.hold(&detail_key(RUNNING), refuse);

    let left = spawn_command(&app, select(RUNNING));
    gates.wait_entered(&detail_key(RUNNING)).await;
    run(&app, select(SIGNUP)).await;
    gates.release(&detail_key(RUNNING));
    finish(left).await;

    assert_current_detail(&app, SIGNUP);
    assert_nothing_announced(&app);
}

/// The event left answers with its bracket.
#[tokio::test]
async fn a_late_detail_for_the_event_left_never_lands_on_the_next_one() {
    detail_after_moving_on(false).await;
}

/// The event left answers with a refusal, which names no event the reducer
/// could compare: only the generation keeps it off the next one.
#[tokio::test]
async fn a_late_detail_refusal_for_the_event_left_never_fails_the_next_one() {
    detail_after_moving_on(true).await;
}

/// Open an event, and while its detail is out read it again: the selection's
/// read is now the older of two answers about the same event.
async fn selection_overtaken_by_a_refresh(refuse: bool) {
    let (app, gates) = with_gated_detail().await;
    gates.hold(&detail_key(RUNNING), refuse);

    let selection = spawn_command(&app, select(RUNNING));
    gates.wait_entered(&detail_key(RUNNING)).await;
    run(&app, refresh(RUNNING)).await;
    gates.release(&detail_key(RUNNING));
    finish(selection).await;

    assert_current_detail(&app, RUNNING);
    assert_nothing_announced(&app);
}

/// The selection's read answers with an older copy of the same bracket.
#[tokio::test]
async fn an_older_detail_of_the_open_event_never_replaces_a_newer_read() {
    selection_overtaken_by_a_refresh(false).await;
}

/// The selection's read answers with a refusal after the refresh landed.
#[tokio::test]
async fn an_older_detail_refusal_never_fails_a_newer_read_of_the_same_event() {
    selection_overtaken_by_a_refresh(true).await;
}

/// The silent refresh is a read under the same generation: one still out when
/// a newer read of the event lands is dropped, not drawn over it.
#[tokio::test]
async fn a_late_silent_refresh_never_replaces_a_newer_read_of_the_event() {
    let (app, gates) = with_gated_detail().await;
    run(&app, select(RUNNING)).await;
    gates.hold(&detail_key(RUNNING), false);

    let poll = spawn_command(&app, refresh(RUNNING));
    gates.wait_entered(&detail_key(RUNNING)).await;
    // Clicking the open event again re-reads it.
    run(&app, select(RUNNING)).await;
    gates.release(&detail_key(RUNNING));
    finish(poll).await;

    assert_current_detail(&app, RUNNING);
}

// ── Players behind the detail and the account search ──────────────────────

const PROFILES_KEY: &str = "profiles";

fn search_key(query: &str) -> String {
    format!("search:{query}")
}

fn account(id: i32, login: String) -> PlayerSummary {
    PlayerSummary {
        id,
        login,
        avatar_url: String::new(),
        country: String::new(),
        global_rating: None,
        ladder_rating: None,
    }
}

/// The FAF account directory, with the account search held by query and the
/// entrants' accounts held by [`PROFILES_KEY`]. Its answers name what they
/// were asked for, and a held one says it is stale.
struct GatedPlayers(Gates);

#[async_trait]
impl PlayerCardPort for GatedPlayers {
    async fn search_players(
        &self,
        query: &str,
        _limit: i32,
    ) -> Result<Vec<PlayerSummary>, RequestError> {
        match self.0.pass(&search_key(query)).await {
            Answer::Refused => Err(RequestError::rejected("Your FAF session expired.")),
            Answer::Stale => Ok(vec![account(1, format!("{query}-stale"))]),
            Answer::Fresh => Ok(vec![account(2, format!("{query}-match"))]),
        }
    }

    async fn players_by_id(&self, ids: &[i32]) -> Result<Vec<PlayerSummary>, RequestError> {
        let answer = self.0.pass(PROFILES_KEY).await;
        if answer == Answer::Refused {
            return Err(RequestError::rejected("FAF could not be reached just now."));
        }
        Ok(ids
            .iter()
            .map(|id| {
                let login = if answer == Answer::Stale {
                    "stale".to_string()
                } else {
                    format!("account{id}")
                };
                account(*id, login)
            })
            .collect())
    }

    // Everything else is the ordinary offline directory.
    async fn players_by_login(
        &self,
        logins: &[String],
    ) -> Result<Vec<PlayerSummary>, RequestError> {
        FakePlayerCard.players_by_login(logins).await
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

async fn with_gated_players() -> (Arc<App>, Gates) {
    let gates = Gates::default();
    let app = start(Ports {
        player_card: Arc::new(GatedPlayers(gates.clone())),
        ..fake_ports()
    });
    run(&app, TourneyRead::Load).await;
    (app, gates)
}

/// The entrants' accounts are read after the detail, under the detail's
/// generation. Event A's accounts still out when event B is opened must not
/// put A's faces on B's entrants: the reducer cannot tell, because a list of
/// accounts does not say which event it was for.
#[tokio::test]
async fn a_late_entrant_lookup_never_lands_on_the_next_event() {
    let (app, gates) = with_gated_players().await;
    gates.hold(PROFILES_KEY, false);

    let left = spawn_command(&app, select(RUNNING));
    gates.wait_entered(PROFILES_KEY).await;
    run(&app, select(SIGNUP)).await;
    gates.release(PROFILES_KEY);
    finish(left).await;

    let tourney = app.snapshot().tourney;
    assert_eq!(tourney.selected_id.as_deref(), Some(SIGNUP));
    let mut expected: Vec<i32> = tourney
        .detail
        .expect("the open event's detail")
        .players
        .iter()
        .filter_map(|player| player.faf_id)
        .collect();
    expected.sort_unstable();
    expected.dedup();
    let mut shown: Vec<i32> = tourney
        .entrant_profiles
        .iter()
        .map(|profile| profile.id)
        .collect();
    shown.sort_unstable();
    assert!(
        tourney
            .entrant_profiles
            .iter()
            .all(|profile| profile.login != "stale"),
        "the accounts of {RUNNING}'s entrants landed on {SIGNUP}"
    );
    assert_eq!(shown, expected);
}

fn search(query: &str) -> TourneyRead {
    TourneyRead::SearchAccounts {
        query: query.into(),
    }
}

/// The organiser types one name, then another before the first answers.
async fn search_overtaken(refuse: bool) {
    let (app, gates) = with_gated_players().await;
    gates.hold(&search_key("Nug"), refuse);

    let older = spawn_command(&app, search("Nug"));
    gates.wait_entered(&search_key("Nug")).await;
    run(&app, search("Aur")).await;
    gates.release(&search_key("Nug"));
    finish(older).await;

    let found = app.snapshot().tourney.account_search;
    assert_eq!(found.query, "Aur");
    assert_eq!(found.status, TourneyLoadStatus::Ready);
    assert_eq!(
        found
            .matches
            .iter()
            .map(|account| account.login.as_str())
            .collect::<Vec<_>>(),
        ["Aur-match"]
    );
    assert_nothing_announced(&app);
}

/// The older word answers with its matches.
#[tokio::test]
async fn a_late_account_search_never_replaces_the_newer_one() {
    search_overtaken(false).await;
}

/// The older word answers with a refusal.
#[tokio::test]
async fn a_late_account_search_refusal_never_fails_the_newer_one() {
    search_overtaken(true).await;
}

/// The same word asked twice, the first answer arriving last. The reducer
/// cannot tell the two apart, since both answers name the same query: only the
/// generation can.
async fn same_word_overtaken(refuse: bool) {
    let (app, gates) = with_gated_players().await;
    gates.hold(&search_key("Nug"), refuse);

    let older = spawn_command(&app, search("Nug"));
    gates.wait_entered(&search_key("Nug")).await;
    run(&app, search("Nug")).await;
    gates.release(&search_key("Nug"));
    finish(older).await;

    let found = app.snapshot().tourney.account_search;
    assert_eq!(found.status, TourneyLoadStatus::Ready);
    assert_eq!(
        found
            .matches
            .iter()
            .map(|account| account.login.as_str())
            .collect::<Vec<_>>(),
        ["Nug-match"],
        "the older answer for the same word replaced the newer one"
    );
    assert_nothing_announced(&app);
}

/// The older ask answers with older matches.
#[tokio::test]
async fn an_older_answer_for_the_same_word_never_replaces_the_newer_matches() {
    same_word_overtaken(false).await;
}

/// The older ask answers with a refusal, which the reducer would credit to
/// the newer search of the same word.
#[tokio::test]
async fn an_older_refusal_for_the_same_word_never_fails_the_newer_search() {
    same_word_overtaken(true).await;
}

/// Emptying the field, or cutting it below the length worth asking about,
/// is a newer answer: the empty list. A search still out must not fill it in.
async fn search_then_cleared(clear: TourneyRead, refuse: bool) {
    let (app, gates) = with_gated_players().await;
    gates.hold(&search_key("Nug"), refuse);

    let older = spawn_command(&app, search("Nug"));
    gates.wait_entered(&search_key("Nug")).await;
    run(&app, clear).await;
    gates.release(&search_key("Nug"));
    finish(older).await;

    assert_eq!(
        app.snapshot().tourney.account_search,
        Default::default(),
        "a search for a cleared field filled it in again"
    );
    assert_nothing_announced(&app);
}

/// The field is cleared (after an account was picked, say); the search still
/// out answers with matches, then with a refusal.
#[tokio::test]
async fn clearing_the_account_search_outranks_a_search_in_flight() {
    search_then_cleared(TourneyRead::ClearAccountSearch, false).await;
    search_then_cleared(TourneyRead::ClearAccountSearch, true).await;
}

/// The field is cut to one letter; the search still out answers with
/// matches, then with a refusal.
#[tokio::test]
async fn a_query_too_short_to_ask_about_outranks_a_search_in_flight() {
    search_then_cleared(search("N"), false).await;
    search_then_cleared(search("N"), true).await;
}

// ── Tournament chat ────────────────────────────────────────────────────────

fn chat_key(room_id: &str) -> String {
    format!("chat:{room_id}")
}

/// The one post a room read answers with, named after its room and whether the
/// read was the newest.
fn post_id(room_id: &str, answer: Answer) -> String {
    let age = if answer == Answer::Fresh {
        "fresh"
    } else {
        "stale"
    };
    format!("{room_id}/{age}")
}

/// The offline tournament chat, with room reads held by room.
struct GatedChat {
    inner: FakeTourney,
    gates: Gates,
}

#[async_trait]
impl TourneyChatPort for GatedChat {
    async fn chat_read(
        &self,
        _tournament_id: &str,
        room_id: &str,
    ) -> Result<Vec<ChatPost>, RequestError> {
        let answer = self.gates.pass(&chat_key(room_id)).await;
        if answer == Answer::Refused {
            return Err(RequestError::rejected("You may not read this room."));
        }
        Ok(vec![ChatPost {
            id: post_id(room_id, answer),
            author: "Organizer".into(),
            faf_id: None,
            body: format!("posted in {room_id}"),
            at: None,
            system: false,
            reply_to: None,
            everyone: false,
        }])
    }

    // Everything else is the ordinary offline service.
    async fn chat_rooms(&self, tournament_id: &str) -> Result<Vec<ChatRoom>, RequestError> {
        self.inner.chat_rooms(tournament_id).await
    }

    async fn chat_post(
        &self,
        tournament_id: &str,
        room_id: &str,
        body: &str,
        reply_to: Option<&str>,
    ) -> Result<(), RequestError> {
        self.inner
            .chat_post(tournament_id, room_id, body, reply_to)
            .await
    }

    async fn mute_chat(
        &self,
        tournament_id: &str,
        faf_id: i32,
        name: &str,
        muted: bool,
    ) -> Result<(), RequestError> {
        self.inner
            .mute_chat(tournament_id, faf_id, name, muted)
            .await
    }

    async fn delete_chat_post(
        &self,
        tournament_id: &str,
        room_id: &str,
        post_id: &str,
    ) -> Result<(), RequestError> {
        self.inner
            .delete_chat_post(tournament_id, room_id, post_id)
            .await
    }
}

/// The running event open with its room list loaded, and two of its rooms.
async fn with_gated_chat() -> (Arc<App>, Gates, String, String) {
    let gates = Gates::default();
    let app = start(Ports {
        tourney_chat: Arc::new(GatedChat {
            inner: FakeTourney::new(),
            gates: gates.clone(),
        }),
        ..fake_ports()
    });
    run(&app, TourneyRead::Load).await;
    run(&app, select(RUNNING)).await;
    run(
        &app,
        TourneyRead::LoadChat {
            tournament_id: RUNNING.into(),
        },
    )
    .await;
    let rooms = app.snapshot().tourney.chat_rooms;
    assert!(
        rooms.len() >= 2,
        "{RUNNING} offers two rooms to move between"
    );
    let (first, second) = (rooms[0].id.clone(), rooms[1].id.clone());
    (app, gates, first, second)
}

fn open_room(room_id: &str) -> TourneyRead {
    TourneyRead::OpenRoom {
        tournament_id: RUNNING.into(),
        room_id: room_id.into(),
    }
}

/// The open room shows the newest read of `room_id`.
fn assert_current_room(app: &App, room_id: &str) {
    let tourney = app.snapshot().tourney;
    assert_eq!(tourney.open_room_id.as_deref(), Some(room_id));
    assert_eq!(tourney.chat_status, TourneyLoadStatus::Ready);
    assert_eq!(
        tourney
            .chat_posts
            .iter()
            .map(|post| post.id.clone())
            .collect::<Vec<_>>(),
        [post_id(room_id, Answer::Fresh)],
        "an older room read replaced the newer one"
    );
}

/// Open one room of an event, then another of the same event before the first
/// answers. `tests/tourney.rs` covers moving to another event; this is moving
/// within one.
async fn room_overtaken_by_another(refuse: bool) {
    let (app, gates, left, opened) = with_gated_chat().await;
    gates.hold(&chat_key(&left), refuse);

    let older = spawn_command(&app, open_room(&left));
    gates.wait_entered(&chat_key(&left)).await;
    run(&app, open_room(&opened)).await;
    gates.release(&chat_key(&left));
    finish(older).await;

    assert_current_room(&app, &opened);
    assert_nothing_announced(&app);
}

/// The room left answers with its posts.
#[tokio::test]
async fn a_late_room_never_lands_over_the_room_opened_after_it() {
    room_overtaken_by_another(false).await;
}

/// The room left answers with a refusal, which names no room the reducer
/// could compare: only the generation keeps it off the open one.
#[tokio::test]
async fn a_late_room_refusal_never_fails_the_room_opened_after_it() {
    room_overtaken_by_another(true).await;
}

/// Open a room, and open it again before the first read answers. Both reads
/// are about the same room, so only the generation can tell the older posts
/// from the newer ones.
async fn room_overtaken_by_itself(refuse: bool) {
    let (app, gates, room, _) = with_gated_chat().await;
    gates.hold(&chat_key(&room), refuse);

    let older = spawn_command(&app, open_room(&room));
    gates.wait_entered(&chat_key(&room)).await;
    run(&app, open_room(&room)).await;
    gates.release(&chat_key(&room));
    finish(older).await;

    assert_current_room(&app, &room);
    assert_nothing_announced(&app);
}

/// The first read answers with older posts of the same room.
#[tokio::test]
async fn an_older_read_of_the_same_room_never_replaces_the_newer_posts() {
    room_overtaken_by_itself(false).await;
}

/// The first read answers with a refusal after the second one landed.
#[tokio::test]
async fn an_older_refusal_of_the_same_room_never_fails_the_newer_read() {
    room_overtaken_by_itself(true).await;
}
