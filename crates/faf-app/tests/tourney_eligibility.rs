//! The entry-eligibility notice belongs to the event it was asked about.
//!
//! A check is a network round trip, and the reader can open another event in
//! the meantime. Selecting the other event clears the notice; an answer for the
//! event just left, verdict or refusal, must not then fill it in again.
//!
//! The same holds for the other one-owner reads of the tab: an entrant's
//! ratings table and the create form's template. A newer request, or moving to
//! another event, takes them over, and the answer it overtook is dropped.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakeTourney};
use faf_app::ports::{RequestError, TourneyReadPort};
use faf_app::{App, Ports};
use faf_domain::state::{
    CopySource, EntrantRatings, RatingCheck, RenameCheck, SeriesDetail, Tourney, TourneyLoadStatus,
    TourneyPreset, TourneyRead, TourneySeries,
};
use tokio::sync::Semaphore;

/// One held-open eligibility check.
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

/// The offline tournament service, except that each eligibility check waits
/// for the test to let it answer, and answers with a refusal when `refuse` is
/// set.
///
/// An entrant's ratings and an event's detail answer at once unless the test
/// holds their key (then they wait at that key's gate too), and with a refusal
/// when it refuses the key. They are opt-in because `Select` reads the detail
/// as well, and a test that held every detail could never open an event.
struct GatedTourney {
    inner: FakeTourney,
    gates: Mutex<HashMap<String, Arc<Gate>>>,
    refuse: bool,
    held: Mutex<HashSet<String>>,
    refused: Mutex<HashSet<String>>,
}

fn gated(refuse: bool) -> Arc<GatedTourney> {
    Arc::new(GatedTourney {
        inner: FakeTourney::default(),
        gates: Mutex::new(HashMap::new()),
        refuse,
        held: Mutex::new(HashSet::new()),
        refused: Mutex::new(HashSet::new()),
    })
}

/// The gate key of one entrant ratings read.
fn ratings_key(tournament_id: &str, player_id: &str) -> String {
    format!("ratings:{tournament_id}:{player_id}")
}

/// The gate key of one detail read.
fn detail_key(tournament_id: &str) -> String {
    format!("detail:{tournament_id}")
}

impl GatedTourney {
    /// Hold the next read of `key` until the test opens its gate, and answer
    /// it with a refusal when `refuse` is set.
    fn hold(&self, key: &str, refuse: bool) {
        self.held
            .lock()
            .expect("held poisoned")
            .insert(key.to_string());
        if refuse {
            self.refused
                .lock()
                .expect("refused poisoned")
                .insert(key.to_string());
        }
    }

    /// Wait at `key`'s gate if the test holds it, then say whether to refuse.
    async fn pass(&self, key: &str) -> bool {
        let held = self.held.lock().expect("held poisoned").contains(key);
        if held {
            let gate = self.gate(key);
            gate.entered.store(true, Ordering::SeqCst);
            gate.open.acquire().await.expect("gate closed").forget();
        }
        self.refused.lock().expect("refused poisoned").contains(key)
    }

    fn gate(&self, tournament_id: &str) -> Arc<Gate> {
        self.gates
            .lock()
            .expect("gates poisoned")
            .entry(tournament_id.to_string())
            .or_default()
            .clone()
    }
}

#[async_trait]
impl TourneyReadPort for GatedTourney {
    async fn check_rating(&self, tournament_id: &str) -> Result<RatingCheck, RequestError> {
        let gate = self.gate(tournament_id);
        gate.entered.store(true, Ordering::SeqCst);
        gate.open.acquire().await.expect("gate closed").forget();
        if self.refuse {
            return Err(RequestError::rejected(
                "Checking your rating needs your FAF login.",
            ));
        }
        Ok(RatingCheck {
            rated: true,
            eligible: Some(true),
            ..RatingCheck::default()
        })
    }

    // Everything else is the ordinary offline service.
    fn asset_base(&self) -> String {
        self.inner.asset_base()
    }

    async fn list(&self) -> Result<Vec<Tourney>, RequestError> {
        self.inner.list().await
    }

    async fn detail(&self, tournament_id: &str) -> Result<Tourney, RequestError> {
        if self.pass(&detail_key(tournament_id)).await {
            return Err(RequestError::rejected("That tournament is private."));
        }
        self.inner.detail(tournament_id).await
    }

