//! Co-op service tests: driven through a configurable fake port.
//!
//! The behaviour worth pinning here is the coupling: selecting a mission or
//! changing the team-size filter must *reload the board*, because the
//! leaderboard is never something the user asks for separately.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{CoopPort, RequestError};
use faf_app::{App, Ports};
use faf_domain::state::{
    CoopCategory, CoopCommand, CoopFaction, CoopMission, CoopResult, CoopScenario, CoopStatus,
};

/// Records every leaderboard query, so the test can assert what was asked for.
struct StubCoop {
    queries: Arc<Mutex<Vec<(i32, i32)>>>,
    results: Vec<CoopResult>,
}

#[async_trait]
impl CoopPort for StubCoop {
    async fn list_catalog(&self) -> Result<(Vec<CoopScenario>, Vec<CoopMission>), RequestError> {
        Ok((
            vec![CoopScenario {
                id: 1,
                name: "Operation Ivory Sun".into(),
                description: String::new(),
                order: 1,
                faction: CoopFaction::Uef,
                category: CoopCategory::Scfa,
            }],
            vec![mission(7, "Ivory Sun 1"), mission(8, "Ivory Sun 2")],
        ))
    }

    async fn list_leaderboard(
        &self,
        mission_id: i32,
        player_count: i32,
    ) -> Result<Vec<CoopResult>, RequestError> {
        self.queries
            .lock()
            .unwrap()
            .push((mission_id, player_count));
        Ok(self.results.clone())
    }
}

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
        scenario_id: Some(1),
        order: id,
    }
}

fn result(id: i32, seconds: u32, players: &[&str]) -> CoopResult {
    CoopResult {
        id,
        ranking: 0,
        secondary_objectives: false,
        duration_seconds: seconds,
        player_count: players.len() as i32,
        players: players.iter().map(|p| p.to_string()).collect(),
        replay_id: None,
        played_at: None,
    }
}

/// Wait until `condition` holds of the co-op slice.
///
/// `App::dispatch` hands the command to the loop, which runs it on its own
/// task: so a snapshot taken straight after dispatching races the service.
async fn settle(app: &App, what: &str, condition: impl Fn(&faf_domain::state::CoopState) -> bool) {
    for _ in 0..300 {
        if condition(&app.snapshot().coop) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}: {:?}", app.snapshot().coop);
}

/// Wait for the catalog load to finish, either way.
async fn settled_catalog(app: &App) {
    settle(app, "the catalog to settle", |coop| {
        !matches!(coop.catalog_status, CoopStatus::Idle | CoopStatus::Loading)
    })
    .await;
}

struct Harness {
    app: App,
    queries: Arc<Mutex<Vec<(i32, i32)>>>,
}

