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
