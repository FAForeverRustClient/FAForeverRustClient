//! A read the user has moved on from must not land, whether it answers with
//! data or with a refusal.
//!
//! Commands run concurrently, so request order is not response order. Each
//! read below sits behind a generation that a newer request (or a close, or a
//! change of league) moves on, and only the newest answer may reach state.
//! A refusal is an answer too: a stale failure must not paint an error status
//! over a page that loaded, any more than a stale page may replace a newer one.
//!
//! Each test holds the older port calls open behind a gate, lets the newer
//! request run to completion, and then lets the old calls answer. Every answer
//! carries the name of the call that produced it, so the state says exactly
//! which read it is showing.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakeAuth, FakeGuides, FakeLeaderboard, FakePlayerCard};
use faf_app::ports::{
    CoopPort, DeviceCode, GuidesPort, LeaderboardPort, PlayerCardPort, RequestError, ReviewPage,
    ReviewsPort,
};
use faf_app::{App, Ports};
use faf_domain::state::{
    AuthCommand, BoardRating, CoopCommand, CoopMission, CoopResult, CoopScenario, CoopStatus,
    GuideSubmission, GuidesCommand, GuidesIdentity, GuidesStatus, LeaderboardCommand,
    LeaderboardEntry, LeaderboardStatus, League, LeagueSeason, MatchmakerPlayerProfile, Player,
    PlayerCardCommand, PlayerCardProfile, PlayerCardStatus, PlayerLeaguePlacement, PlayerMapStats,
    PlayerRatings, PlayerSummary, RatingHistoryPage, RatingHistoryPeriod, RatingHistoryPoint,
    RatingHistoryQuery, RatingLeaderboard, RatingPage, RatingQuery, RejectReason, Review,
    ReviewKind, ReviewSubmitStatus, ReviewTarget, ReviewsCommand, ReviewsState, ReviewsStatus,
    SeasonLeaderboard, TrainingResource,
};
use faf_domain::AppCommand;
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;

// ── Held-open calls ─────────────────────────────────────────────────────────

/// One port call the test may hold open.
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

/// What the test has scripted, and what the ports have been asked.
#[derive(Default)]
struct Script {
    gates: HashMap<String, Arc<Gate>>,
    held: HashSet<String>,
    refused: HashSet<String>,
    calls: HashMap<String, u32>,
}

/// Port calls named `"<what> #<n>"`, the nth call about the same thing.
///
/// A call answers at once unless the test holds its name, and answers with a
/// refusal when the test refuses it. Numbering by occurrence keeps two
/// identical requests apart, which is the case only a generation can tell.
#[derive(Default, Clone)]
struct Gates(Arc<Mutex<Script>>);

/// The call a port is answering: its name, and whether to refuse it.
struct Call {
    key: String,
    refused: bool,
}

impl Gates {
    fn script(&self) -> std::sync::MutexGuard<'_, Script> {
        self.0.lock().expect("script poisoned")
    }

    fn gate(&self, key: &str) -> Arc<Gate> {
        self.script()
            .gates
            .entry(key.to_string())
            .or_default()
            .clone()
    }

    /// Hold the call named `key` until [`Self::release`].
    fn hold(&self, key: &str) {
        self.script().held.insert(key.to_string());
    }

    /// Hold the call named `key`, and answer it with a refusal once released.
    fn hold_refused(&self, key: &str) {
        self.hold(key);
        self.script().refused.insert(key.to_string());
    }

    fn release(&self, key: &str) {
        self.gate(key).open.add_permits(1);
    }

    /// How many calls about `what` the ports have seen.
    fn calls(&self, what: &str) -> u32 {
        self.script().calls.get(what).copied().unwrap_or_default()
    }

    /// Called by a port: name the call, wait if it is held, and say how to
    /// answer it.
    async fn pass(&self, what: &str) -> Call {
        let (key, held, refused) = {
            let mut script = self.script();
            let count = script.calls.entry(what.to_string()).or_default();
            *count += 1;
            let key = format!("{what} #{count}");
            let held = script.held.contains(&key);
            let refused = script.refused.contains(&key);
            (key, held, refused)
        };
        let gate = self.gate(&key);
        gate.entered.store(true, Ordering::SeqCst);
        if held {
            gate.open.acquire().await.expect("gate closed").forget();
        }
        Call { key, refused }
    }

    /// Wait until the call named `key` is in flight, so the overtaking request
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

/// Generous: only here so a broken ordering fails rather than hangs.
const SAFETY_NET: Duration = Duration::from_secs(10);

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

/// Start a command and wait until its port call named `key` is in flight.
async fn start_held(
    app: &Arc<App>,
    gates: &Gates,
    command: AppCommand,
    key: &str,
) -> JoinHandle<()> {
    let handle = spawn_command(app, command);
    gates.wait_entered(key).await;
    handle
}

/// Run a command to completion.
async fn run(app: &Arc<App>, command: AppCommand) {
    tokio::time::timeout(SAFETY_NET, app.dispatch_and_wait(command))
        .await
        .expect("command finished in time")
        .expect("command completes");
}

