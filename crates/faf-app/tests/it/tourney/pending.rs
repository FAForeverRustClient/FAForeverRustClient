use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{RequestError, TourneySitePort};
use faf_app::Ports;
use faf_domain::state::{
    Article, HostingStatus, PendingItem, PendingSummary, SiteDocument, SiteRead, SiteWrite,
    TourneyPhase, TourneyRead, TourneyWrite,
};
use tokio::sync::Semaphore;

use crate::support;

struct PendingReply {
    result: Result<PendingSummary, RequestError>,
    gate: Option<Arc<Semaphore>>,
}

struct PendingSite {
    inner: Arc<dyn TourneySitePort>,
    replies: Mutex<VecDeque<PendingReply>>,
    entered: Semaphore,
}

#[async_trait]
impl TourneySitePort for PendingSite {
    async fn hosting(&self) -> Result<HostingStatus, RequestError> {
        self.inner.hosting().await
    }

    async fn profile(&self) -> Result<String, RequestError> {
        self.inner.profile().await
    }

    async fn set_discord(&self, handle: &str) -> Result<String, RequestError> {
        self.inner.set_discord(handle).await
    }

    async fn site_read(&self, read: SiteRead) -> Result<SiteDocument, RequestError> {
        if read != SiteRead::Pending {
            return self.inner.site_read(read).await;
        }
        let reply = self
            .replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("pending reply");
        self.entered.add_permits(1);
        if let Some(gate) = reply.gate {
            gate.acquire().await.unwrap().forget();
        }
        reply.result.map(SiteDocument::Pending)
    }

    async fn site_write(
        &self,
        write: &SiteWrite,
    ) -> Result<(Option<String>, Option<String>), RequestError> {
        self.inner.site_write(write).await
    }

    async fn articles(&self) -> Result<Vec<Article>, RequestError> {
        self.inner.articles().await
    }
}

fn summary() -> PendingSummary {
    PendingSummary {
        items: vec![PendingItem {
            tournament_id: "d3d3d".into(),
            kind: "draft".into(),
            ..PendingItem::default()
        }],
        requests: Some(2),
        ..PendingSummary::default()
    }
}

fn reply(result: Result<PendingSummary, RequestError>) -> PendingReply {
    PendingReply { result, gate: None }
}

fn pending_read() -> TourneyRead {
    TourneyRead::LoadSite {
        read: SiteRead::Pending,
    }
}

async fn draft_ports() -> Ports {
    let ports = fake_ports();
    // Sign up through the fake's session so its viewer identifies a real
    // entrant, then make that entrant the first captain.
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
    ports
}

#[tokio::test]
async fn pending_turns_clear_on_read_failure_and_refresh_immediately_after_a_pick() {
    let base = draft_ports().await;
    let site = Arc::new(PendingSite {
        inner: base.tourney_site.clone(),
        replies: Mutex::new(VecDeque::from([
            reply(Ok(summary())),
            reply(Err(RequestError::offline("offline"))),
            reply(Ok(summary())),
            reply(Ok(summary())),
        ])),
        entered: Semaphore::new(0),
    });
    let app = support::start(Ports {
        tourney_site: site,
        ..base
    });
    super::sign_in(&app).await;
    app.dispatch_and_wait(
        TourneyRead::Select {
            tournament_id: "d3d3d".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    app.dispatch_and_wait(pending_read().into()).await.unwrap();
    assert_eq!(app.snapshot().tourney.site.pending, summary());

    app.dispatch_and_wait(pending_read().into()).await.unwrap();
    assert!(app.snapshot().tourney.site.pending.items.is_empty());
    assert_eq!(app.snapshot().tourney.site.pending.requests, Some(2));

    app.dispatch_and_wait(pending_read().into()).await.unwrap();
    assert_eq!(app.snapshot().tourney.site.pending.items.len(), 1);
    app.dispatch_and_wait(
        TourneyWrite::DraftPickPlayer {
            tournament_id: "d3d3d".into(),
            player_id: "f1".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    assert!(
        app.snapshot().tourney.site.pending.items.is_empty(),
        "the pending endpoint still claims our turn, but the draft has moved on"
    );
    assert_eq!(app.snapshot().tourney.site.pending.requests, Some(2));
}

#[tokio::test]
async fn an_older_pending_poll_cannot_restore_a_cleared_draft_alert() {
    let base = draft_ports().await;
    let gate = Arc::new(Semaphore::new(0));
    let site = Arc::new(PendingSite {
        inner: base.tourney_site.clone(),
        replies: Mutex::new(VecDeque::from([
            PendingReply {
                result: Ok(summary()),
                gate: Some(gate.clone()),
            },
            reply(Ok(PendingSummary::default())),
        ])),
        entered: Semaphore::new(0),
    });
    let app = Arc::new(support::start(Ports {
        tourney_site: site.clone(),
        ..base
    }));
    super::sign_in(&app).await;
    let first = {
        let app = app.clone();
        tokio::spawn(async move {
            app.dispatch_and_wait(pending_read().into()).await.unwrap();
        })
    };
    tokio::time::timeout(support::PATIENCE, site.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    app.dispatch_and_wait(pending_read().into()).await.unwrap();
    assert_eq!(
        app.snapshot().tourney.site.pending,
        PendingSummary::default()
    );

    gate.add_permits(1);
    tokio::time::timeout(support::PATIENCE, first)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        app.snapshot().tourney.site.pending,
        PendingSummary::default(),
        "an older pending response must not put the alert back"
    );
}

#[tokio::test]
async fn unavailable_and_finished_drafts_preserve_unrelated_pending_items() {
    let base = draft_ports().await;
    let other = PendingItem {
        tournament_id: "another".into(),
        kind: "checkin".into(),
        ..PendingItem::default()
    };
    let mut mixed = summary();
    mixed.items.push(other.clone());
    mixed.items.push(PendingItem {
        tournament_id: "missing".into(),
        kind: "draft".into(),
        ..PendingItem::default()
    });
    let site = Arc::new(PendingSite {
        inner: base.tourney_site.clone(),
        replies: Mutex::new(VecDeque::from([reply(Ok(mixed.clone())), reply(Ok(mixed))])),
        entered: Semaphore::new(0),
    });
    let entry = base.tourney_entry.clone();
    let app = support::start(Ports {
        tourney_site: site,
        ..base
    });
    super::sign_in(&app).await;
    app.dispatch_and_wait(pending_read().into()).await.unwrap();
    assert_eq!(
        app.snapshot().tourney.site.pending.items,
        vec![summary().items.remove(0), other.clone()]
    );

    entry.draft_pick("d3d3d", "f1").await.unwrap();
    entry.draft_pick("d3d3d", "f2").await.unwrap();
    app.dispatch_and_wait(pending_read().into()).await.unwrap();
    assert_eq!(
        app.snapshot().tourney.site.pending,
        PendingSummary {
            items: vec![other],
            ..summary()
        }
    );
}
