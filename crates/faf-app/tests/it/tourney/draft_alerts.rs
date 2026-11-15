use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{RequestError, TourneySitePort};
use faf_app::{App, Ports};
use faf_domain::state::settings::NotificationPreferencesPatch;
use faf_domain::state::{
    Article, AuthCommand, HostingStatus, NotificationAction, NotificationCommand, NotificationKind,
    PendingItem, PendingSummary, SettingsCommand, SiteDocument, SiteRead, SiteWrite, TourneyPhase,
};
use tokio::sync::Semaphore;

use crate::support;

struct DraftSite {
    inner: Arc<dyn TourneySitePort>,
    calls: AtomicUsize,
    fail: AtomicBool,
    gate: Mutex<Option<Arc<Semaphore>>>,
}

#[async_trait]
impl TourneySitePort for DraftSite {
    async fn hosting(&self) -> Result<HostingStatus, RequestError> {
        self.inner.hosting().await
    }
    async fn profile(&self) -> Result<String, RequestError> {
        self.inner.profile().await
    }
    async fn set_discord(&self, handle: &str) -> Result<String, RequestError> {
        self.inner.set_discord(handle).await
    }
    async fn articles(&self) -> Result<Vec<Article>, RequestError> {
        self.inner.articles().await
    }
    async fn site_write(
        &self,
        write: &SiteWrite,
    ) -> Result<(Option<String>, Option<String>), RequestError> {
        self.inner.site_write(write).await
    }
    async fn site_read(&self, read: SiteRead) -> Result<SiteDocument, RequestError> {
        if read != SiteRead::Pending {
            return self.inner.site_read(read).await;
        }
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.fail.load(Ordering::SeqCst) {
            return Err(RequestError::unexpected("temporary tournament failure"));
        }
        let gate = self.gate.lock().unwrap().take();
        if let Some(gate) = gate {
            gate.acquire().await.unwrap().forget();
        }
        Ok(SiteDocument::Pending(PendingSummary {
            items: vec![PendingItem {
                tournament_id: "d3d3d".into(),
                kind: "draft".into(),
                ..Default::default()
            }],
            ..Default::default()
        }))
    }
}

async fn ports() -> (Ports, Arc<DraftSite>) {
    let ports = fake_ports();
    ports.tourney_entry.sign_up("d3d3d", None).await.unwrap();
    let mine = ports
        .tourney_read
        .detail("d3d3d")
        .await
        .unwrap()
        .viewer
        .signed_up_player_id
        .unwrap();
    ports
        .tourney_entry
        .set_captains("d3d3d", &[mine, "c2".into()])
        .await
        .unwrap();
    ports
        .tourney_match
        .advance("d3d3d", TourneyPhase::StartDraft, None)
        .await
        .unwrap();
    let site = Arc::new(DraftSite {
        inner: ports.tourney_site.clone(),
        calls: AtomicUsize::new(0),
        fail: AtomicBool::new(false),
        gate: Mutex::new(None),
    });
    (
        Ports {
            tourney_site: site.clone(),
            ..ports
        },
        site,
    )
}

async fn enable(app: &App, value: bool) {
    app.dispatch_and_wait(
        SettingsCommand::PatchNotifications {
            patch: Box::new(NotificationPreferencesPatch {
                draft_turn: Some(value),
                ..Default::default()
            }),
        }
        .into(),
    )
    .await
    .unwrap();
}

fn count(app: &App) -> usize {
    app.with_state(|state| {
        state
            .notifications
            .items
            .iter()
            .filter(|item| item.kind == NotificationKind::DraftTurn)
            .count()
    })
}

async fn next_poll(site: &DraftSite) {
    let before = site.calls.load(Ordering::SeqCst);
    tokio::time::advance(Duration::from_secs(5)).await;
    support::eventually("the next draft poll", || {
        site.calls.load(Ordering::SeqCst) > before
    })
    .await;
    tokio::task::yield_now().await;
}