/// Let the held calls answer, and wait for the commands that made them.
async fn release_all(gates: &Gates, keys: &[&str], commands: Vec<JoinHandle<()>>) {
    for key in keys {
        gates.release(key);
    }
    for command in commands {
        tokio::time::timeout(SAFETY_NET, command)
            .await
            .expect("stale command finished in time")
            .expect("stale command task");
    }
}

fn refusal(call: &Call) -> String {
    format!("{} was refused", call.key)
}

// ── Leaderboards ────────────────────────────────────────────────────────────

/// A league without seasons, so selecting it loads no season board.
const EMPTY_LEAGUE: i32 = 4;

fn entry(player_id: i32, player_name: &str) -> LeaderboardEntry {
    LeaderboardEntry {
        player_id,
        rank: 1,
        player_name: player_name.into(),
        avatar_url: None,
        avatar_tooltip: None,
        score: None,
        rating: Some(1500),
        mean: None,
        deviation: None,
        games_played: 10,
        won_games: None,
        update_time: None,
        division: None,
        subdivision: None,
        division_order: None,
        highest_score: None,
        division_image_url: None,
        division_medium_image_url: None,
        returning_player: None,
    }
}

/// League `n` has one season, numbered `n * 10`.
fn season(league_id: i32) -> LeagueSeason {
    LeagueSeason {
        id: league_id * 10,
        league_id,
        leaderboard_id: 1,
        season_number: 1,
        start_date: String::new(),
        end_date: String::new(),
        placement_games: 10,
        placement_games_returning_player: 3,
        active: true,
    }
}

/// The offline catalogue, with every page, season list and board named after
/// the call that produced it.
struct GatedLeaderboard(Gates);

#[async_trait]
impl LeaderboardPort for GatedLeaderboard {
    async fn list_rating_leaderboards(&self) -> Result<Vec<RatingLeaderboard>, String> {
        FakeLeaderboard.list_rating_leaderboards().await
    }
    async fn list_leagues(&self) -> Result<Vec<League>, String> {
        FakeLeaderboard.list_leagues().await
    }
    async fn list_ratings(&self, query: &RatingQuery) -> Result<RatingPage, String> {
        let call = self.0.pass(&format!("ratings {}", query.player)).await;
        if call.refused {
            return Err(refusal(&call));
        }
        Ok(RatingPage {
            entries: vec![entry(1, &call.key)],
            page: query.page,
            page_size: query.page_size,
            total_pages: 1,
            total_results: Some(1),
        })
    }
    async fn list_player_ratings(&self, player_ids: &[i32]) -> Result<Vec<PlayerRatings>, String> {
        let call = self.0.pass("other boards").await;
        if call.refused {
            return Err(refusal(&call));
        }
        Ok(player_ids
            .iter()
            .map(|&player_id| PlayerRatings {
                player_id,
                ratings: vec![BoardRating {
                    leaderboard: call.key.clone(),
                    rating: 1500,
                    games_played: 10,
                }],
            })
            .collect())
    }
    async fn list_seasons(&self, league_id: i32) -> Result<Vec<LeagueSeason>, String> {
        let call = self.0.pass(&format!("seasons {league_id}")).await;
        if call.refused {
            return Err(refusal(&call));
        }
        if league_id == EMPTY_LEAGUE {
            return Ok(Vec::new());
        }
        Ok(vec![season(league_id)])
    }
    async fn list_season_leaderboard(&self, season_id: i32) -> Result<SeasonLeaderboard, String> {
        let call = self.0.pass(&format!("season {season_id}")).await;
        if call.refused {
            return Err(refusal(&call));
        }
        Ok(SeasonLeaderboard {
            entries: vec![entry(1, &call.key)],
            tiers: Vec::new(),
        })
    }
}

fn with_gated_leaderboard() -> (Arc<App>, Gates) {
    let gates = Gates::default();
    let app = start(Ports {
        leaderboard: Arc::new(GatedLeaderboard(gates.clone())),
        ..fake_ports()
    });
    (app, gates)
}

fn ratings_for(player: &str) -> AppCommand {
    LeaderboardCommand::LoadRatings {
        query: RatingQuery {
            player: player.into(),
            ..RatingQuery::default()
        },
    }
    .into()
}

fn select_league(league_id: i32) -> AppCommand {
    LeaderboardCommand::SelectLeague { league_id }.into()
}

fn select_season(season_id: i32) -> AppCommand {
    LeaderboardCommand::SelectSeason { season_id }.into()
}

/// Two older rating searches, one that will load and one that will be
/// refused, are overtaken by a newer one. Neither may replace its page or
/// mark it failed, and the abandoned page must not go on to fetch its other
/// boards.
#[tokio::test]
async fn an_older_ratings_page_never_replaces_a_newer_one() {
    let (app, gates) = with_gated_leaderboard();
    gates.hold("ratings old #1");
    gates.hold_refused("ratings broken #1");

    let stale_ok = start_held(&app, &gates, ratings_for("old"), "ratings old #1").await;
    let stale_err = start_held(&app, &gates, ratings_for("broken"), "ratings broken #1").await;
    run(&app, ratings_for("new")).await;
    release_all(
        &gates,
        &["ratings old #1", "ratings broken #1"],
        vec![stale_ok, stale_err],
    )
    .await;

    let board = app.snapshot().leaderboard;
    assert_eq!(board.rating_query.player, "new");
    assert_eq!(board.rating_page.entries[0].player_name, "ratings new #1");
    assert_eq!(board.ratings_status, LeaderboardStatus::Ready);
    assert_eq!(
        board.cross_ratings[0].ratings[0].leaderboard,
        "other boards #1"
    );
    assert_eq!(
        gates.calls("other boards"),
        1,
        "the abandoned page fetched its other boards"
    );
}

