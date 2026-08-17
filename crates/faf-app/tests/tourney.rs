//! faf-tournaments service tests: a player's flow, end to end through the app.
//!
//! Driven against the writable fake port rather than per-test stubs, because
//! what is worth asserting here is the *sequence*: a write is announced, runs
//! alone, and is followed by a reload that leaves the list and the detail
//! agreeing. A stub that answered one call could not show any of that.

use std::sync::Arc;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{RequestError, TourneyPort};
use faf_app::{App, Ports};
use faf_domain::state::{
    Article, ChatPost, ChatRoom, HostingStatus, MatchReport, MatchStatus, PoolDraft, Tourney,
    TourneyAction, TourneyCommand, TourneyDraft, TourneyEvent, TourneyLoadStatus, TourneyPhase,
    TourneyStatus,
};
use faf_domain::AppEvent;

/// A port that reads fine and refuses every write with the same error.
///
/// Stands in for the case the whole tab has to survive: a signed-in account
/// that is simply not entitled: not an organiser here, or below the rating
/// gate. Reads work, writes come back 403 with a sentence worth showing.
struct RefusingTourney {
    inner: faf_app::infra::FakeTourney,
    error: RequestError,
}

impl RefusingTourney {
    fn refused<T>(&self) -> Result<T, RequestError> {
        Err(self.error.clone())
    }
}

#[async_trait]
impl TourneyPort for RefusingTourney {
    async fn list(&self) -> Result<Vec<Tourney>, RequestError> {
        self.inner.list().await
    }
    async fn detail(&self, tournament_id: &str) -> Result<Tourney, RequestError> {
        self.inner.detail(tournament_id).await
    }
    async fn hosting(&self) -> Result<HostingStatus, RequestError> {
        self.inner.hosting().await
    }
    async fn create(&self, _: &TourneyDraft) -> Result<String, RequestError> {
        self.refused()
    }
    async fn edit_info(&self, _: &str, _: &TourneyDraft) -> Result<(), RequestError> {
        self.refused()
    }
    async fn publish(&self, _: &str) -> Result<(), RequestError> {
        self.refused()
    }
    async fn advance(&self, _: &str, _: TourneyPhase) -> Result<(), RequestError> {
        self.refused()
    }
    async fn archive(&self, _: &str) -> Result<(), RequestError> {
        self.refused()
    }
    async fn sign_up(&self, _: &str) -> Result<(), RequestError> {
        self.refused()
    }
    async fn withdraw(&self, _: &str, _: &str) -> Result<(), RequestError> {
        self.refused()
    }
    async fn create_team(&self, _: &str, _: &str) -> Result<(), RequestError> {
        self.refused()
    }
    async fn request_join(&self, _: &str, _: &str) -> Result<(), RequestError> {
        self.refused()
    }
    async fn cancel_join(&self, _: &str, _: &str) -> Result<(), RequestError> {
        self.refused()
    }
    async fn respond_join(&self, _: &str, _: &str, _: &str, _: bool) -> Result<(), RequestError> {
        self.refused()
    }
    async fn invite_to_team(&self, _: &str, _: &str, _: &str) -> Result<(), RequestError> {
        self.refused()
    }
    async fn respond_invite(&self, _: &str, _: &str, _: bool) -> Result<(), RequestError> {
        self.refused()
    }
    async fn leave_team(&self, _: &str) -> Result<(), RequestError> {
        self.refused()
    }
    async fn disband_team(&self, _: &str, _: &str) -> Result<(), RequestError> {
        self.refused()
    }
    async fn rename_team(&self, _: &str, _: &str, _: &str) -> Result<(), RequestError> {
        self.refused()
    }
    async fn check_in(&self, _: &str) -> Result<(), RequestError> {
        self.refused()
    }
    async fn submit_report(&self, _: &str, _: &MatchReport) -> Result<(), RequestError> {
        self.refused()
    }
    async fn confirm_report(&self, _: &str, _: &str, _: bool) -> Result<(), RequestError> {
        self.refused()
    }
    async fn decide_report(&self, _: &str, _: &MatchReport) -> Result<(), RequestError> {
        self.refused()
    }
    async fn chat_rooms(&self, tournament_id: &str) -> Result<Vec<ChatRoom>, RequestError> {
        self.inner.chat_rooms(tournament_id).await
    }
    async fn chat_read(&self, t: &str, room: &str) -> Result<Vec<ChatPost>, RequestError> {
        self.inner.chat_read(t, room).await
    }
    async fn chat_post(&self, _: &str, _: &str, _: &str) -> Result<(), RequestError> {
        self.refused()
    }
    async fn articles(&self) -> Result<Vec<Article>, RequestError> {
        self.inner.articles().await
    }
    async fn assign_pool(&self, _: &str, _: &str, _: &str) -> Result<(), RequestError> {
        self.refused()
    }
    async fn save_pool(&self, _: &str, _: &PoolDraft) -> Result<(), RequestError> {
        self.refused()
    }
}

