//! Catalogue maintenance service tests.
//!
//! What is worth a test at this level is the service's own policy around the
//! port: what it refuses before calling it, what it tells the tab after it, and
//! how long it holds the verdict order. The HTTP side of each fix is tested
//! against a stand-in server in `infra/guides.rs`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::guides::LOGIN_CANCELLED;
use faf_app::ports::{DeviceCode, GuidesPort};
use faf_app::{App, Ports};
use faf_domain::state::{
    ContributionDraft, DraftImage, GuideImage, GuideSubmission, GuidesAuthStatus, GuidesCommand,
    GuidesIdentity, RejectReason, SubmitStatus, TrainingResource,
};
use tokio::sync::Semaphore;

/// A catalogue repository that records what it was asked and answers from
/// whatever the test put in it.
struct Stub {
    queue: Mutex<Vec<GuideSubmission>>,
    calls: Mutex<Vec<String>>,
    /// When set, every queue read waits on `gate` before answering.
    hold_lists: AtomicBool,
    gate: Semaphore,
    lost: Mutex<Option<String>>,
    restore: Mutex<Option<Result<Option<GuidesIdentity>, String>>>,
    cancel_during_start: AtomicBool,
}

impl Default for Stub {
    fn default() -> Self {
        Self {
            queue: Mutex::new(Vec::new()),
            calls: Mutex::new(Vec::new()),
            hold_lists: AtomicBool::new(false),
            gate: Semaphore::new(0),
            lost: Mutex::new(None),
            restore: Mutex::new(None),
            cancel_during_start: AtomicBool::new(false),
        }
    }
}

impl Stub {
    fn record(&self, call: impl Into<String>) {
        self.calls.lock().unwrap().push(call.into());
    }

    fn called(&self, call: &str) -> bool {
        self.calls.lock().unwrap().iter().any(|held| held == call)
    }
}

#[async_trait]
impl GuidesPort for Stub {
    fn repo(&self) -> String {
        "o/r".into()
    }

    fn configured(&self) -> bool {
        true
    }

    async fn begin_login(&self) -> Result<DeviceCode, String> {
        self.record("begin");
        if self.cancel_during_start.load(Ordering::SeqCst) {
            return Err(LOGIN_CANCELLED.into());
        }
        Err("not in this test".into())
    }

    async fn complete_login(&self, _code: DeviceCode) -> Result<GuidesIdentity, String> {
        Err("not in this test".into())
    }

    fn cancel_login(&self) {}

    async fn restore_login(&self) -> Result<Option<GuidesIdentity>, String> {
        self.restore.lock().unwrap().take().unwrap_or(Ok(None))
    }

    async fn sign_out(&self) {}

    fn take_lost_session(&self) -> Option<String> {
        self.lost.lock().unwrap().take()
    }

    async fn list_submissions(&self) -> Result<Vec<GuideSubmission>, String> {
        self.record("list");
        if self.hold_lists.load(Ordering::SeqCst) {
            let _permit = self.gate.acquire().await.expect("gate open");
        }
        Ok(self.queue.lock().unwrap().clone())
    }

    async fn accept(&self, submission: GuideSubmission) -> Result<(), String> {
        self.record(format!("accept {}", submission.number));
        Ok(())
    }

    async fn reject(
        &self,
        number: i32,
        _reason: RejectReason,
        _note: String,
    ) -> Result<(), String> {
        self.record(format!("reject {number}"));
        Ok(())
    }

    async fn submit(
        &self,
        _entry: TrainingResource,
        _guide: String,
        images: Vec<GuideImage>,
    ) -> Result<String, String> {
        self.record("submit");
        self.record(format!(
            "images {}",
            images
                .iter()
                .map(|image| image.name.as_str())
                .collect::<Vec<_>>()
                .join(",")
        ));
        Ok("https://github.com/o/r/issues/1".into())
    }
}