/// The other boards are a second request behind the page. Asking for the same
/// page again while the first one's other boards are still in flight makes
/// that answer stale, and since both pages have the same query only the
/// generation can tell them apart.
#[tokio::test]
async fn the_other_boards_of_a_superseded_page_never_fill_in_the_newer_one() {
    let (app, gates) = with_gated_leaderboard();
    gates.hold("other boards #1");

    let stale = start_held(&app, &gates, ratings_for("same"), "other boards #1").await;
    run(&app, ratings_for("same")).await;
    release_all(&gates, &["other boards #1"], vec![stale]).await;

    let board = app.snapshot().leaderboard;
    assert_eq!(board.rating_page.entries[0].player_name, "ratings same #2");
    assert_eq!(board.cross_ratings.len(), 1);
    assert_eq!(
        board.cross_ratings[0].ratings[0].leaderboard,
        "other boards #2"
    );
}

/// Two older league selections, one that will list its seasons and one that
/// will be refused, are overtaken by a newer one. The newer league keeps its
/// seasons and its first board, and the abandoned league does not go on to
/// load a board of its own.
#[tokio::test]
async fn an_older_league_never_replaces_the_newer_ones_seasons() {
    let (app, gates) = with_gated_leaderboard();
    gates.hold("seasons 1 #1");
    gates.hold_refused("seasons 2 #1");

    let stale_ok = start_held(&app, &gates, select_league(1), "seasons 1 #1").await;
    let stale_err = start_held(&app, &gates, select_league(2), "seasons 2 #1").await;
    run(&app, select_league(3)).await;
    release_all(
        &gates,
        &["seasons 1 #1", "seasons 2 #1"],
        vec![stale_ok, stale_err],
    )
    .await;

    let board = app.snapshot().leaderboard;
    assert_eq!(board.selected_league_id, Some(3));
    let seasons: Vec<i32> = board.seasons.iter().map(|season| season.id).collect();
    assert_eq!(seasons, vec![30]);
    assert_eq!(board.seasons_status, LeaderboardStatus::Ready);
    assert_eq!(board.selected_season_id, Some(30));
    assert_eq!(board.season_entries[0].player_name, "season 30 #1");
    assert_eq!(board.season_status, LeaderboardStatus::Ready);
    assert_eq!(
        gates.calls("season 10"),
        0,
        "the abandoned league loaded its first season"
    );
}

/// Two older season boards, one that will load and one that will be refused,
/// are overtaken by a newer season. The newer board stays on screen.
#[tokio::test]
async fn an_older_season_board_never_replaces_a_newer_one() {
    let (app, gates) = with_gated_leaderboard();
    gates.hold("season 10 #1");
    gates.hold_refused("season 11 #1");

    let stale_ok = start_held(&app, &gates, select_season(10), "season 10 #1").await;
    let stale_err = start_held(&app, &gates, select_season(11), "season 11 #1").await;
    run(&app, select_season(12)).await;
    release_all(
        &gates,
        &["season 10 #1", "season 11 #1"],
        vec![stale_ok, stale_err],
    )
    .await;

    let board = app.snapshot().leaderboard;
    assert_eq!(board.selected_season_id, Some(12));
    assert_eq!(board.season_entries.len(), 1);
    assert_eq!(board.season_entries[0].player_name, "season 12 #1");
    assert_eq!(board.season_status, LeaderboardStatus::Ready);
}

/// A season board belongs to its league. Moving to a league with no seasons
/// starts no board of its own, so only the invalidation stops the boards still
/// in flight for the league left behind, the loaded one and the refused one,
/// from filling the empty league.
#[tokio::test]
async fn a_season_board_in_flight_is_dropped_when_the_league_changes() {
    let (app, gates) = with_gated_leaderboard();
    gates.hold("season 10 #1");
    gates.hold_refused("season 11 #1");

    let stale_ok = start_held(&app, &gates, select_season(10), "season 10 #1").await;
    let stale_err = start_held(&app, &gates, select_season(11), "season 11 #1").await;
    run(&app, select_league(EMPTY_LEAGUE)).await;
    release_all(
        &gates,
        &["season 10 #1", "season 11 #1"],
        vec![stale_ok, stale_err],
    )
    .await;

    let board = app.snapshot().leaderboard;
    assert_eq!(board.selected_league_id, Some(EMPTY_LEAGUE));
    assert!(board.seasons.is_empty());
    assert_eq!(board.selected_season_id, None);
    assert!(
        board.season_entries.is_empty(),
        "the previous league's board reappeared"
    );
    assert_eq!(
        board.season_status,
        LeaderboardStatus::Idle,
        "the previous league's board left its spinner or its refusal behind"
    );
}

