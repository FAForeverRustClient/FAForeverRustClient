//! Review service tests.
//!
//! The branch that matters is create-vs-update: posting a second review when
//! you already have one is a 422 from the server and a confusing failure for
//! the user, so the service has to recognise its own review by login.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakeAuth};
use faf_app::ports::{ReviewPage, ReviewsPort};
use faf_app::{App, Ports};
use faf_domain::state::{
    Player, Review, ReviewKind, ReviewSubmitStatus, ReviewTarget, ReviewsCommand, ReviewsStatus,
};
use std::time::Duration;

/// What the port was asked to do, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Call {
    List,
    Create { version_id: i32, score: i32 },
    Update { review_id: i32, score: i32 },
    Delete { review_id: i32 },
}

struct StubReviews {
    calls: Arc<Mutex<Vec<Call>>>,
    reviews: Mutex<Vec<Review>>,
    latest_version_id: Option<i32>,
    write_error: Option<String>,
}

#[async_trait]
impl ReviewsPort for StubReviews {
    async fn list(&self, _kind: ReviewKind, _subject_id: i32) -> Result<ReviewPage, String> {
        self.calls.lock().unwrap().push(Call::List);
        Ok(ReviewPage {
            reviews: self.reviews.lock().unwrap().clone(),
            latest_version_id: self.latest_version_id,
        })
    }

    async fn create(
        &self,
        _kind: ReviewKind,
        version_id: i32,
        score: i32,
        text: String,
    ) -> Result<Review, String> {
        self.calls
            .lock()
            .unwrap()
            .push(Call::Create { version_id, score });
        if let Some(error) = &self.write_error {
            return Err(error.clone());
        }
        let review = Review {
            id: 99,
            score,
            text,
            player: "Ada".into(),
            version: "3".into(),
        };
        self.reviews.lock().unwrap().push(review.clone());
        Ok(review)
    }

    async fn update(
        &self,
        _kind: ReviewKind,
        review_id: i32,
        score: i32,
        text: String,
    ) -> Result<(), String> {
        self.calls
            .lock()
            .unwrap()
            .push(Call::Update { review_id, score });
        if let Some(error) = &self.write_error {
            return Err(error.clone());
        }
        let mut reviews = self.reviews.lock().unwrap();
        if let Some(review) = reviews.iter_mut().find(|review| review.id == review_id) {
            review.score = score;
            review.text = text;
        }
        Ok(())
    }

    async fn delete(&self, _kind: ReviewKind, review_id: i32) -> Result<(), String> {
        self.calls.lock().unwrap().push(Call::Delete { review_id });
        self.reviews
            .lock()
            .unwrap()
            .retain(|review| review.id != review_id);
        Ok(())
    }
}

fn review(id: i32, score: i32, player: &str) -> Review {
    Review {
        id,
        score,
        text: "text".into(),
        player: player.into(),
        version: "3".into(),
    }
}

fn target() -> ReviewTarget {
    ReviewTarget {
        kind: ReviewKind::Map,
        id: 42,
        name: "Seton's Clutch".into(),
    }
}

struct Harness {
    app: App,
    calls: Arc<Mutex<Vec<Call>>>,
}

