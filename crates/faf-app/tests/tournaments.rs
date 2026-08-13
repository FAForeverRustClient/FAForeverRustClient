//! Tournament service tests: driven through a configurable fake port.

use std::sync::Arc;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::TournamentsPort;
use faf_app::{App, Ports};
use faf_domain::state::{Tournament, TournamentsCommand, TournamentsEvent, TournamentsStatus};
use faf_domain::AppEvent;

struct StubTournaments(Result<Vec<Tournament>, String>);

#[async_trait]
impl TournamentsPort for StubTournaments {
    async fn list_tournaments(&self) -> Result<Vec<Tournament>, String> {
        self.0.clone()
    }
}

fn app_with(result: Result<Vec<Tournament>, String>) -> App {
    let ports = Ports {
        tournaments: Arc::new(StubTournaments(result)),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    app
}

fn tournament(id: i32, name: &str) -> Tournament {
    Tournament {
        id,
        name: name.into(),
        description: String::new(),
        tournament_type: "swiss".into(),
        participant_count: 0,
        created_at: Some(1_700_000_000),
        starting_at: None,
        completed_at: None,
        challonge_url: String::new(),
        live_image_url: String::new(),
        sign_up_url: String::new(),
        open_for_signup: false,
    }
}

/// The next event belonging to this slice, skipping any others in flight.
async fn next_event(events: &mut tokio::sync::broadcast::Receiver<AppEvent>) -> TournamentsEvent {
    loop {
        if let AppEvent::Tournaments(event) = events.recv().await.unwrap() {
            return event;
        }
    }
}

#[tokio::test]
async fn loading_emits_progress_then_a_sorted_list() {
    let now = u32::try_from(chrono::Utc::now().timestamp()).unwrap();
    let app = app_with(Ok(vec![
        Tournament {
            completed_at: Some(now - 3_600),
            ..tournament(1, "Finished")
        },
        Tournament {
            open_for_signup: true,
            ..tournament(2, "Open")
        },
    ]));
    let mut events = app.subscribe();

    app.dispatch(TournamentsCommand::Load.into()).await.unwrap();

    assert_eq!(next_event(&mut events).await, TournamentsEvent::Loading);
    match next_event(&mut events).await {
        TournamentsEvent::Loaded { tournaments } => {
            // Sorting is the service's job, not the view's: every consumer of
            // the state sees the same order.
            let order: Vec<i32> = tournaments.iter().map(|t| t.id).collect();
            assert_eq!(order, vec![2, 1], "finished events sink to the bottom");
        }
        other => panic!("expected Loaded, got {other:?}"),
    }

    let state = app.snapshot().tournaments;
    assert_eq!(state.status, TournamentsStatus::Ready);
    assert_eq!(state.selected_id, Some(2), "the first row opens by default");
}

#[tokio::test]
async fn a_failed_load_reports_the_reason() {
    let app = app_with(Err("503 Service Unavailable".into()));
    let mut events = app.subscribe();

    app.dispatch(TournamentsCommand::Load.into()).await.unwrap();
    assert_eq!(next_event(&mut events).await, TournamentsEvent::Loading);
    match next_event(&mut events).await {
        TournamentsEvent::LoadFailed { reason } => assert!(reason.contains("503")),
        other => panic!("expected LoadFailed, got {other:?}"),
    }
    assert!(matches!(
        app.snapshot().tournaments.status,
        TournamentsStatus::Failed { .. }
    ));
}

#[tokio::test]
async fn selecting_opens_that_event() {
    let app = app_with(Ok(vec![tournament(1, "First"), tournament(2, "Second")]));
    let mut events = app.subscribe();

    app.dispatch(TournamentsCommand::Load.into()).await.unwrap();
    next_event(&mut events).await;
    next_event(&mut events).await;

    app.dispatch(TournamentsCommand::Select { tournament_id: 2 }.into())
        .await
        .unwrap();
    assert_eq!(
        next_event(&mut events).await,
        TournamentsEvent::Selected { tournament_id: 2 }
    );
    assert_eq!(app.snapshot().tournaments.selected_id, Some(2));
}

#[tokio::test]
async fn the_offline_bundle_serves_a_browsable_list() {
    // The fake port exists so the view can be worked on without an account,
    // an empty list and a broken list look identical on screen.
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();

    app.dispatch(TournamentsCommand::Load.into()).await.unwrap();
    next_event(&mut events).await; // Loading
    next_event(&mut events).await; // Loaded

    let state = app.snapshot().tournaments;
    assert_eq!(state.status, TournamentsStatus::Ready);
    assert!(!state.tournaments.is_empty());
    assert!(state.selected_id.is_some());
}