// ── Co-op ───────────────────────────────────────────────────────────────────

fn mission(id: i32, name: &str) -> CoopMission {
    CoopMission {
        id,
        name: name.into(),
        description: String::new(),
        version: 1,
        download_url: String::new(),
        thumbnail_url_small: String::new(),
        thumbnail_url_large: String::new(),
        map_folder_name: format!("scmp_coop_{id}"),
        scenario_id: None,
        order: id,
    }
}

/// One mission, named after the catalogue read that listed it, and a board of
/// one team named after the board read.
struct GatedCoop(Gates);

#[async_trait]
impl CoopPort for GatedCoop {
    async fn list_catalog(&self) -> Result<(Vec<CoopScenario>, Vec<CoopMission>), RequestError> {
        let call = self.0.pass("catalog").await;
        if call.refused {
            return Err(RequestError::unexpected(refusal(&call)));
        }
        Ok((Vec::new(), vec![mission(1, &call.key)]))
    }
    async fn list_leaderboard(
        &self,
        mission_id: i32,
        player_count: i32,
    ) -> Result<Vec<CoopResult>, RequestError> {
        let call = self
            .0
            .pass(&format!("board {mission_id}/{player_count}"))
            .await;
        if call.refused {
            return Err(RequestError::unexpected(refusal(&call)));
        }
        Ok(vec![CoopResult {
            id: 1,
            ranking: 0,
            secondary_objectives: false,
            duration_seconds: 600,
            player_count: player_count.max(1),
            players: vec![call.key],
            replay_id: None,
            played_at: None,
        }])
    }
}

fn with_gated_coop() -> (Arc<App>, Gates) {
    let gates = Gates::default();
    let app = start(Ports {
        coop: Arc::new(GatedCoop(gates.clone())),
        ..fake_ports()
    });
    (app, gates)
}

/// The refresh button asks again regardless of what is loaded, so refreshes
/// can overlap. Two older ones, one that will list missions and one that will
/// be refused, are overtaken by a third: its catalogue stays, and the stale
/// one does not go on to reload the board.
#[tokio::test]
async fn an_older_coop_catalogue_never_replaces_a_newer_one() {
    let (app, gates) = with_gated_coop();
    gates.hold("catalog #1");
    gates.hold_refused("catalog #2");

    let refresh = || AppCommand::from(CoopCommand::RefreshCatalog);
    let stale_ok = start_held(&app, &gates, refresh(), "catalog #1").await;
    let stale_err = start_held(&app, &gates, refresh(), "catalog #2").await;
    run(&app, refresh()).await;
    release_all(
        &gates,
        &["catalog #1", "catalog #2"],
        vec![stale_ok, stale_err],
    )
    .await;

    let coop = app.snapshot().coop;
    assert_eq!(coop.missions.len(), 1);
    assert_eq!(coop.missions[0].name, "catalog #3");
    assert_eq!(coop.catalog_status, CoopStatus::Ready);
    assert_eq!(coop.selected_mission_id, Some(1));
    assert_eq!(
        coop.leaderboard[0].players,
        vec!["board 1/0 #1".to_string()]
    );
    assert_eq!(
        gates.calls("board 1/0"),
        1,
        "the stale catalogue reloaded the board"
    );
}

/// Picking a mission and then changing the player filter twice: the first
/// board (same mission, same filter as the newest, so only the generation can
/// tell) and the refused second one both answer after the newest has landed.
/// Neither may replace it or mark it failed.
#[tokio::test]
async fn an_older_coop_board_never_replaces_a_newer_one() {
    let (app, gates) = with_gated_coop();
    gates.hold("board 1/0 #1");
    gates.hold_refused("board 1/2 #1");

    let stale_ok = start_held(
        &app,
        &gates,
        CoopCommand::SelectMission { mission_id: 1 }.into(),
        "board 1/0 #1",
    )
    .await;
    let stale_err = start_held(
        &app,
        &gates,
        CoopCommand::SetPlayerCount { player_count: 2 }.into(),
        "board 1/2 #1",
    )
    .await;
    run(&app, CoopCommand::SetPlayerCount { player_count: 0 }.into()).await;
    release_all(
        &gates,
        &["board 1/0 #1", "board 1/2 #1"],
        vec![stale_ok, stale_err],
    )
    .await;

    let coop = app.snapshot().coop;
    assert_eq!(coop.selected_mission_id, Some(1));
    assert_eq!(coop.player_count, 0);
    assert_eq!(coop.leaderboard.len(), 1);
    assert_eq!(
        coop.leaderboard[0].players,
        vec!["board 1/0 #2".to_string()]
    );
    assert_eq!(coop.leaderboard_status, CoopStatus::Ready);
}

// ── Catalogue maintenance queue ─────────────────────────────────────────────

fn submission(number: i32, title: &str) -> GuideSubmission {
    GuideSubmission {
        number,
        title: title.into(),
        ..GuideSubmission::default()
    }
}