#[tokio::test(start_paused = true)]
async fn draft_alerts_are_opt_in_and_survive_leaving_the_tournament_view() {
    let (ports, site) = ports().await;
    let entry = ports.tourney_entry.clone();
    let app = support::start(ports);
    super::sign_in(&app).await;
    tokio::time::advance(Duration::from_secs(15)).await;
    assert_eq!(
        site.calls.load(Ordering::SeqCst),
        0,
        "disabled alerts must not poll the service"
    );
    enable(&app, true).await;
    support::until(&app, "the captain's draft alert", |state| {
        state
            .notifications
            .items
            .iter()
            .any(|item| item.kind == NotificationKind::DraftTurn)
    })
    .await;
    let first = app.with_state(|state| {
        state
            .notifications
            .items
            .iter()
            .find(|item| item.kind == NotificationKind::DraftTurn)
            .unwrap()
            .clone()
    });
    assert_eq!(
        first.action,
        Some(NotificationAction::OpenTournamentDraft {
            tournament_id: "d3d3d".into()
        })
    );
    assert!(
        app.with_state(|state| state.tourney.detail.is_none()),
        "alerts work without opening Tournaments"
    );
    next_poll(&site).await;
    assert_eq!(count(&app), 1, "the same turn must not notify twice");

    entry.draft_pick("d3d3d", "f1").await.unwrap();
    next_poll(&site).await;
    assert_eq!(
        count(&app),
        0,
        "the old alert must leave popup queues when the turn advances"
    );
    entry.draft_undo("d3d3d").await.unwrap();
    next_poll(&site).await;
    assert_eq!(count(&app), 1, "regaining a turn is a new alert");
    assert!(app.with_state(|state| state
        .notifications
        .items
        .iter()
        .all(|item| item.id != first.id)));
    enable(&app, false).await;
    support::until(&app, "disabled draft alerts cleared", |state| {
        state
            .notifications
            .items
            .iter()
            .all(|item| item.kind != NotificationKind::DraftTurn)
    })
    .await;
    let before = site.calls.load(Ordering::SeqCst);
    tokio::time::advance(Duration::from_secs(15)).await;
    assert_eq!(site.calls.load(Ordering::SeqCst), before);
}

#[tokio::test(start_paused = true)]
async fn clearing_a_draft_alert_and_a_failed_poll_do_not_announce_the_same_turn_again() {
    let (ports, site) = ports().await;
    let app = support::start(ports);
    super::sign_in(&app).await;
    enable(&app, true).await;
    support::until(&app, "the first draft alert", |state| {
        state
            .notifications
            .items
            .iter()
            .any(|item| item.kind == NotificationKind::DraftTurn)
    })
    .await;
    app.dispatch_and_wait(NotificationCommand::Clear.into())
        .await
        .unwrap();
    site.fail.store(true, Ordering::SeqCst);
    next_poll(&site).await;
    assert_eq!(count(&app), 0);
    site.fail.store(false, Ordering::SeqCst);
    next_poll(&site).await;
    assert_eq!(count(&app), 0, "recovery must remember the cleared turn");
}

#[tokio::test(start_paused = true)]
async fn an_organiser_is_not_notified_for_another_captains_pick() {
    let (ports, site) = ports().await;
    ports.tourney_entry.draft_pick("d3d3d", "f1").await.unwrap();
    assert!(ports.tourney_read.detail("d3d3d").await.unwrap().may_pick());
    let app = support::start(ports);
    super::sign_in(&app).await;
    enable(&app, true).await;
    next_poll(&site).await;
    assert_eq!(count(&app), 0);
}

#[tokio::test(start_paused = true)]
async fn signing_out_discards_an_in_flight_draft_check() {
    let (ports, site) = ports().await;
    let gate = Arc::new(Semaphore::new(0));
    *site.gate.lock().unwrap() = Some(gate.clone());
    let app = support::start(ports);
    super::sign_in(&app).await;
    enable(&app, true).await;
    support::eventually("the held draft read", || {
        site.calls.load(Ordering::SeqCst) > 0
    })
    .await;
    app.dispatch_and_wait(AuthCommand::Logout.into())
        .await
        .unwrap();
    gate.add_permits(1);
    tokio::time::advance(Duration::from_secs(15)).await;
    assert_eq!(count(&app), 0);
}

#[tokio::test(start_paused = true)]
async fn disabling_draft_alerts_discards_an_in_flight_check() {
    let (ports, site) = ports().await;
    let gate = Arc::new(Semaphore::new(0));
    *site.gate.lock().unwrap() = Some(gate.clone());
    let app = support::start(ports);
    super::sign_in(&app).await;
    enable(&app, true).await;
    support::eventually("the held draft read", || {
        site.calls.load(Ordering::SeqCst) > 0
    })
    .await;
    enable(&app, false).await;
    gate.add_permits(1);
    tokio::time::advance(Duration::from_secs(15)).await;
    assert_eq!(count(&app), 0);
}