    async fn player_ratings(
        &self,
        tournament_id: &str,
        player_id: &str,
        refresh: bool,
    ) -> Result<EntrantRatings, RequestError> {
        // The offline service has no ratings to give, so the answer is made
        // here, naming the entrant and the event it was asked for.
        if self.pass(&ratings_key(tournament_id, player_id)).await {
            return Err(RequestError::rejected("FAF could not be reached just now."));
        }
        Ok(EntrantRatings {
            player_id: player_id.to_string(),
            name: format!("{tournament_id}/{refresh}"),
            ..EntrantRatings::default()
        })
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

async fn wait_entered(port: &GatedTourney, key: &str) {
    let gate = port.gate(key);
    for _ in 0..400 {
        if gate.entered.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("no request for {key} arrived");
}

/// The app over `port`, its loop running.
fn start(port: &Arc<GatedTourney>) -> Arc<App> {
    let (app, app_loop) = App::new(
        "test",
        Ports {
            tourney_read: port.clone(),
            ..fake_ports()
        },
    );
    tokio::spawn(app_loop.run());
    Arc::new(app)
}

/// Dispatch without waiting here, for a request the test holds open.
fn in_background(app: &Arc<App>, command: TourneyRead) -> tokio::task::JoinHandle<()> {
    let app = app.clone();
    tokio::spawn(async move {
        app.dispatch_and_wait(command.into()).await.unwrap();
    })
}

/// Open event A, ask about it, move to event B, then let A's answer arrive.
async fn answer_after_moving_on(refuse: bool) {
    let port = gated(refuse);
    let app = start(&port);

    app.dispatch_and_wait(TourneyRead::Load.into())
        .await
        .unwrap();
    let events = app.snapshot().tourney.events;
    let (left, opened) = (events[0].id.clone(), events[1].id.clone());

    app.dispatch_and_wait(
        TourneyRead::Select {
            tournament_id: left.clone(),
        }
        .into(),
    )
    .await
    .unwrap();
    let check = {
        let app = app.clone();
        let tournament_id = left.clone();
        tokio::spawn(async move {
            app.dispatch_and_wait(TourneyRead::CheckRating { tournament_id }.into())
                .await
                .unwrap();
        })
    };
    wait_entered(&port, &left).await;
    assert_eq!(
        app.snapshot().tourney.rating_check_status,
        TourneyLoadStatus::Loading
    );

    app.dispatch_and_wait(
        TourneyRead::Select {
            tournament_id: opened.clone(),
        }
        .into(),
    )
    .await
    .unwrap();
    port.gate(&left).open.add_permits(1);
    check.await.unwrap();

    let tourney = app.snapshot().tourney;
    assert_eq!(tourney.selected_id.as_deref(), Some(opened.as_str()));
    assert_eq!(
        tourney.rating_check, None,
        "a verdict about {left} landed on {opened}"
    );
    assert_eq!(tourney.rating_check_status, TourneyLoadStatus::Idle);
}

#[tokio::test]
async fn a_late_eligibility_verdict_does_not_land_on_the_next_event() {
    answer_after_moving_on(false).await;
}

#[tokio::test]
async fn a_late_eligibility_refusal_does_not_land_on_the_next_event() {
    answer_after_moving_on(true).await;
}

/// Re-selecting the event already open is not moving on: its check still
/// answers, or the notice would be left loading for good.
#[tokio::test]
async fn reselecting_the_open_event_keeps_its_check() {
    let port = gated(false);
    let app = start(&port);

    app.dispatch_and_wait(TourneyRead::Load.into())
        .await
        .unwrap();
    let open = app.snapshot().tourney.events[0].id.clone();
    let select = || -> faf_domain::AppCommand {
        TourneyRead::Select {
            tournament_id: open.clone(),
        }
        .into()
    };
    app.dispatch_and_wait(select()).await.unwrap();
    let check = {
        let app = app.clone();
        let tournament_id = open.clone();
        tokio::spawn(async move {
            app.dispatch_and_wait(TourneyRead::CheckRating { tournament_id }.into())
                .await
                .unwrap();
        })
    };
    wait_entered(&port, &open).await;
    app.dispatch_and_wait(select()).await.unwrap();
    port.gate(&open).open.add_permits(1);
    check.await.unwrap();

    let tourney = app.snapshot().tourney;
    assert_eq!(tourney.rating_check_status, TourneyLoadStatus::Ready);
    assert_eq!(
        tourney.rating_check.and_then(|check| check.eligible),
        Some(true)
    );
}

/// The list loaded and its first two events, A and B.
async fn two_events(app: &Arc<App>) -> (String, String) {
    app.dispatch_and_wait(TourneyRead::Load.into())
        .await
        .unwrap();
    let events = app.snapshot().tourney.events;
    (events[0].id.clone(), events[1].id.clone())
}

fn select(app: &Arc<App>, tournament_id: &str) -> impl std::future::Future<Output = ()> {
    let app = app.clone();
    let tournament_id = tournament_id.to_string();
    async move {
        app.dispatch_and_wait(TourneyRead::Select { tournament_id }.into())
            .await
            .unwrap();
    }
}

fn ratings_of(tournament_id: &str, player_id: &str) -> TourneyRead {
    TourneyRead::LoadPlayerRatings {
        tournament_id: tournament_id.to_string(),
        player_id: player_id.to_string(),
        refresh: false,
    }
}

/// Ask for entrant p1's ratings, then p2's while p1's is still out, then let
/// p1's answer arrive last.
async fn ratings_overtaken(refuse_first: bool) {
    let port = gated(false);
    let app = start(&port);
    let (open, _) = two_events(&app).await;
    select(&app, &open).await;
    let held = ratings_key(&open, "p1");
    port.hold(&held, refuse_first);

    let older = in_background(&app, ratings_of(&open, "p1"));
    wait_entered(&port, &held).await;
    app.dispatch_and_wait(ratings_of(&open, "p2").into())
        .await
        .unwrap();
    port.gate(&held).open.add_permits(1);
    older.await.unwrap();

    let tourney = app.snapshot().tourney;
    assert_eq!(tourney.player_ratings_status, TourneyLoadStatus::Ready);
    assert_eq!(
        tourney.player_ratings.map(|ratings| ratings.player_id),
        Some("p2".to_string()),
        "the answer for p1 overwrote the one for p2"
    );
}

#[tokio::test]
async fn a_late_ratings_table_does_not_replace_the_newer_one() {
    ratings_overtaken(false).await;
}

#[tokio::test]
async fn a_late_ratings_refusal_does_not_replace_the_newer_table() {
    ratings_overtaken(true).await;
}

/// Ask for an entrant's ratings in event A, move to event B, then let the
/// answer arrive.
async fn ratings_after_moving_on(refuse: bool) {
    let port = gated(false);
    let app = start(&port);
    let (left, opened) = two_events(&app).await;
    select(&app, &left).await;
    let held = ratings_key(&left, "p1");
    port.hold(&held, refuse);

    let late = in_background(&app, ratings_of(&left, "p1"));
    wait_entered(&port, &held).await;
    assert_eq!(
        app.snapshot().tourney.player_ratings_status,
        TourneyLoadStatus::Loading
    );
    select(&app, &opened).await;
    port.gate(&held).open.add_permits(1);
    late.await.unwrap();

    let tourney = app.snapshot().tourney;
    assert_eq!(tourney.selected_id.as_deref(), Some(opened.as_str()));
    assert_eq!(
        tourney.player_ratings, None,
        "ratings asked in {left} landed on {opened}"
    );
    assert_eq!(tourney.player_ratings_status, TourneyLoadStatus::Idle);
}

#[tokio::test]
async fn a_late_ratings_table_does_not_land_on_the_next_event() {
    ratings_after_moving_on(false).await;
}

#[tokio::test]
async fn a_late_ratings_refusal_does_not_land_on_the_next_event() {
    ratings_after_moving_on(true).await;
}

/// Ask for template A, then template B while A is still out, then let A's
/// answer arrive last.
async fn template_overtaken(refuse_first: bool) {
    let port = gated(false);
    let app = start(&port);
    let (first, second) = two_events(&app).await;
    let held = detail_key(&first);
    port.hold(&held, refuse_first);

    let older = in_background(
        &app,
        TourneyRead::LoadTemplate {
            tournament_id: first.clone(),
        },
    );
    wait_entered(&port, &held).await;
    app.dispatch_and_wait(
        TourneyRead::LoadTemplate {
            tournament_id: second.clone(),
        }
        .into(),
    )
    .await
    .unwrap();
    port.gate(&held).open.add_permits(1);
    older.await.unwrap();

    let tourney = app.snapshot().tourney;
    assert_eq!(tourney.template_status, TourneyLoadStatus::Ready);
    assert_eq!(
        tourney.template.map(|template| template.id),
        Some(second.clone()),
        "the answer for {first} replaced the one for {second}"
    );
}

#[tokio::test]
async fn a_late_template_does_not_replace_the_newer_one() {
    template_overtaken(false).await;
}

#[tokio::test]
async fn a_late_template_refusal_does_not_replace_the_newer_template() {
    template_overtaken(true).await;
}