impl Harness {
    /// Wait until exactly `count` leaderboard queries have been issued.
    async fn queried(&self, count: usize) {
        for _ in 0..300 {
            if self.queries.lock().unwrap().len() >= count {
                // Let a stray extra query surface rather than passing early.
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!(
            "expected {count} leaderboard queries, saw {:?}",
            self.queries.lock().unwrap()
        );
    }
}

fn harness(results: Vec<CoopResult>) -> Harness {
    let queries = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        coop: Arc::new(StubCoop {
            queries: queries.clone(),
            results,
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    Harness { app, queries }
}

#[tokio::test]
async fn loading_the_catalog_opens_the_first_mission_and_its_board() {
    // Java's controller subscribes both combo boxes to `loadLeaderboard`, so
    // the board is never empty just because nobody touched a filter.
    let h = harness(vec![result(1, 900, &["Ada"])]);
    h.app
        .dispatch(CoopCommand::LoadCatalog.into())
        .await
        .unwrap();
    h.queried(1).await;
    let state = h.app.snapshot().coop;
    assert_eq!(state.catalog_status, CoopStatus::Ready);
    assert_eq!(state.missions.len(), 2);
    assert_eq!(state.scenarios.len(), 1);
    assert_eq!(state.selected_mission_id, Some(7));
    assert_eq!(
        *h.queries.lock().unwrap(),
        vec![(7, 0)],
        "the first mission's board loads with no team-size filter"
    );
    assert_eq!(state.leaderboard.len(), 1);
    assert_eq!(state.leaderboard_status, CoopStatus::Ready);
}

#[tokio::test]
async fn the_service_ranks_what_the_api_returns() {
    // The server returns every completion; collapsing repeat runs by one team
    // and numbering the survivors is the client's job.
    let h = harness(vec![
        result(1, 900, &["Ada", "Bob"]),
        result(2, 600, &["Ada", "Bob"]),
        result(3, 700, &["Cid"]),
    ]);
    h.app
        .dispatch(CoopCommand::LoadCatalog.into())
        .await
        .unwrap();
    h.queried(1).await;
    let board = h.app.snapshot().coop.leaderboard;
    assert_eq!(board.len(), 2, "the duo's two runs collapse to their best");
    assert_eq!(board[0].ranking, 1);
    assert_eq!(board[0].duration_seconds, 600);
    assert_eq!(board[1].ranking, 2);
    assert_eq!(board[1].duration_seconds, 700);
}

#[tokio::test]
async fn selecting_a_mission_reloads_the_board_for_it() {
    let h = harness(vec![result(1, 900, &["Ada"])]);
    h.app
        .dispatch(CoopCommand::LoadCatalog.into())
        .await
        .unwrap();
    h.queried(1).await;
    h.app
        .dispatch(CoopCommand::SelectMission { mission_id: 8 }.into())
        .await
        .unwrap();
    h.queried(2).await;

    assert_eq!(h.app.snapshot().coop.selected_mission_id, Some(8));
    assert_eq!(*h.queries.lock().unwrap(), vec![(7, 0), (8, 0)]);
}

#[tokio::test]
async fn changing_the_team_size_reloads_the_board() {
    let h = harness(vec![result(1, 900, &["Ada"])]);
    h.app
        .dispatch(CoopCommand::LoadCatalog.into())
        .await
        .unwrap();
    h.queried(1).await;
    h.app
        .dispatch(CoopCommand::SetPlayerCount { player_count: 2 }.into())
        .await
        .unwrap();
    h.queried(2).await;

    assert_eq!(h.app.snapshot().coop.player_count, 2);
    assert_eq!(
        *h.queries.lock().unwrap(),
        vec![(7, 0), (7, 2)],
        "same mission, now filtered to duos"
    );
}

#[tokio::test]
async fn an_empty_catalog_does_not_query_a_board() {
    // Nothing is selected, so there is nothing to ask about: a query with a
    // missing mission id would be a 400.
    struct EmptyCoop;
    #[async_trait]
    impl CoopPort for EmptyCoop {
        async fn list_catalog(
            &self,
        ) -> Result<(Vec<CoopScenario>, Vec<CoopMission>), RequestError> {
            Ok((Vec::new(), Vec::new()))
        }
        async fn list_leaderboard(&self, _: i32, _: i32) -> Result<Vec<CoopResult>, RequestError> {
            panic!("must not query a board with nothing selected");
        }
    }

    let ports = Ports {
        coop: Arc::new(EmptyCoop),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());

    app.dispatch(CoopCommand::LoadCatalog.into()).await.unwrap();
    settled_catalog(&app).await;
    let state = app.snapshot().coop;
    assert_eq!(state.catalog_status, CoopStatus::Ready);
    assert_eq!(state.selected_mission_id, None);
}

#[tokio::test]
async fn a_failed_catalog_reports_the_reason_and_asks_for_no_board() {
    struct FailingCoop;
    #[async_trait]
    impl CoopPort for FailingCoop {
        async fn list_catalog(
            &self,
        ) -> Result<(Vec<CoopScenario>, Vec<CoopMission>), RequestError> {
            Err(RequestError::offline("503 Service Unavailable"))
        }
        async fn list_leaderboard(&self, _: i32, _: i32) -> Result<Vec<CoopResult>, RequestError> {
            panic!("must not query a board when the catalog failed");
        }
    }

    let ports = Ports {
        coop: Arc::new(FailingCoop),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());

    app.dispatch(CoopCommand::LoadCatalog.into()).await.unwrap();
    settled_catalog(&app).await;
    match app.snapshot().coop.catalog_status {
        CoopStatus::Failed { reason, kind } => {
            assert!(reason.contains("503"));
            assert_eq!(kind, faf_domain::state::RequestFailureKind::Offline);
        }
        other => panic!("expected a failure, got {other:?}"),
    }
}