/// The offline repository, except that the queue lists submissions 7 and 8
/// titled after the read that listed them, and a rejection goes through.
struct GatedGuides(Gates);

#[async_trait]
impl GuidesPort for GatedGuides {
    fn repo(&self) -> String {
        FakeGuides.repo()
    }
    fn configured(&self) -> bool {
        FakeGuides.configured()
    }
    async fn begin_login(&self) -> Result<DeviceCode, String> {
        FakeGuides.begin_login().await
    }
    async fn complete_login(&self, code: DeviceCode) -> Result<GuidesIdentity, String> {
        FakeGuides.complete_login(code).await
    }
    fn cancel_login(&self) {
        FakeGuides.cancel_login();
    }
    async fn restore_login(&self) -> Result<Option<GuidesIdentity>, String> {
        FakeGuides.restore_login().await
    }
    async fn sign_out(&self) {
        FakeGuides.sign_out().await;
    }
    async fn list_submissions(&self) -> Result<Vec<GuideSubmission>, String> {
        let call = self.0.pass("queue").await;
        if call.refused {
            return Err(refusal(&call));
        }
        Ok(vec![submission(7, &call.key), submission(8, &call.key)])
    }
    async fn accept(&self, submission: GuideSubmission) -> Result<(), String> {
        FakeGuides.accept(submission).await
    }
    async fn reject(&self, _: i32, _: RejectReason, _: String) -> Result<(), String> {
        Ok(())
    }
    async fn submit(&self, entry: TrainingResource, guide: String) -> Result<String, String> {
        FakeGuides.submit(entry, guide).await
    }
}

/// Two queue reads, one that will list and one that will be refused, are
/// still in flight when a verdict reloads the queue. Both predate the verdict,
/// so neither may replace the reload or mark the queue failed.
#[tokio::test]
async fn an_older_queue_never_replaces_the_reload_after_a_verdict() {
    let gates = Gates::default();
    let app = start(Ports {
        guides: Arc::new(GatedGuides(gates.clone())),
        ..fake_ports()
    });
    gates.hold("queue #1");
    gates.hold_refused("queue #2");

    let load = || AppCommand::from(GuidesCommand::LoadQueue);
    let stale_ok = start_held(&app, &gates, load(), "queue #1").await;
    let stale_err = start_held(&app, &gates, load(), "queue #2").await;
    run(
        &app,
        GuidesCommand::Reject {
            number: 7,
            reason: RejectReason::Duplicate,
            note: String::new(),
        }
        .into(),
    )
    .await;
    release_all(&gates, &["queue #1", "queue #2"], vec![stale_ok, stale_err]).await;

    let guides = app.snapshot().guides;
    assert_eq!(guides.submissions, vec![submission(8, "queue #3")]);
    assert_eq!(guides.status, GuidesStatus::Ready);
}

// ── Player card ─────────────────────────────────────────────────────────────

/// The offline player card, except that the profile, matchmaker profile,
/// history pages and map statistics are named per call and may be held or
/// refused. History always comes in two pages, so a load can be caught
/// between them.
struct GatedCard(Gates);

#[async_trait]
impl PlayerCardPort for GatedCard {
    async fn search_players(
        &self,
        query: &str,
        limit: i32,
    ) -> Result<Vec<PlayerSummary>, RequestError> {
        FakePlayerCard.search_players(query, limit).await
    }
    async fn players_by_login(
        &self,
        logins: &[String],
    ) -> Result<Vec<PlayerSummary>, RequestError> {
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
        let call = self.0.pass(&format!("profile {login}")).await;
        if call.refused {
            return Err(refusal(&call));
        }
        FakePlayerCard.load_profile(player_id, login).await
    }
    async fn load_matchmaker_profile(
        &self,
        player_id: i32,
        login: &str,
    ) -> Result<MatchmakerPlayerProfile, String> {
        let call = self.0.pass(&format!("matchmaker {player_id}")).await;
        if call.refused {
            return Err(refusal(&call));
        }
        FakePlayerCard
            .load_matchmaker_profile(player_id, login)
            .await
    }
    async fn load_league_placements(
        &self,
        player_ids: &[i32],
    ) -> Result<std::collections::BTreeMap<i32, Vec<PlayerLeaguePlacement>>, String> {
        FakePlayerCard.load_league_placements(player_ids).await
    }
    async fn load_rating_history(
        &self,
        query: &RatingHistoryQuery,
    ) -> Result<RatingHistoryPage, String> {
        let call = self
            .0
            .pass(&format!("history {} p{}", query.player_id, query.page))
            .await;
        if call.refused {
            return Err(refusal(&call));
        }
        Ok(RatingHistoryPage {
            points: vec![RatingHistoryPoint {
                timestamp: call.key,
                rating: 1500.0,
                mean: 1800.0,
                deviation: 100.0,
            }],
            maximum: None,
            page: query.page,
            total_pages: 2,
        })
    }
    async fn load_map_stats(&self, player_id: i32) -> Result<PlayerMapStats, String> {
        let call = self.0.pass(&format!("map stats {player_id}")).await;
        if call.refused {
            return Err(refusal(&call));
        }
        Ok(PlayerMapStats {
            total_games: player_id,
            ..PlayerMapStats::default()
        })
    }
}