fn harness(stub: Arc<Stub>) -> App {
    let ports = Ports {
        guides: stub,
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    app
}

fn row(number: i32) -> GuideSubmission {
    GuideSubmission {
        number,
        title: format!("Training submission: Guide {number}"),
        entry: Some(TrainingResource {
            id: format!("guide-{number}"),
            title: format!("Guide {number}"),
            url: "https://example.invalid/guide".into(),
            ..TrainingResource::default()
        }),
        ..GuideSubmission::default()
    }
}

fn identity() -> GuidesIdentity {
    GuidesIdentity {
        login: "maintainer".into(),
        avatar_url: String::new(),
        can_commit: true,
    }
}

async fn eventually(what: &str, mut done: impl FnMut() -> bool) {
    for _ in 0..300 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("never happened: {what}");
}

#[tokio::test]
async fn a_draft_with_no_title_is_refused_before_anything_reaches_github() {
    // It used to open an issue titled "Training submission: " and nothing
    // after it.
    let stub = Arc::new(Stub::default());
    let app = harness(stub.clone());

    let draft = ContributionDraft {
        title: "   ".into(),
        url: "https://example.invalid/guide".into(),
        ..ContributionDraft::default()
    };
    app.dispatch_and_wait(
        GuidesCommand::Submit {
            draft: Box::new(draft),
            images: Vec::new(),
        }
        .into(),
    )
    .await
    .unwrap();

    match app.snapshot().guides.submit {
        SubmitStatus::Failed { reason } => assert!(reason.contains("title"), "{reason}"),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert!(!stub.called("submit"));
}

fn draft_image(name: &str, bytes: &[u8]) -> DraftImage {
    use base64::Engine as _;
    DraftImage {
        name: name.into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    }
}

const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];

#[tokio::test]
async fn only_the_pictures_a_guide_still_shows_are_sent() {
    // Attached, then deleted from the text: committing it would put a file in
    // the repository that nothing ever shows.
    let stub = Arc::new(Stub::default());
    let app = harness(stub.clone());

    let draft = ContributionDraft {
        title: "Setons air".into(),
        body: "![The opening](images/opening.png)".into(),
        ..ContributionDraft::default()
    };
    app.dispatch_and_wait(
        GuidesCommand::Submit {
            draft: Box::new(draft),
            images: vec![
                draft_image("opening.png", PNG),
                draft_image("unused.png", PNG),
            ],
        }
        .into(),
    )
    .await
    .unwrap();

    assert!(stub.called("submit"));
    assert!(
        stub.called("images opening.png"),
        "{:?}",
        stub.calls.lock().unwrap()
    );
}

#[tokio::test]
async fn a_file_that_is_not_a_picture_is_refused_before_anything_reaches_github() {
    let stub = Arc::new(Stub::default());
    let app = harness(stub.clone());

    let draft = ContributionDraft {
        title: "Setons air".into(),
        body: "![x](images/notes.png)".into(),
        ..ContributionDraft::default()
    };
    app.dispatch_and_wait(
        GuidesCommand::Submit {
            draft: Box::new(draft),
            images: vec![draft_image("notes.png", b"just some text")],
        }
        .into(),
    )
    .await
    .unwrap();

    match app.snapshot().guides.submit {
        SubmitStatus::Failed { reason } => assert!(reason.contains("PNG"), "{reason}"),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert!(!stub.called("submit"));
}

#[tokio::test]
async fn the_next_verdict_does_not_wait_for_the_reload_after_an_accept() {
    // The verdict order used to be held across the queue and catalogue
    // reloads that follow an accept, so a second decision waited for reads
    // it has nothing to do with.
    let stub = Arc::new(Stub::default());
    *stub.queue.lock().unwrap() = vec![row(1), row(2)];
    let app = harness(stub.clone());
    app.dispatch_and_wait(GuidesCommand::LoadQueue.into())
        .await
        .unwrap();
    assert_eq!(app.snapshot().guides.submissions.len(), 2);

    stub.hold_lists.store(true, Ordering::SeqCst);
    app.dispatch(GuidesCommand::Accept { number: 1 }.into())
        .await
        .unwrap();
    eventually("the accept reaches the port", || stub.called("accept 1")).await;

    app.dispatch(
        GuidesCommand::Reject {
            number: 2,
            reason: RejectReason::Duplicate,
            note: String::new(),
        }
        .into(),
    )
    .await
    .unwrap();
    eventually("the reject runs while the reload is still held", || {
        stub.called("reject 2")
    })
    .await;

    stub.gate.add_permits(100);
}

#[tokio::test]
async fn a_token_dropped_during_a_queue_read_ends_the_session_on_screen() {
    let stub = Arc::new(Stub::default());
    *stub.restore.lock().unwrap() = Some(Ok(Some(identity())));
    let app = harness(stub.clone());
    app.dispatch_and_wait(GuidesCommand::Restore.into())
        .await
        .unwrap();
    assert!(app.snapshot().guides.may_moderate());

    *stub.lost.lock().unwrap() = Some("the saved GitHub sign-in no longer works".into());
    app.dispatch_and_wait(GuidesCommand::LoadQueue.into())
        .await
        .unwrap();

    let guides = app.snapshot().guides;
    assert!(!guides.may_moderate());
    assert!(matches!(guides.auth, GuidesAuthStatus::Failed { .. }));
}

#[tokio::test]
async fn github_being_unreachable_does_not_take_a_session_off_the_screen() {
    let stub = Arc::new(Stub::default());
    *stub.restore.lock().unwrap() = Some(Ok(Some(identity())));
    let app = harness(stub.clone());
    app.dispatch_and_wait(GuidesCommand::Restore.into())
        .await
        .unwrap();

    // The tab is opened again while offline: the port kept the token and
    // reports no lost session.
    *stub.restore.lock().unwrap() = Some(Err("could not reach GitHub".into()));
    app.dispatch_and_wait(GuidesCommand::Restore.into())
        .await
        .unwrap();
    assert!(app.snapshot().guides.may_moderate(), "still signed in");
}

#[tokio::test]
async fn an_offline_start_says_the_saved_sign_in_was_kept() {
    let stub = Arc::new(Stub::default());
    *stub.restore.lock().unwrap() = Some(Err("could not reach GitHub".into()));
    let app = harness(stub.clone());
    app.dispatch_and_wait(GuidesCommand::Restore.into())
        .await
        .unwrap();

    match app.snapshot().guides.auth {
        GuidesAuthStatus::Failed { reason } => assert!(reason.contains("kept"), "{reason}"),
        other => panic!("expected the reason on screen, got {other:?}"),
    }
}

#[tokio::test]
async fn a_sign_in_cancelled_while_the_code_was_issued_leaves_no_code_on_screen() {
    let stub = Arc::new(Stub::default());
    stub.cancel_during_start.store(true, Ordering::SeqCst);
    let app = harness(stub.clone());
    app.dispatch_and_wait(GuidesCommand::SignIn.into())
        .await
        .unwrap();

    assert!(stub.called("begin"));
    let auth = app.snapshot().guides.auth;
    assert!(
        !matches!(
            auth,
            GuidesAuthStatus::Waiting { .. } | GuidesAuthStatus::Failed { .. }
        ),
        "{auth:?}"
    );
}
