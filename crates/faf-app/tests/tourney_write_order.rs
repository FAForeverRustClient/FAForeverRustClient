//! Tournament writes run one at a time, whichever writes they are.
//!
//! Every tournament write ends by reloading the event, and the server
//! recomputes the bracket on each one, so two writes in flight together are
//! answered against a bracket the other has already moved. The command policy
//! serialises them under one key. Sixty-odd of them once lost that because the
//! table named only the few that reached the lock-holding helper directly; this
//! pins two different ones.
//!
//! Both writes under test are on the match port, so that is the one port
//! wrapped below: everything delegates to `FakeTourney`, except that
//! confirming a report waits at a gate the test opens, and both writes say
//! when they start and finish. The other tournament ports are the offline
//! fake's.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakeTourney};
use faf_app::ports::{RequestError, TourneyMatchPort};
use faf_app::{App, Ports};
use faf_domain::state::{BracketConfig, FfaReport, MatchReport, TourneyPhase, TourneyWrite};
use tokio::sync::Notify;

struct GatedTourney {
    inner: FakeTourney,
    log: Arc<Mutex<Vec<&'static str>>>,
    gate: Arc<Notify>,
}

#[async_trait]
impl TourneyMatchPort for GatedTourney {
    async fn advance(
        &self,
        tournament_id: &str,
        phase: TourneyPhase,
        config: Option<&BracketConfig>,
    ) -> Result<(), RequestError> {
        self.log.lock().unwrap().push("advance started");
        let answer = self.inner.advance(tournament_id, phase, config).await;
        self.log.lock().unwrap().push("advance finished");
        answer
    }

    async fn confirm_report(
        &self,
        tournament_id: &str,
        match_id: &str,
        accept: bool,
    ) -> Result<(), RequestError> {
        self.log.lock().unwrap().push("confirm started");
        self.gate.notified().await;
        let answer = self
            .inner
            .confirm_report(tournament_id, match_id, accept)
            .await;
        self.log.lock().unwrap().push("confirm finished");
        answer
    }

    async fn decide_report(
        &self,
        tournament_id: &str,
        report: &MatchReport,
    ) -> Result<(), RequestError> {
        self.inner.decide_report(tournament_id, report).await
    }

    async fn submit_report(
        &self,
        tournament_id: &str,
        report: &MatchReport,
    ) -> Result<(), RequestError> {
        self.inner.submit_report(tournament_id, report).await
    }

    async fn report_ffa(
        &self,
        tournament_id: &str,
        report: &FfaReport,
    ) -> Result<(), RequestError> {
        self.inner.report_ffa(tournament_id, report).await
    }
}

async fn until(log: &Mutex<Vec<&'static str>>, entry: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !log.lock().unwrap().contains(&entry) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("never saw {entry}"));
}

#[tokio::test]
async fn a_second_tournament_write_waits_for_the_first_whatever_it_is() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let gate = Arc::new(Notify::new());
    let ports = Ports {
        tourney_match: Arc::new(GatedTourney {
            inner: FakeTourney::new(),
            log: log.clone(),
            gate: gate.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());

    // A player confirms a report, and the confirmation is still with the
    // server when the organiser moves the event on.
    app.dispatch(
        TourneyWrite::AnswerReport {
            tournament_id: "t1".into(),
            match_id: "m1".into(),
            accept: true,
        }
        .into(),
    )
    .await
    .unwrap();
    until(&log, "confirm started").await;
    app.dispatch(
        TourneyWrite::Advance {
            tournament_id: "t1".into(),
            phase: TourneyPhase::FormTeams,
            config: None,
        }
        .into(),
    )
    .await
    .unwrap();

    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !log.lock().unwrap().contains(&"advance started"),
        "the second write reached the server while the first was still there: {:?}",
        log.lock().unwrap()
    );

    gate.notify_one();
    until(&log, "advance finished").await;
    assert_eq!(
        *log.lock().unwrap(),
        vec![
            "confirm started",
            "confirm finished",
            "advance started",
            "advance finished"
        ]
    );
}