fn with_gated_card() -> (Arc<App>, Gates) {
    let gates = Gates::default();
    let app = start(Ports {
        player_card: Arc::new(GatedCard(gates.clone())),
        ..fake_ports()
    });
    (app, gates)
}

fn open_card(player_id: i32, login: &str) -> AppCommand {
    PlayerCardCommand::Open {
        player_id: Some(player_id),
        login: login.into(),
    }
    .into()
}

fn history_of(player_id: i32) -> AppCommand {
    PlayerCardCommand::LoadHistory {
        query: RatingHistoryQuery {
            player_id,
            leaderboard_id: 1,
            leaderboard: "global".into(),
            period: RatingHistoryPeriod::All,
            page: 1,
            page_size: 100,
        },
    }
    .into()
}

fn history_timestamps(app: &App) -> Vec<String> {
    app.snapshot()
        .player_card
        .history
        .into_iter()
        .map(|point| point.timestamp)
        .collect()
}

/// Opening one player after another: the profiles of the two before, one that
/// loads and one that is refused, answer after the newest. The card keeps the
/// newest player and shows no error.
#[tokio::test]
async fn an_older_profile_never_replaces_a_newer_one() {
    let (app, gates) = with_gated_card();
    gates.hold("profile Old #1");
    gates.hold_refused("profile Broken #1");

    let stale_ok = start_held(&app, &gates, open_card(7, "Old"), "profile Old #1").await;
    let stale_err = start_held(&app, &gates, open_card(9, "Broken"), "profile Broken #1").await;
    run(&app, open_card(8, "New")).await;
    release_all(
        &gates,
        &["profile Old #1", "profile Broken #1"],
        vec![stale_ok, stale_err],
    )
    .await;

    let state = app.snapshot();
    let card = state.player_card;
    assert!(card.open);
    let profile = card.profile.expect("the newest profile is on screen");
    assert_eq!((profile.player_id, profile.login.as_str()), (8, "New"));
    assert_eq!(card.profile_status, PlayerCardStatus::Ready);
    assert!(card.profile_error.is_empty(), "{}", card.profile_error);
    assert!(state.notifications.items.is_empty());
}

/// Closing the card while its profile is still loading: neither a late profile
/// nor a late refusal may fill the closed card.
#[tokio::test]
async fn a_profile_answering_after_close_does_not_fill_the_card() {
    let (app, gates) = with_gated_card();
    gates.hold("profile Old #1");
    gates.hold_refused("profile Broken #1");

    let stale_ok = start_held(&app, &gates, open_card(7, "Old"), "profile Old #1").await;
    let stale_err = start_held(&app, &gates, open_card(9, "Broken"), "profile Broken #1").await;
    run(&app, PlayerCardCommand::Close.into()).await;
    release_all(
        &gates,
        &["profile Old #1", "profile Broken #1"],
        vec![stale_ok, stale_err],
    )
    .await;

    let card = app.snapshot().player_card;
    assert!(!card.open);
    assert_eq!(card.profile, None, "a closed card was filled in");
    assert_eq!(card.profile_status, PlayerCardStatus::Idle);
    assert!(card.profile_error.is_empty(), "{}", card.profile_error);
}

/// Switching the history to another queue twice: the first history, which
/// would load, and the second, which would be refused, answer after the
/// newest has loaded both its pages. The newest history stays whole.
#[tokio::test]
async fn an_older_history_never_replaces_a_newer_one() {
    let (app, gates) = with_gated_card();
    gates.hold("history 7 p1 #1");
    gates.hold_refused("history 9 p1 #1");

    let stale_ok = start_held(&app, &gates, history_of(7), "history 7 p1 #1").await;
    let stale_err = start_held(&app, &gates, history_of(9), "history 9 p1 #1").await;
    run(&app, history_of(8)).await;
    release_all(
        &gates,
        &["history 7 p1 #1", "history 9 p1 #1"],
        vec![stale_ok, stale_err],
    )
    .await;

    assert_eq!(
        history_timestamps(&app),
        vec!["history 8 p1 #1".to_string(), "history 8 p2 #1".to_string()]
    );
    let card = app.snapshot().player_card;
    assert_eq!(card.history_query.map(|query| query.player_id), Some(8));
    assert_eq!(card.history_status, PlayerCardStatus::Ready);
    assert!(card.history_error.is_empty(), "{}", card.history_error);
    assert_eq!(
        gates.calls("history 7 p2"),
        0,
        "a stale history kept paging"
    );
}

/// History loads page after page. Opening another player between two pages
/// must stop it: the previous player's second page may not be appended under
/// the new name.
#[tokio::test]
async fn opening_another_player_stops_the_previous_history_between_pages() {
    let (app, gates) = with_gated_card();
    gates.hold("history 7 p2 #1");

    let stale = start_held(&app, &gates, history_of(7), "history 7 p2 #1").await;
    assert_eq!(
        history_timestamps(&app),
        vec!["history 7 p1 #1".to_string()]
    );
    run(&app, open_card(8, "New")).await;
    release_all(&gates, &["history 7 p2 #1"], vec![stale]).await;

    let card = app.snapshot().player_card;
    assert!(card.history.is_empty(), "the previous player's page landed");
    assert_eq!(card.history_query, None);
    assert_eq!(card.history_status, PlayerCardStatus::Idle);
}

