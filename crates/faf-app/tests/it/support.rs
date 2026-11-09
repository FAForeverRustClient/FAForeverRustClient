//! What a test here needs before it can say anything about a feature: a
//! running app, and a way to wait for it.
//!
//! Every file used to carry its own copy of both. The copies of the wait
//! cloned the whole `AppState` every ten milliseconds to look at one field of
//! it. These look at the state where it is, and look again as soon as an event
//! has been reduced rather than when the next tick comes round.

use std::time::Duration;

use faf_app::{App, Ports};
use faf_domain::AppState;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::Instant;

/// How long something that should happen promptly gets before the test calls
/// it stuck. A safety net only: nothing waits this long when the test passes.
pub const PATIENCE: Duration = Duration::from_secs(10);

/// How often a wait looks again when nothing has told it to.
const TICK: Duration = Duration::from_millis(10);

/// An app on `ports` with its command loop running.
pub fn start(ports: Ports) -> App {
    start_as("test", ports)
}

/// The same, as the build `version`: for what the client decides from its own
/// version, such as whether a release is newer.
pub fn start_as(version: impl Into<String>, ports: Ports) -> App {
    let (app, app_loop) = App::new(version, ports);
    tokio::spawn(app_loop.run());
    app
}

/// Wait for `look` to find something in the state and hand it back, or `None`
/// once `patience` has run out.
///
/// `look` is given the state borrowed, under the same guard a reduction
/// takes, so it must only read what it is handed: a `look` that dispatches a
/// command or asks the app for a snapshot waits for itself.
pub async fn find<T>(
    app: &App,
    patience: Duration,
    look: impl Fn(&AppState) -> Option<T>,
) -> Option<T> {
    // Subscribed before the first look, so a change that lands between a look
    // and the wait after it still ends that wait.
    let mut events = app.subscribe();
    let deadline = Instant::now() + patience;
    loop {
        if let Some(found) = app.with_state(&look) {
            return Some(found);
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return None;
        }
        let tick = TICK.min(left);
        tokio::select! {
            received = events.recv() => {
                // A closed stream answers at once every time it is asked,
                // which would turn this loop into a spin. The tick alone then.
                if matches!(received, Err(RecvError::Closed)) {
                    tokio::time::sleep(tick).await;
                }
            }
            () = tokio::time::sleep(tick) => {}
        }
    }
}

/// Whether the state gets to where `done` holds within `patience`. For a test
/// that has its own words for the failure, or expects there to be none.
pub async fn reaches(app: &App, patience: Duration, done: impl Fn(&AppState) -> bool) -> bool {
    find(app, patience, |state| done(state).then_some(()))
        .await
        .is_some()
}

/// Wait for the state to get to where `done` holds, and fail the test naming
/// `what` when it never does.
pub async fn until(app: &App, what: &str, done: impl Fn(&AppState) -> bool) {
    assert!(reaches(app, PATIENCE, done).await, "never saw {what}");
}

/// Whether `done` comes true within `patience`, for what is not in the state:
/// a call a stub counted, a file on disk, a line a port recorded.
pub async fn happens(patience: Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + patience;
    loop {
        if done() {
            return true;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        tokio::time::sleep(TICK.min(left)).await;
    }
}

/// Wait for `done` to come true, and fail the test naming `what` when it
/// never does.
pub async fn eventually(what: &str, done: impl FnMut() -> bool) {
    assert!(happens(PATIENCE, done).await, "never happened: {what}");
}
