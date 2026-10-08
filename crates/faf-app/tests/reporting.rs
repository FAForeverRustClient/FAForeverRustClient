use faf_app::infra::fake_ports;
use faf_app::infra::game_logs::NoGameLogs;
use faf_app::App;
use faf_domain::state::{
    AuthCommand, NotificationEvent, ReportLogAttachment, ReportStatus, ReportingCommand,
    ReportingEvent,
};
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
            attach_log: false,
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
                    attach_log: false,
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
            attach_log: false,
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

// ── game log evidence ──────────────────────────────────────────────────────

/// Keeps every report it is asked to submit, and says the player was in the
/// game, so a test can read the description the API would have received.
#[derive(Default)]
struct RecordingReporting {
    submitted: std::sync::Mutex<Vec<faf_app::ports::ReportPlayerRequest>>,
}

impl RecordingReporting {
    fn descriptions(&self) -> Vec<String> {
        self.submitted
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.description.clone())
            .collect()
    }
}

#[async_trait::async_trait]
impl faf_app::ports::ReportingPort for RecordingReporting {
    async fn submit(&self, request: faf_app::ports::ReportPlayerRequest) -> Result<(), String> {
        self.submitted.lock().unwrap().push(request);
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
        Ok(faf_app::ports::GameParticipation::PlayerPresent)
    }
}

/// One game log, built into an excerpt by the domain's own builder exactly
/// as the disk adapter does, with a fictional account name to take out.
struct FixedGameLog {
    content: String,
    log_game_id: Option<i32>,
}

#[async_trait::async_trait]
impl faf_app::ports::GameLogsPort for FixedGameLog {
    async fn report_excerpt(
        &self,
        game_id: Option<i32>,
    ) -> Result<Option<faf_domain::state::ReportLogExcerpt>, String> {
        Ok(Some(faf_domain::protocol::report_log::build_excerpt(
            game_id,
            &faf_domain::protocol::report_log::ReportLogSource {
                file_name: "game-4242-1-1.log",
                log_game_id: self.log_game_id,
                content: &self.content,
            },
            &["ExampleUser".to_string()],
        )))
    }
}

/// Answers with whatever excerpt it was given, block and all, the way a
/// faulty adapter might.
struct GivenExcerpt(faf_domain::state::ReportLogExcerpt);

#[async_trait::async_trait]
impl faf_app::ports::GameLogsPort for GivenExcerpt {
    async fn report_excerpt(
        &self,
        _game_id: Option<i32>,
    ) -> Result<Option<faf_domain::state::ReportLogExcerpt>, String> {
        Ok(Some(self.0.clone()))
    }
}

/// Holds the read open until the test lets it answer.
struct HeldGameLog {
    release: std::sync::Arc<tokio::sync::Notify>,
}

#[async_trait::async_trait]
impl faf_app::ports::GameLogsPort for HeldGameLog {
    async fn report_excerpt(
        &self,
        game_id: Option<i32>,
    ) -> Result<Option<faf_domain::state::ReportLogExcerpt>, String> {
        self.release.notified().await;
        FixedGameLog {
            content: game_log(),
            log_game_id: game_id,
        }
        .report_excerpt(game_id)
        .await
    }
}

fn game_log() -> String {
    let mut log = String::from(
        "info: Log file C:\\Users\\ExampleUser\\AppData\\Roaming\\FAForever\\game.log\n",
    );
    log.push_str("warning: Desync detected at beat 4100\n");
    log.push_str(&"debug: tick\n".repeat(200));
    log.push_str("info: peer 203.0.113.7 disconnected\n");
    log
}

const WORDS: &str = "He destroyed my base after we allied and then left the game.";