/// Closing the card while a history load and a newer, refused one are still
/// in flight: neither the points nor the refusal may land on the closed card.
#[tokio::test]
async fn closing_the_card_drops_the_history_in_flight() {
    let (app, gates) = with_gated_card();
    gates.hold("history 7 p1 #1");
    gates.hold_refused("history 9 p1 #1");

    let stale_ok = start_held(&app, &gates, history_of(7), "history 7 p1 #1").await;
    let stale_err = start_held(&app, &gates, history_of(9), "history 9 p1 #1").await;
    run(&app, PlayerCardCommand::Close.into()).await;
    release_all(
        &gates,
        &["history 7 p1 #1", "history 9 p1 #1"],
        vec![stale_ok, stale_err],
    )
    .await;

    let card = app.snapshot().player_card;
    assert!(card.history.is_empty(), "history landed on a closed card");
    assert_eq!(card.history_status, PlayerCardStatus::Idle);
    assert!(card.history_error.is_empty(), "{}", card.history_error);
}

/// Matchmaker profiles for two players before, one that loads and one that is
/// refused, answer after the newest. The newest stays, without an error.
#[tokio::test]
async fn an_older_matchmaker_profile_never_replaces_a_newer_one() {
    let (app, gates) = with_gated_card();
    gates.hold("matchmaker 7 #1");
    gates.hold_refused("matchmaker 9 #1");

    let matchmaker = |player_id: i32, login: &str| {
        AppCommand::from(PlayerCardCommand::LoadMatchmakerProfile {
            player_id,
            login: login.into(),
        })
    };
    let stale_ok = start_held(&app, &gates, matchmaker(7, "Old"), "matchmaker 7 #1").await;
    let stale_err = start_held(&app, &gates, matchmaker(9, "Broken"), "matchmaker 9 #1").await;
    run(&app, matchmaker(8, "New")).await;
    release_all(
        &gates,
        &["matchmaker 7 #1", "matchmaker 9 #1"],
        vec![stale_ok, stale_err],
    )
    .await;

    let card = app.snapshot().player_card;
    let profile = card
        .matchmaker_profile
        .expect("the newest matchmaker profile is on screen");
    assert_eq!((profile.player_id, profile.login.as_str()), (8, "New"));
    assert_eq!(card.matchmaker_profile_status, PlayerCardStatus::Ready);
    assert!(
        card.matchmaker_profile_error.is_empty(),
        "{}",
        card.matchmaker_profile_error
    );
}

/// The map scan walks a player's whole history, so it is the slowest part of
/// the card. Two older scans, one that finishes and one that is refused, may
/// not land under the newest player's name.
#[tokio::test]
async fn older_map_statistics_never_replace_newer_ones() {
    let (app, gates) = with_gated_card();
    gates.hold("map stats 7 #1");
    gates.hold_refused("map stats 9 #1");

    let scan = |player_id: i32| AppCommand::from(PlayerCardCommand::LoadMapStats { player_id });
    let stale_ok = start_held(&app, &gates, scan(7), "map stats 7 #1").await;
    let stale_err = start_held(&app, &gates, scan(9), "map stats 9 #1").await;
    run(&app, scan(8)).await;
    release_all(
        &gates,
        &["map stats 7 #1", "map stats 9 #1"],
        vec![stale_ok, stale_err],
    )
    .await;

    let card = app.snapshot().player_card;
    let stats = card.map_stats.expect("the newest statistics are on screen");
    assert_eq!(stats.total_games, 8, "another player's maps are on screen");
    assert_eq!(card.map_stats_status, PlayerCardStatus::Ready);
    assert!(card.map_stats_error.is_empty(), "{}", card.map_stats_error);
}

// ── Reviews ─────────────────────────────────────────────────────────────────

/// The signed-in player's own review, which is what a submit updates and a
/// delete withdraws.
const OWN_REVIEW: i32 = 5;

/// Every subject lists one review by the signed-in player, whose text names the
/// read that listed it. Writes go through unless held or refused.
struct GatedReviews(Gates);

#[async_trait]
impl ReviewsPort for GatedReviews {
    async fn list(&self, _: ReviewKind, subject_id: i32) -> Result<ReviewPage, String> {
        let call = self.0.pass(&format!("reviews {subject_id}")).await;
        if call.refused {
            return Err(refusal(&call));
        }
        Ok(ReviewPage {
            reviews: vec![Review {
                id: OWN_REVIEW,
                score: 4,
                text: call.key,
                player: "Ada".into(),
                version: "3".into(),
            }],
            latest_version_id: Some(3),
        })
    }
    async fn create(
        &self,
        _: ReviewKind,
        _: i32,
        _: i32,
        _: i32,
        _: String,
    ) -> Result<Review, String> {
        unreachable!("the player already has a review, so a submit updates it")
    }
    async fn update(&self, _: ReviewKind, review_id: i32, _: i32, _: String) -> Result<(), String> {
        let call = self.0.pass(&format!("update {review_id}")).await;
        if call.refused {
            return Err(refusal(&call));
        }
        Ok(())
    }
    async fn delete(&self, _: ReviewKind, review_id: i32) -> Result<(), String> {
        let call = self.0.pass(&format!("delete {review_id}")).await;
        if call.refused {
            return Err(refusal(&call));
        }
        Ok(())
    }
}