fn harness(
    existing: Vec<Review>,
    latest_version_id: Option<i32>,
    write_error: Option<String>,
) -> Harness {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        auth: Arc::new(FakeAuth {
            player: Player {
                id: 7,
                name: "Ada".into(),
            },
            delay: Duration::ZERO,
            fail_with: None,
        }),
        reviews: Arc::new(StubReviews {
            calls: calls.clone(),
            reviews: Mutex::new(existing),
            latest_version_id,
            write_error,
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    Harness { app, calls }
}

impl Harness {
    async fn sign_in_and_open(&self) {
        self.app
            .dispatch(faf_domain::state::AuthCommand::Login { remember: false }.into())
            .await
            .unwrap();
        self.app
            .dispatch(ReviewsCommand::Open { target: target() }.into())
            .await
            .unwrap();
        self.settle(
            |state| state.status == ReviewsStatus::Ready,
            "the reviews to load",
        )
        .await;
    }

    async fn settle(
        &self,
        condition: impl Fn(&faf_domain::state::ReviewsState) -> bool,
        what: &str,
    ) {
        for _ in 0..300 {
            if condition(&self.app.snapshot().reviews) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "timed out waiting for {what}: {:?}",
            self.app.snapshot().reviews
        );
    }

    async fn settled_submit(&self) -> ReviewSubmitStatus {
        self.settle(
            |state| {
                matches!(
                    state.submit,
                    ReviewSubmitStatus::Saved | ReviewSubmitStatus::Failed { .. }
                )
            },
            "the write to settle",
        )
        .await;
        self.app.snapshot().reviews.submit
    }
}

#[tokio::test]
async fn opening_loads_the_reviews_and_derives_the_histogram() {
    let h = harness(
        vec![review(1, 5, "Bob"), review(2, 3, "Cid")],
        Some(30),
        None,
    );
    h.sign_in_and_open().await;

    let state = h.app.snapshot().reviews;
    assert_eq!(state.reviews.len(), 2);
    assert_eq!(state.summary.total, 2);
    assert_eq!(state.summary.average_tenths, 40);
    assert_eq!(state.summary.count(5), 1);
    assert_eq!(state.target, Some(target()));
}

#[tokio::test]
async fn a_first_review_is_created_against_the_latest_version() {
    let h = harness(vec![review(1, 5, "Bob")], Some(30), None);
    h.sign_in_and_open().await;

    h.app
        .dispatch(
            ReviewsCommand::Submit {
                score: 4,
                text: "Solid".into(),
            }
            .into(),
        )
        .await
        .unwrap();
    assert_eq!(h.settled_submit().await, ReviewSubmitStatus::Saved);

    let calls = h.calls.lock().unwrap().clone();
    assert!(
        calls.contains(&Call::Create {
            version_id: 30,
            score: 4
        }),
        "expected a create, saw {calls:?}"
    );
    // And the list is re-read so the histogram matches what everyone sees.
    assert_eq!(h.app.snapshot().reviews.reviews.len(), 2);
}

#[tokio::test]
async fn a_second_submission_updates_your_existing_review() {
    // Posting again would be a 422. The service recognises its own review by
    // login, case-insensitively.
    let h = harness(
        vec![review(1, 5, "Bob"), review(7, 2, "ada")],
        Some(30),
        None,
    );
    h.sign_in_and_open().await;

    h.app
        .dispatch(
            ReviewsCommand::Submit {
                score: 5,
                text: "Changed my mind".into(),
            }
            .into(),
        )
        .await
        .unwrap();
    assert_eq!(h.settled_submit().await, ReviewSubmitStatus::Saved);

    let calls = h.calls.lock().unwrap().clone();
    assert!(
        calls.contains(&Call::Update {
            review_id: 7,
            score: 5
        }),
        "expected an update of our own review, saw {calls:?}"
    );
    assert!(
        !calls.iter().any(|call| matches!(call, Call::Create { .. })),
        "must not post a second review"
    );
}

#[tokio::test]
async fn a_score_outside_the_range_is_clamped_before_it_reaches_the_api() {
    let h = harness(Vec::new(), Some(30), None);
    h.sign_in_and_open().await;

    h.app
        .dispatch(
            ReviewsCommand::Submit {
                score: 99,
                text: String::new(),
            }
            .into(),
        )
        .await
        .unwrap();
    h.settled_submit().await;

    let calls = h.calls.lock().unwrap().clone();
    assert!(calls.contains(&Call::Create {
        version_id: 30,
        score: 5
    }));
}

#[tokio::test]
async fn a_failed_write_keeps_the_reviews_on_screen() {
    let h = harness(
        vec![review(1, 5, "Bob")],
        Some(30),
        Some("You have already reviewed this map.".into()),
    );
    h.sign_in_and_open().await;

    h.app
        .dispatch(
            ReviewsCommand::Submit {
                score: 4,
                text: String::new(),
            }
            .into(),
        )
        .await
        .unwrap();

    match h.settled_submit().await {
        ReviewSubmitStatus::Failed { reason } => assert!(reason.contains("already reviewed")),
        other => panic!("expected a failure, got {other:?}"),
    }
    assert_eq!(
        h.app.snapshot().reviews.reviews.len(),
        1,
        "a failed write must not blank the list"
    );
}

#[tokio::test]
async fn an_unreviewable_subject_says_so_rather_than_posting_nowhere() {
    // No version means no collection to post into.
    let h = harness(Vec::new(), None, None);
    h.sign_in_and_open().await;

    h.app
        .dispatch(
            ReviewsCommand::Submit {
                score: 4,
                text: String::new(),
            }
            .into(),
        )
        .await
        .unwrap();

    match h.settled_submit().await {
        ReviewSubmitStatus::Failed { reason } => assert!(reason.contains("no published version")),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[tokio::test]
async fn withdrawing_removes_only_your_own_review() {
    let h = harness(
        vec![review(1, 5, "Bob"), review(7, 2, "Ada")],
        Some(30),
        None,
    );
    h.sign_in_and_open().await;

    h.app.dispatch(ReviewsCommand::Delete.into()).await.unwrap();
    assert_eq!(h.settled_submit().await, ReviewSubmitStatus::Saved);

    let calls = h.calls.lock().unwrap().clone();
    assert!(calls.contains(&Call::Delete { review_id: 7 }));

    let left = h.app.snapshot().reviews.reviews;
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].player, "Bob");
}

#[tokio::test]
async fn withdrawing_without_a_review_of_your_own_does_nothing() {
    let h = harness(vec![review(1, 5, "Bob")], Some(30), None);
    h.sign_in_and_open().await;
    let before = h.calls.lock().unwrap().len();

    h.app.dispatch(ReviewsCommand::Delete.into()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(120)).await;

    assert_eq!(
        h.calls.lock().unwrap().len(),
        before,
        "no request should be made"
    );
}

#[tokio::test]
async fn writing_while_signed_out_is_refused_with_a_reason() {
    let ports = Ports {
        reviews: Arc::new(StubReviews {
            calls: Arc::new(Mutex::new(Vec::new())),
            reviews: Mutex::new(Vec::new()),
            latest_version_id: Some(30),
            write_error: None,
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());

    app.dispatch(ReviewsCommand::Open { target: target() }.into())
        .await
        .unwrap();
    app.dispatch(
        ReviewsCommand::Submit {
            score: 4,
            text: String::new(),
        }
        .into(),
    )
    .await
    .unwrap();

    for _ in 0..300 {
        if let ReviewSubmitStatus::Failed { reason } = app.snapshot().reviews.submit {
            assert!(reason.contains("sign in"));
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("expected a signed-out refusal");
}
