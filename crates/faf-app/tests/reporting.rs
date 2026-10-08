use faf_app::infra::fake_ports;
use faf_app::App;
use faf_domain::state::{AuthCommand, NotificationEvent, ReportingCommand, ReportingEvent};
use faf_domain::AppEvent;

#[tokio::test]
async fn report_submission_emits_progress_confirmation_and_notification() {
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();

    app.dispatch(AuthCommand::LoginTest.into()).await.unwrap();
    let _ = events.recv().await.unwrap();
    let _ = events.recv().await.unwrap();

    app.dispatch(
        ReportingCommand::Open {
            player_id: 7,
            login: "Aurora".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Reporting(ReportingEvent::Opened { player_id: 7, .. })
    ));
    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Reporting(ReportingEvent::HistoryLoading)
    ));
    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Reporting(ReportingEvent::HistoryLoaded { .. })
    ));

    app.dispatch(
        ReportingCommand::Submit {
            player_id: 7,
            login: "Aurora".into(),
            description: "Repeated abusive messages in the public chat".into(),
            game_id: None,
            incident_time: String::new(),
        }
        .into(),
    )
    .await
    .unwrap();

    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Reporting(ReportingEvent::Submitting)
    ));
    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Reporting(ReportingEvent::Submitted)
    ));
    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Notifications(NotificationEvent::Added { .. })
    ));
}

/// Holds the game-participation check open until the test lets it answer,
/// then says the player was not in the game.
struct HeldParticipation {
    release: std::sync::Arc<tokio::sync::Notify>,
}

#[async_trait::async_trait]
impl faf_app::ports::ReportingPort for HeldParticipation {
    async fn submit(&self, _request: faf_app::ports::ReportPlayerRequest) -> Result<(), String> {
        Ok(())
    }

    async fn history(
        &self,
        _reporter_id: i32,
    ) -> Result<Vec<faf_domain::state::ModerationReportSummary>, String> {
        Ok(Vec::new())
    }

    async fn game_participation(
        &self,
        _game_id: i32,
        _player_id: i32,
    ) -> Result<faf_app::ports::GameParticipation, String> {
        self.release.notified().await;
        Ok(faf_app::ports::GameParticipation::PlayerAbsent)
    }
}

/// The user submits a report about a game, closes the dialog while the
/// participation check is out, and opens a report about somebody else. The
/// old check's refusal must not land in the new dialog.
#[tokio::test]
async fn a_late_participation_refusal_stays_out_of_a_newer_report() {
    use std::sync::Arc;
    use std::time::Duration;

    let release = Arc::new(tokio::sync::Notify::new());
    let ports = faf_app::Ports {
        reporting: Arc::new(HeldParticipation {
            release: release.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    let app = Arc::new(app);
    app.dispatch_and_wait(AuthCommand::LoginTest.into())
        .await
        .unwrap();

    let first = tokio::spawn({
        let app = app.clone();
        async move {
            app.dispatch_and_wait(
                ReportingCommand::Submit {
                    player_id: 7,
                    login: "Aurora".into(),
                    description: "Repeated abusive messages in the game chat".into(),
                    game_id: Some(4242),
                    incident_time: "12:30".into(),
                }
                .into(),
            )
            .await
        }
    });
    // Let the submission reach the participation check.
    tokio::time::sleep(Duration::from_millis(50)).await;

    app.dispatch_and_wait(ReportingCommand::Close.into())
        .await
        .unwrap();
    app.dispatch_and_wait(
        ReportingCommand::Open {
            player_id: 9,
            login: "Vex".into(),
        }
        .into(),
    )
    .await
    .unwrap();

    release.notify_one();
    first.await.unwrap().unwrap();

    let report = app.snapshot().reporting;
    assert_eq!(report.player_id, Some(9));
    assert!(
        !matches!(
            report.status,
            faf_domain::state::ReportStatus::Failed { .. }
        ),
        "the old report's refusal reached the new dialog: {:?}",
        report.status
    );
}

#[tokio::test]
async fn reporting_yourself_is_rejected_before_the_port_is_called() {
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();

    app.dispatch(AuthCommand::LoginTest.into()).await.unwrap();
    let _ = events.recv().await.unwrap();
    let logged_in = events.recv().await.unwrap();
    let player_id = match logged_in {
        AppEvent::Auth(faf_domain::state::AuthEvent::TestLoggedIn { player }) => player.id,
        other => panic!("expected test login, got {other:?}"),
    };

    app.dispatch(
        ReportingCommand::Submit {
            player_id,
            login: "TestCommander".into(),
            description: "This should never reach the moderation API".into(),
            game_id: None,
            incident_time: String::new(),
        }
        .into(),
    )
    .await
    .unwrap();

    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Reporting(ReportingEvent::Failed { reason }) if reason.contains("yourself")
    ));
}