fn with_gated_reviews() -> (Arc<App>, Gates) {
    let gates = Gates::default();
    let app = start(Ports {
        auth: Arc::new(FakeAuth {
            player: Player::new(7, "Ada"),
            delay: Duration::ZERO,
            fail_with: None,
        }),
        reviews: Arc::new(GatedReviews(gates.clone())),
        ..fake_ports()
    });
    (app, gates)
}

fn subject(id: i32) -> ReviewTarget {
    ReviewTarget {
        kind: ReviewKind::Map,
        id,
        name: format!("Map {id}"),
    }
}

fn open_reviews(id: i32) -> AppCommand {
    ReviewsCommand::Open {
        target: subject(id),
    }
    .into()
}

async fn sign_in(app: &Arc<App>) {
    run(app, AuthCommand::Login { remember: false }.into()).await;
}

/// Opening the reviews of one map after another: the lists for the two before,
/// one that loads and one that is refused, answer after the newest. The panel
/// keeps the newest map's reviews and shows no error.
#[tokio::test]
async fn an_older_review_list_never_replaces_a_newer_subject() {
    let (app, gates) = with_gated_reviews();
    gates.hold("reviews 1 #1");
    gates.hold_refused("reviews 2 #1");

    let stale_ok = start_held(&app, &gates, open_reviews(1), "reviews 1 #1").await;
    let stale_err = start_held(&app, &gates, open_reviews(2), "reviews 2 #1").await;
    run(&app, open_reviews(3)).await;
    release_all(
        &gates,
        &["reviews 1 #1", "reviews 2 #1"],
        vec![stale_ok, stale_err],
    )
    .await;

    let reviews = app.snapshot().reviews;
    assert_eq!(reviews.target, Some(subject(3)));
    assert_eq!(reviews.reviews.len(), 1);
    assert_eq!(reviews.reviews[0].text, "reviews 3 #1");
    assert_eq!(reviews.status, ReviewsStatus::Ready);
}

/// Closing the panel while its list is loading: neither a late list nor a
/// late refusal may touch the closed panel.
#[tokio::test]
async fn a_review_list_answering_after_close_leaves_the_panel_closed() {
    let (app, gates) = with_gated_reviews();
    gates.hold("reviews 1 #1");
    gates.hold_refused("reviews 2 #1");

    let stale_ok = start_held(&app, &gates, open_reviews(1), "reviews 1 #1").await;
    let stale_err = start_held(&app, &gates, open_reviews(2), "reviews 2 #1").await;
    run(&app, ReviewsCommand::Close.into()).await;
    release_all(
        &gates,
        &["reviews 1 #1", "reviews 2 #1"],
        vec![stale_ok, stale_err],
    )
    .await;

    assert_eq!(app.snapshot().reviews, ReviewsState::default());
}

/// A write is an answer too. An update the server refuses after the panel was
/// closed must not reopen it with "could not save".
#[tokio::test]
async fn a_refused_write_answering_after_close_is_not_reported() {
    let (app, gates) = with_gated_reviews();
    sign_in(&app).await;
    run(&app, open_reviews(42)).await;
    let update = format!("update {OWN_REVIEW} #1");
    gates.hold_refused(&update);

    let submit = ReviewsCommand::Submit {
        score: 5,
        text: "better on a second look".into(),
    };
    let stale = start_held(&app, &gates, submit.into(), &update).await;
    run(&app, ReviewsCommand::Close.into()).await;
    release_all(&gates, &[update.as_str()], vec![stale]).await;

    let state = app.snapshot();
    assert_eq!(state.reviews, ReviewsState::default());
    assert!(state.notifications.items.is_empty());
}

/// Every write re-reads the list, and the re-read carries no target of its
/// own. Withdrawing a review and then opening another map before the re-read
/// answers: the first map's list must not land as "saved" on the second.
#[tokio::test]
async fn the_re_read_after_a_write_never_lands_on_the_next_subject() {
    let (app, gates) = with_gated_reviews();
    sign_in(&app).await;
    run(&app, open_reviews(42)).await;
    gates.hold("reviews 42 #2");

    let stale = start_held(&app, &gates, ReviewsCommand::Delete.into(), "reviews 42 #2").await;
    run(&app, open_reviews(43)).await;
    release_all(&gates, &["reviews 42 #2"], vec![stale]).await;

    let reviews = app.snapshot().reviews;
    assert_eq!(reviews.target, Some(subject(43)));
    assert_eq!(reviews.reviews[0].text, "reviews 43 #1");
    assert_eq!(reviews.status, ReviewsStatus::Ready);
    assert_eq!(
        reviews.submit,
        ReviewSubmitStatus::Idle,
        "the previous map's write was reported on this one"
    );
}