async fn signed_in_app(
    reporting: std::sync::Arc<RecordingReporting>,
    game_logs: std::sync::Arc<dyn faf_app::ports::GameLogsPort>,
) -> std::sync::Arc<App> {
    let ports = faf_app::Ports {
        reporting,
        game_logs,
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    let app = std::sync::Arc::new(app);
    app.dispatch_and_wait(AuthCommand::LoginTest.into())
        .await
        .unwrap();
    app.dispatch_and_wait(
        ReportingCommand::Open {
            player_id: 7,
            login: "Aurora".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    app
}

fn submit(description: &str, game_id: Option<i32>, attach_log: bool) -> faf_domain::AppCommand {
    ReportingCommand::Submit {
        player_id: 7,
        login: "Aurora".into(),
        description: description.into(),
        game_id,
        incident_time: "12:30".into(),
        attach_log,
    }
    .into()
}

fn prepared_block(app: &App) -> String {
    match app.snapshot().reporting.log_attachment {
        ReportLogAttachment::Ready { excerpt } => excerpt.block,
        other => panic!("expected a prepared excerpt, got {other:?}"),
    }
}

#[tokio::test]
async fn the_report_carries_the_log_only_when_the_user_attached_it() {
    let reporting = std::sync::Arc::new(RecordingReporting::default());
    let app = signed_in_app(
        reporting.clone(),
        std::sync::Arc::new(FixedGameLog {
            content: game_log(),
            log_game_id: Some(4242),
        }),
    )
    .await;

    // Not ticked: the words alone, exactly as typed.
    app.dispatch_and_wait(submit(WORDS, Some(4242), false))
        .await
        .unwrap();

    // Ticked: the preview is prepared, and the report carries that block.
    app.dispatch_and_wait(
        ReportingCommand::AttachLog {
            game_id: Some(4242),
        }
        .into(),
    )
    .await
    .unwrap();
    let block = prepared_block(&app);
    app.dispatch_and_wait(submit(WORDS, Some(4242), true))
        .await
        .unwrap();

    let descriptions = reporting.descriptions();
    assert_eq!(descriptions.len(), 2);
    assert_eq!(descriptions[0], WORDS);
    assert_eq!(descriptions[1], format!("{WORDS}\n\n{block}"));
    assert!(descriptions[1].contains("warning: Desync detected at beat 4100"));
    assert!(descriptions[1].contains("<ip> disconnected"));
    // The machine never leaves it: not the account, not the folders, not the
    // address.
    for private in ["ExampleUser", "AppData", "203.0.113.7"] {
        assert!(!descriptions[1].contains(private), "{private} was sent");
    }
}

#[tokio::test]
async fn a_log_prepared_for_another_game_is_refused_rather_than_sent() {
    let reporting = std::sync::Arc::new(RecordingReporting::default());
    let app = signed_in_app(
        reporting.clone(),
        std::sync::Arc::new(FixedGameLog {
            content: game_log(),
            log_game_id: Some(1),
        }),
    )
    .await;
    app.dispatch_and_wait(ReportingCommand::AttachLog { game_id: Some(1) }.into())
        .await
        .unwrap();

    app.dispatch_and_wait(submit(WORDS, Some(2), true))
        .await
        .unwrap();

    assert!(reporting.descriptions().is_empty());
    assert!(matches!(
        app.snapshot().reporting.status,
        ReportStatus::Failed { reason } if reason.contains("different game")
    ));
}

#[tokio::test]
async fn a_log_ticked_but_not_yet_shown_is_not_sent() {
    let reporting = std::sync::Arc::new(RecordingReporting::default());
    let app = signed_in_app(reporting.clone(), std::sync::Arc::new(NoGameLogs)).await;

    app.dispatch_and_wait(ReportingCommand::AttachLog { game_id: None }.into())
        .await
        .unwrap();
    assert_eq!(
        app.snapshot().reporting.log_attachment,
        ReportLogAttachment::Unavailable { game_id: None }
    );
    app.dispatch_and_wait(submit(WORDS, None, true))
        .await
        .unwrap();

    assert!(reporting.descriptions().is_empty());
    assert!(matches!(
        app.snapshot().reporting.status,
        ReportStatus::Failed { reason } if reason.contains("not ready")
    ));
}

#[tokio::test]
async fn the_longest_report_with_the_fullest_log_fits_the_api_column() {
    use faf_domain::protocol::report_log::{
        MAX_DESCRIPTION_BYTES, MAX_LOG_BLOCK_CHARS, MAX_REPORT_TEXT_CHARS,
    };

    // A log far over every limit, in multi-byte text, and words at their
    // limit in a language of two-byte letters.
    let mut log = String::new();
    for index in 0..3_000 {
        log.push_str(&format!("warning: Error {index}: {}\n", "ü".repeat(300)));
    }
    log.push_str(&format!("info: {}\n", "ж".repeat(300)).repeat(3_000));
    let reporting = std::sync::Arc::new(RecordingReporting::default());
    let app = signed_in_app(
        reporting.clone(),
        std::sync::Arc::new(FixedGameLog {
            content: log,
            log_game_id: Some(4242),
        }),
    )
    .await;
    app.dispatch_and_wait(
        ReportingCommand::AttachLog {
            game_id: Some(4242),
        }
        .into(),
    )
    .await
    .unwrap();
    let words = "ж".repeat(MAX_REPORT_TEXT_CHARS);

    app.dispatch_and_wait(submit(&words, Some(4242), true))
        .await
        .unwrap();

    let descriptions = reporting.descriptions();
    assert_eq!(
        descriptions.len(),
        1,
        "a long report in Cyrillic was refused: {:?}",
        app.snapshot().reporting.status
    );
    assert!(descriptions[0].starts_with(&words));
    assert!(descriptions[0].len() <= MAX_DESCRIPTION_BYTES);
    assert!(prepared_block(&app).chars().count() <= MAX_LOG_BLOCK_CHARS);
}

#[tokio::test]
async fn an_oversized_block_is_refused_rather_than_cut() {
    use faf_domain::protocol::report_log::MAX_LOG_BLOCK_CHARS;

    let reporting = std::sync::Arc::new(RecordingReporting::default());
    let app = signed_in_app(
        reporting.clone(),
        std::sync::Arc::new(GivenExcerpt(faf_domain::state::ReportLogExcerpt {
            requested_game_id: None,
            log_game_id: None,
            file_name: "game-1-1-1.log".into(),
            block: "x".repeat(MAX_LOG_BLOCK_CHARS + 1),
            total_lines: 1,
            kept_lines: 1,
            redactions: 0,
        })),
    )
    .await;
    app.dispatch_and_wait(ReportingCommand::AttachLog { game_id: None }.into())
        .await
        .unwrap();

    app.dispatch_and_wait(submit(WORDS, None, true))
        .await
        .unwrap();

    assert!(reporting.descriptions().is_empty());
    assert!(matches!(
        app.snapshot().reporting.status,
        ReportStatus::Failed { reason } if reason.contains("too long")
    ));
}

/// The user ticks the box, then unticks it while the log is still being
/// read. The read's late answer must not tick it again.
#[tokio::test]
async fn unticking_while_the_log_is_read_keeps_it_off() {
    use std::time::Duration;

    let release = std::sync::Arc::new(tokio::sync::Notify::new());
    let reporting = std::sync::Arc::new(RecordingReporting::default());
    let app = signed_in_app(
        reporting,
        std::sync::Arc::new(HeldGameLog {
            release: release.clone(),
        }),
    )
    .await;

    let read = tokio::spawn({
        let app = app.clone();
        async move {
            app.dispatch_and_wait(ReportingCommand::AttachLog { game_id: Some(5) }.into())
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        app.snapshot().reporting.log_attachment,
        ReportLogAttachment::Preparing { game_id: Some(5) }
    );
    app.dispatch_and_wait(ReportingCommand::DetachLog.into())
        .await
        .unwrap();

    release.notify_one();
    read.await.unwrap().unwrap();

    assert_eq!(
        app.snapshot().reporting.log_attachment,
        ReportLogAttachment::Off
    );
}

/// Closing the dialog while the log is read, then reporting somebody else:
/// the old read must not attach its log to the new report.
#[tokio::test]
async fn a_log_read_for_a_closed_report_stays_out_of_the_next_one() {
    use std::time::Duration;

    let release = std::sync::Arc::new(tokio::sync::Notify::new());
    let reporting = std::sync::Arc::new(RecordingReporting::default());
    let app = signed_in_app(
        reporting,
        std::sync::Arc::new(HeldGameLog {
            release: release.clone(),
        }),
    )
    .await;

    let read = tokio::spawn({
        let app = app.clone();
        async move {
            app.dispatch_and_wait(ReportingCommand::AttachLog { game_id: None }.into())
                .await
        }
    });
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
    read.await.unwrap().unwrap();

    let report = app.snapshot().reporting;
    assert_eq!(report.player_id, Some(9));
    assert_eq!(report.log_attachment, ReportLogAttachment::Off);
}