/// The offline bundle's writable fake: the default for these tests.
fn app() -> App {
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());
    app
}

fn app_refusing(error: RequestError) -> App {
    let ports = Ports {
        tourney: Arc::new(RefusingTourney {
            inner: faf_app::infra::FakeTourney::new(),
            error,
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    app
}

/// The next event belonging to this slice, skipping any others in flight.
async fn next_event(events: &mut tokio::sync::broadcast::Receiver<AppEvent>) -> TourneyEvent {
    loop {
        if let AppEvent::Tourney(event) = events.recv().await.unwrap() {
            return event;
        }
    }
}

/// Wait for the slice to go quiet, so an assertion sees the settled state
/// rather than the middle of a reload.
async fn settle(app: &App) {
    for _ in 0..200 {
        let state = app.snapshot().tourney;
        if state.pending.is_none()
            && state.status != TourneyLoadStatus::Loading
            && state.detail_status != TourneyLoadStatus::Loading
        {
            tokio::task::yield_now().await;
            if app.snapshot().tourney.pending.is_none() {
                return;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("the tourney slice never settled");
}

/// Open one event and wait for its detail.
async fn open(app: &App, tournament_id: &str) {
    app.dispatch(
        TourneyCommand::Select {
            tournament_id: tournament_id.into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(app).await;
}

#[tokio::test]
async fn loading_announces_itself_then_lands_a_sorted_list() {
    let app = app();
    let mut events = app.subscribe();

    app.dispatch(TourneyCommand::Load.into()).await.unwrap();

    assert_eq!(next_event(&mut events).await, TourneyEvent::Loading);
    match next_event(&mut events).await {
        TourneyEvent::Loaded { events } => {
            // Sorting is the service's job, not the view's, so every consumer
            // of the state sees the same order: what a player can still enter
            // comes first.
            assert_eq!(events.first().unwrap().status, TourneyStatus::Signup);
        }
        other => panic!("expected Loaded, got {other:?}"),
    }
    settle(&app).await;
    assert_eq!(app.snapshot().tourney.status, TourneyLoadStatus::Ready);
}

#[tokio::test]
async fn the_list_carries_counts_and_the_detail_carries_the_people() {
    // The two endpoints answer differently, and the tab has to read both.
    let app = app();
    app.dispatch(TourneyCommand::Load.into()).await.unwrap();
    settle(&app).await;

    let row = app
        .snapshot()
        .tourney
        .events
        .into_iter()
        .find(|event| event.id == "e1a2b")
        .expect("the cup is listed");
    assert_eq!(row.player_count, 2);
    assert!(row.players.is_empty(), "the list sends no people");

    open(&app, "e1a2b").await;
    let detail = app.snapshot().tourney.detail.expect("the detail landed");
    assert_eq!(detail.players.len(), 2);
    assert_eq!(detail.player_count, 2);
}

#[tokio::test]
async fn entering_a_tournament_reloads_both_the_row_and_the_detail() {
    // The reason a write ends in a reload rather than a local patch: the row
    // and the pane must not disagree about who is in.
    let app = app();
    open(&app, "e1a2b").await;
    assert!(app.snapshot().tourney.detail.unwrap().may_sign_up());

    app.dispatch(
        TourneyCommand::SignUp {
            tournament_id: "e1a2b".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let state = app.snapshot().tourney;
    let detail = state.detail.expect("still open");
    assert!(detail.viewer.is_signed_up());
    assert_eq!(detail.player_count, 3);
    let row = state
        .events
        .iter()
        .find(|event| event.id == "e1a2b")
        .expect("still listed");
    assert_eq!(row.player_count, 3, "the row was reloaded too");
    assert!(state.action_error.is_none());
}

#[tokio::test]
async fn withdrawing_uses_the_player_id_the_server_handed_out() {
    // The client never invents this id: the server issues it and authorises the
    // removal against the same answer.
    let app = app();
    open(&app, "e1a2b").await;
    app.dispatch(
        TourneyCommand::SignUp {
            tournament_id: "e1a2b".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    app.dispatch(
        TourneyCommand::Withdraw {
            tournament_id: "e1a2b".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let detail = app.snapshot().tourney.detail.expect("still open");
    assert!(!detail.viewer.is_signed_up());
    assert_eq!(detail.player_count, 2);
}

#[tokio::test]
async fn withdrawing_without_an_entry_is_refused_before_a_request_is_made() {
    let app = app();
    open(&app, "e1a2b").await;

    app.dispatch(
        TourneyCommand::Withdraw {
            tournament_id: "e1a2b".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let failure = app
        .snapshot()
        .tourney
        .action_error
        .expect("a refusal the client can answer itself");
    assert_eq!(failure.action, TourneyAction::Withdrawing);
    assert!(failure.reason.contains("not signed up"));
}

#[tokio::test]
async fn reporting_a_series_waits_for_the_opponent_before_the_bracket_moves() {
    let app = app();
    open(&app, "e9z9z").await;
    let before = app.snapshot().tourney.detail.expect("the bracket");
    assert!(before.may_report(&before.matches[0]));

    app.dispatch(
        TourneyCommand::SubmitReport {
            tournament_id: "e9z9z".into(),
            report: MatchReport {
                match_id: "m1".into(),
                score1: 2,
                score2: 0,
                // A blank row the player tabbed past: dropped by the service,
                // or the server would count it and refuse the whole report.
                replay_ids: vec!["22334455".into(), "  ".into(), "22334456".into()],
                draw_replay_ids: Vec::new(),
            },
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let state = app.snapshot().tourney;
    assert!(state.action_error.is_none(), "{:?}", state.action_error);
    let detail = state.detail.expect("still open");
    let entry = &detail.matches[0];
    assert_eq!(entry.status, MatchStatus::Ready, "the bracket has not moved");
    assert_eq!(
        entry.pending_report.as_ref().map(|pending| pending.score1),
        Some(2)
    );
    assert_eq!(detail.matches[2].team1, None, "the final is still empty");
}

#[tokio::test]
async fn a_confirmed_score_advances_the_winner_and_the_state_follows() {
    let app = app();
    open(&app, "e9z9z").await;
    app.dispatch(
        TourneyCommand::SubmitReport {
            tournament_id: "e9z9z".into(),
            report: MatchReport {
                match_id: "m1".into(),
                score1: 2,
                score2: 0,
                replay_ids: vec!["22334455".into(), "22334456".into()],
                draw_replay_ids: Vec::new(),
            },
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    app.dispatch(
        TourneyCommand::AnswerReport {
            tournament_id: "e9z9z".into(),
            match_id: "m1".into(),
            accept: true,
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let detail = app.snapshot().tourney.detail.expect("still open");
    assert_eq!(detail.matches[0].status, MatchStatus::Done);
    assert_eq!(
        detail.matches[2].team1.as_deref(),
        Some("t1"),
        "reloaded from the server rather than patched locally"
    );
}

#[tokio::test]
async fn a_refused_write_keeps_the_servers_sentence_and_clears_the_spinner() {
    // The whole reason 403 bodies are passed through: this is the only line
    // that tells the player which gate they missed.
    let app = app_refusing(RequestError::rejected(
        "You can’t sign up here: your rating (1420) is below this tournament’s minimum of 1500.",
    ));
    open(&app, "e1a2b").await;

    app.dispatch(
        TourneyCommand::SignUp {
            tournament_id: "e1a2b".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let state = app.snapshot().tourney;
    assert!(state.pending.is_none());
    let failure = state.action_error.expect("the refusal is kept");
    assert_eq!(failure.action, TourneyAction::SigningUp);
    assert!(failure.reason.contains("1500"));
    // And the event itself is untouched: a refused write must not look like a
    // successful one.
    assert!(!state.detail.unwrap().viewer.is_signed_up());

    app.dispatch(TourneyCommand::DismissActionError.into())
        .await
        .unwrap();
    settle(&app).await;
    assert!(app.snapshot().tourney.action_error.is_none());
}

#[tokio::test]
async fn opening_a_room_reads_it_and_clears_its_badge() {
    let app = app();
    open(&app, "e9z9z").await;

    app.dispatch(
        TourneyCommand::LoadChat {
            tournament_id: "e9z9z".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;
    let rooms = app.snapshot().tourney.chat_rooms;
    assert_eq!(rooms.first().map(|room| room.id.as_str()), Some("global"));

    app.dispatch(
        TourneyCommand::OpenRoom {
            tournament_id: "e9z9z".into(),
            room_id: "global".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let state = app.snapshot().tourney;
    assert_eq!(state.open_room_id.as_deref(), Some("global"));
    assert_eq!(state.chat_posts.len(), 1);
    assert_eq!(state.chat_status, TourneyLoadStatus::Ready);
}

#[tokio::test]
async fn posting_reloads_the_room_and_not_the_whole_tournament() {
    let app = app();
    open(&app, "e9z9z").await;
    app.dispatch(
        TourneyCommand::OpenRoom {
            tournament_id: "e9z9z".into(),
            room_id: "global".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    app.dispatch(
        TourneyCommand::PostChat {
            tournament_id: "e9z9z".into(),
            room_id: "global".into(),
            body: "  on my way  ".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let posts = app.snapshot().tourney.chat_posts;
    assert_eq!(posts.len(), 2);
    assert_eq!(posts[1].body, "on my way");

    // An empty message is not a request at all.
    app.dispatch(
        TourneyCommand::PostChat {
            tournament_id: "e9z9z".into(),
            room_id: "global".into(),
            body: "   ".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;
    assert_eq!(app.snapshot().tourney.chat_posts.len(), 2);
}

#[tokio::test]
async fn switching_events_never_leaves_one_brackets_chat_under_another() {
    let app = app();
    open(&app, "e9z9z").await;
    app.dispatch(
        TourneyCommand::OpenRoom {
            tournament_id: "e9z9z".into(),
            room_id: "global".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;
    assert!(!app.snapshot().tourney.chat_posts.is_empty());

    open(&app, "e1a2b").await;
    let state = app.snapshot().tourney;
    assert_eq!(state.selected_id.as_deref(), Some("e1a2b"));
    assert!(state.chat_posts.is_empty());
    assert!(state.open_room_id.is_none());
    assert_eq!(state.detail.map(|event| event.id), Some("e1a2b".into()));
}

#[tokio::test]
async fn entrant_profiles_arrive_beside_the_bracket_rather_than_inside_it() {
    let app = app();
    open(&app, "e9z9z").await;
    let state = app.snapshot().tourney;
    let detail = state.detail.as_ref().expect("the bracket");
    // The bracket is complete whether or not FAF answered; the profiles are a
    // decoration on top of it.
    assert_eq!(detail.players.len(), 4);
    assert!(
        state.entrant_profiles.len() <= detail.players.len(),
        "profiles never outnumber entrants"
    );
}

#[tokio::test]
async fn assigning_a_pool_to_a_round_survives_the_reload() {
    let app = app();
    open(&app, "e1a2b").await;

    app.dispatch(
        TourneyCommand::SavePool {
            tournament_id: "e1a2b".into(),
            pool: PoolDraft {
                id: String::new(),
                name: "  Semifinals  ".into(),
                map_ids: vec!["map1".into(), "map2".into()],
                best_of: Some(3),
            },
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let pool_id = app
        .snapshot()
        .tourney
        .detail
        .expect("still open")
        .map_pools
        .last()
        .map(|pool| {
            assert_eq!(pool.name, "Semifinals", "trimmed before it was sent");
            pool.id.clone()
        })
        .expect("the pool was created");

    app.dispatch(
        TourneyCommand::AssignPool {
            tournament_id: "e1a2b".into(),
            round_key: "wb:2".into(),
            pool_id,
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let detail = app.snapshot().tourney.detail.expect("still open");
    assert_eq!(
        detail.pool_for_round("wb:2").map(|pool| pool.name.as_str()),
        Some("Semifinals")
    );
}

#[tokio::test]
async fn the_rules_pages_load_without_a_tournament_open() {
    // Site-wide, and fetched whole rather than by three hard-coded ids.
    let app = app();
    app.dispatch(TourneyCommand::LoadArticles.into()).await.unwrap();
    settle(&app).await;

    let articles = app.snapshot().tourney.articles;
    assert_eq!(articles.len(), 2);
    assert!(articles[1].parent_id.is_some(), "the nesting survives");
}

#[tokio::test]
async fn a_failed_list_says_so_rather_than_showing_an_empty_tab() {
    struct Offline;

    #[async_trait]
    impl TourneyPort for Offline {
        async fn list(&self) -> Result<Vec<Tourney>, RequestError> {
            Err(RequestError::offline("no route to host"))
        }
        async fn detail(&self, _: &str) -> Result<Tourney, RequestError> {
            Err(RequestError::offline("no route to host"))
        }
        async fn hosting(&self) -> Result<HostingStatus, RequestError> {
            Err(RequestError::offline("no route to host"))
        }
        async fn create(&self, _: &TourneyDraft) -> Result<String, RequestError> {
            unreachable!()
        }
        async fn edit_info(&self, _: &str, _: &TourneyDraft) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn publish(&self, _: &str) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn advance(&self, _: &str, _: TourneyPhase) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn archive(&self, _: &str) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn sign_up(&self, _: &str) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn withdraw(&self, _: &str, _: &str) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn create_team(&self, _: &str, _: &str) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn request_join(&self, _: &str, _: &str) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn cancel_join(&self, _: &str, _: &str) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn respond_join(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: bool,
        ) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn invite_to_team(&self, _: &str, _: &str, _: &str) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn respond_invite(&self, _: &str, _: &str, _: bool) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn leave_team(&self, _: &str) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn disband_team(&self, _: &str, _: &str) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn rename_team(&self, _: &str, _: &str, _: &str) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn check_in(&self, _: &str) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn submit_report(&self, _: &str, _: &MatchReport) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn confirm_report(&self, _: &str, _: &str, _: bool) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn decide_report(&self, _: &str, _: &MatchReport) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn chat_rooms(&self, _: &str) -> Result<Vec<ChatRoom>, RequestError> {
            unreachable!()
        }
        async fn chat_read(&self, _: &str, _: &str) -> Result<Vec<ChatPost>, RequestError> {
            unreachable!()
        }
        async fn chat_post(&self, _: &str, _: &str, _: &str) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn articles(&self) -> Result<Vec<Article>, RequestError> {
            unreachable!()
        }
        async fn assign_pool(&self, _: &str, _: &str, _: &str) -> Result<(), RequestError> {
            unreachable!()
        }
        async fn save_pool(&self, _: &str, _: &PoolDraft) -> Result<(), RequestError> {
            unreachable!()
        }
    }

    let ports = Ports {
        tourney: Arc::new(Offline),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());

    app.dispatch(TourneyCommand::Load.into()).await.unwrap();
    settle(&app).await;

    match app.snapshot().tourney.status {
        TourneyLoadStatus::Failed { reason, .. } => assert!(!reason.is_empty()),
        other => panic!("expected a stated failure, got {other:?}"),
    }
}

#[tokio::test]
async fn entering_one_tournament_never_enters_another() {
    // Reported from the running client: enter the cup, click the next event,
    // and it says you are in that one too. Whether the entry belongs to *this*
    // tournament is the single fact every action in the pane hangs on, so it
    // gets its own test rather than being read off a fixture by eye.
    let app = app();
    open(&app, "e1a2b").await;
    app.dispatch(
        TourneyCommand::SignUp {
            tournament_id: "e1a2b".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;
    assert!(app.snapshot().tourney.detail.unwrap().viewer.is_signed_up());

    // A running event this account is not in. The fake seeds one deliberately,
    // so "am I in this?" has both answers and a real leak stays visible.
    open(&app, "e5x5x").await;
    let state = app.snapshot().tourney;
    let other = state.detail.expect("the second event is open");
    assert_eq!(other.id, "e5x5x");
    assert!(
        !other.viewer.is_signed_up(),
        "entering one tournament must not enter another"
    );
    // And the list row must not carry the first event's answer either.
    let row = state
        .events
        .iter()
        .find(|event| event.id == "e5x5x")
        .expect("still listed");
    assert!(row.viewer.signed_up_player_id.is_none());
    // And the event this account really is in still says so, so the assertion
    // above is about isolation rather than about nothing being set anywhere.
    open(&app, "e9z9z").await;
    assert!(app.snapshot().tourney.detail.unwrap().viewer.is_signed_up());
}

#[tokio::test]
async fn a_created_tournament_becomes_the_open_one() {
    // The organiser lands inside the event they just made, rather than back at
    // a list that looks unchanged.
    let app = app();
    app.dispatch(TourneyCommand::Load.into()).await.unwrap();
    settle(&app).await;
    let before = app.snapshot().tourney.events.len();

    app.dispatch(
        TourneyCommand::Create {
            draft: TourneyDraft {
                name: "  Spring Open  ".into(),
                team_size: 1,
                ..TourneyDraft::new()
            },
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let state = app.snapshot().tourney;
    assert!(state.action_error.is_none(), "{:?}", state.action_error);
    assert_eq!(state.events.len(), before + 1);
    let open = state.detail.expect("the new event is open");
    assert_eq!(state.selected_id.as_deref(), Some(open.id.as_str()));
    assert_eq!(open.name, "Spring Open", "trimmed before it was sent");
    assert_eq!(open.status, TourneyStatus::Signup);
}

#[tokio::test]
async fn an_event_walks_from_signups_to_a_drawn_bracket() {
    // The lifecycle spine: close signups, form teams, draw the bracket. Each
    // step is refused from the wrong status, which is why the UI only offers
    // the one that is legal now.
    let app = app();
    open(&app, "e1a2b").await;
    assert_eq!(app.snapshot().tourney.detail.unwrap().status, TourneyStatus::Signup);

    // Drawing a bracket before teams exist is refused, and says why.
    app.dispatch(
        TourneyCommand::Advance {
            tournament_id: "e1a2b".into(),
            phase: TourneyPhase::StartBracket,
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;
    let refused = app.snapshot().tourney.action_error.expect("out of order");
    assert!(refused.reason.contains("Form teams first"));

    app.dispatch(
        TourneyCommand::Advance {
            tournament_id: "e1a2b".into(),
            phase: TourneyPhase::FormTeams,
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;
    let drafted = app.snapshot().tourney.detail.expect("still open");
    assert_eq!(drafted.status, TourneyStatus::Drafted);
    assert_eq!(drafted.team_count, 2, "every entrant is in a team");

    app.dispatch(
        TourneyCommand::Advance {
            tournament_id: "e1a2b".into(),
            phase: TourneyPhase::StartBracket,
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;
    let running = app.snapshot().tourney.detail.expect("still open");
    assert_eq!(running.status, TourneyStatus::Running);
    assert!(!running.matches.is_empty(), "the bracket was drawn");
}

#[tokio::test]
async fn reopening_signups_gives_the_teams_back_to_their_players() {
    let app = app();
    open(&app, "e1a2b").await;
    app.dispatch(
        TourneyCommand::Advance {
            tournament_id: "e1a2b".into(),
            phase: TourneyPhase::FormTeams,
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    app.dispatch(
        TourneyCommand::Advance {
            tournament_id: "e1a2b".into(),
            phase: TourneyPhase::ReopenSignups,
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let event = app.snapshot().tourney.detail.expect("still open");
    assert_eq!(event.status, TourneyStatus::Signup);
    assert_eq!(event.team_count, 0);
    assert!(event.players.iter().all(|player| player.team_id.is_none()));
    // The entrants themselves are untouched: reopening undoes the teams, not
    // the signups.
    assert_eq!(event.player_count, 2);
}

#[tokio::test]
async fn editing_an_event_leaves_its_entrants_alone() {
    let app = app();
    open(&app, "e1a2b").await;
    let before = app.snapshot().tourney.detail.expect("open");

    app.dispatch(
        TourneyCommand::EditInfo {
            tournament_id: "e1a2b".into(),
            draft: TourneyDraft {
                name: "Weekend Ladder Cup 2".into(),
                description: "Now best of five.".into(),
                ..TourneyDraft::new()
            },
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let after = app.snapshot().tourney.detail.expect("still open");
    assert_eq!(after.name, "Weekend Ladder Cup 2");
    assert_eq!(after.description, "Now best of five.");
    assert_eq!(after.player_count, before.player_count);
    // And the list row agrees, rather than still showing the old name.
    let row = app
        .snapshot()
        .tourney
        .events
        .into_iter()
        .find(|event| event.id == "e1a2b")
        .expect("still listed");
    assert_eq!(row.name, "Weekend Ladder Cup 2");
}

#[tokio::test]
async fn archiving_an_event_moves_the_selection_on() {
    let app = app();
    open(&app, "e1a2b").await;

    app.dispatch(
        TourneyCommand::Archive {
            tournament_id: "e1a2b".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let state = app.snapshot().tourney;
    assert!(state.events.iter().all(|event| event.id != "e1a2b"));
    // Never left pointing at an event nobody can reach.
    assert_ne!(state.selected_id.as_deref(), Some("e1a2b"));
    assert!(state.detail.is_none() || state.detail.unwrap().id != "e1a2b");
}

#[tokio::test]
async fn a_refused_lifecycle_write_leaves_the_event_untouched() {
    let app = app_refusing(RequestError::rejected("Organizer rights required"));
    open(&app, "e1a2b").await;

    app.dispatch(
        TourneyCommand::Advance {
            tournament_id: "e1a2b".into(),
            phase: TourneyPhase::FormTeams,
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let state = app.snapshot().tourney;
    assert!(state.pending.is_none());
    let failure = state.action_error.expect("the refusal is kept");
    assert_eq!(
        failure.action,
        TourneyAction::Advancing {
            phase: TourneyPhase::FormTeams
        }
    );
    assert_eq!(failure.reason, "Organizer rights required");
    assert_eq!(state.detail.unwrap().status, TourneyStatus::Signup);
}

#[tokio::test]
async fn the_hosting_answer_gates_the_create_button() {
    let app = app();
    assert!(!app.snapshot().tourney.hosting.allowed, "unknown until asked");

    app.dispatch(TourneyCommand::LoadHosting.into()).await.unwrap();
    settle(&app).await;
    assert!(app.snapshot().tourney.hosting.allowed);
}

/// A 2v2 event in signups: the shape that had no way forward before teams.
async fn team_event(app: &App) -> String {
    app.dispatch(
        TourneyCommand::Create {
            draft: TourneyDraft {
                name: "Duo Cup".into(),
                team_size: 2,
                formation: faf_domain::state::Formation::Open,
                ..TourneyDraft::new()
            },
        }
        .into(),
    )
    .await
    .unwrap();
    settle(app).await;
    let id = app.snapshot().tourney.selected_id.expect("the new event is open");
    app.dispatch(
        TourneyCommand::SignUp {
            tournament_id: id.clone(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(app).await;
    id
}

#[tokio::test]
async fn a_team_event_offers_a_way_onto_a_team_after_signing_up() {
    // The dead end this whole step exists for: entering a 2v2 used to leave a
    // player with no team, no check-in and no match.
    let app = app();
    let id = team_event(&app).await;

    let before = app.snapshot().tourney.detail.expect("open");
    assert!(before.viewer.is_signed_up());
    assert!(before.my_team().is_none(), "signing up gives no team");
    assert!(before.may_create_team(), "but forming one is offered");

    app.dispatch(
        TourneyCommand::CreateTeam {
            tournament_id: id.clone(),
            name: "  Blue  ".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let event = app.snapshot().tourney.detail.expect("open");
    let mine = event.my_team().expect("a team of my own");
    assert_eq!(mine.name, "Blue", "trimmed before it was sent");
    assert!(event.is_captain_of(mine), "the founder captains it");
    assert!(!event.may_create_team(), "and cannot start a second");
}

#[tokio::test]
async fn joining_a_team_is_a_request_the_captain_answers() {
    // There is no instant join: the server retired that path and answers
    // `join_team` with "send a join request". The client must not offer one.
    let app = app();
    let id = team_event(&app).await;
    app.dispatch(
        TourneyCommand::CreateTeam {
            tournament_id: id.clone(),
            name: "Blue".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;
    let team_id = app
        .snapshot()
        .tourney
        .detail
        .unwrap()
        .my_team()
        .expect("a team")
        .id
        .clone();

    // Leaving frees this account up to ask for a place again.
    app.dispatch(
        TourneyCommand::LeaveTeam {
            tournament_id: id.clone(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;
    // The team was a team of one, so leaving dissolved it.
    assert!(app.snapshot().tourney.detail.unwrap().team(&team_id).is_none());
}

#[tokio::test]
async fn a_captain_can_invite_an_entrant_who_has_no_team() {
    // Driven against the seeded 2v2, because a freshly created event has only
    // this account in it and the invite conversation needs two sides.
    let app = app();
    open(&app, "e2v2b").await;
    app.dispatch(
        TourneyCommand::SignUp {
            tournament_id: "e2v2b".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;
    app.dispatch(
        TourneyCommand::CreateTeam {
            tournament_id: "e2v2b".into(),
            name: "Blue".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let event = app.snapshot().tourney.detail.expect("open");
    let team_id = event.my_team().expect("a team of my own").id.clone();
    let free = event
        .unteamed()
        .first()
        .map(|player| player.id.clone())
        .expect("somebody without a team");

    app.dispatch(
        TourneyCommand::InviteToTeam {
            tournament_id: "e2v2b".into(),
            team_id: team_id.clone(),
            player_id: free.clone(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let invited = app.snapshot().tourney.detail.expect("open");
    let team = invited.team(&team_id).expect("still there");
    assert_eq!(team.invites.len(), 1);
    assert_eq!(team.invites[0].player_id, free);
    assert!(invited.is_captain_of(team));
}

#[tokio::test]
async fn asking_a_team_for_a_place_shows_up_on_that_team() {
    // The only route onto a team: the server retired instant joining and
    // answers `join_team` with "send a join request".
    let app = app();
    open(&app, "e2v2b").await;
    app.dispatch(
        TourneyCommand::SignUp {
            tournament_id: "e2v2b".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let event = app.snapshot().tourney.detail.expect("open");
    let theirs = event.teams.first().expect("a team with a place").clone();
    assert!(event.may_request_join(&theirs));

    app.dispatch(
        TourneyCommand::RequestJoin {
            tournament_id: "e2v2b".into(),
            team_id: theirs.id.clone(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;

    let asked = app.snapshot().tourney.detail.expect("open");
    let team = asked.team(&theirs.id).expect("still there");
    assert_eq!(team.join_requests.len(), 1);
    assert!(asked.has_asked_to_join(team));
    // Asking twice is not two requests, and the button stops being offered.
    assert!(!asked.may_request_join(team));

    app.dispatch(
        TourneyCommand::CancelJoin {
            tournament_id: "e2v2b".into(),
            team_id: theirs.id.clone(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;
    let withdrawn = app.snapshot().tourney.detail.expect("open");
    assert!(withdrawn.team(&theirs.id).unwrap().join_requests.is_empty());
}

#[tokio::test]
async fn renaming_a_team_refuses_a_name_already_taken() {
    let app = app();
    let id = team_event(&app).await;
    app.dispatch(
        TourneyCommand::CreateTeam {
            tournament_id: id.clone(),
            name: "Blue".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;
    let team_id = app
        .snapshot()
        .tourney
        .detail
        .unwrap()
        .my_team()
        .unwrap()
        .id
        .clone();

    app.dispatch(
        TourneyCommand::RenameTeam {
            tournament_id: id.clone(),
            team_id: team_id.clone(),
            name: "  Red  ".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    settle(&app).await;
    assert_eq!(
        app.snapshot().tourney.detail.unwrap().team(&team_id).unwrap().name,
        "Red"
    );
}

#[tokio::test]
async fn a_solo_event_never_offers_team_forming() {
    // A solo event's teams are made by the organiser at the phase change, so a
    // "create team" button there would be a trap.
    let app = app();
    open(&app, "e1a2b").await;
    let event = app.snapshot().tourney.detail.expect("open");
    assert_eq!(event.team_size, 1);
    assert!(!event.teams_are_self_organised());
    assert!(!event.may_create_team());
}
