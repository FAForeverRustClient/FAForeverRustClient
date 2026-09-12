//! Named concurrency policies shared by services.
//!
//! Services describe the behavior they need instead of open-coding atomics,
//! memory ordering, and empty mutexes. This keeps the policy auditable in one
//! place and makes a `ServiceCtx` field explain whether work is single-flight,
//! latest-response-wins, or serialized.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::{Mutex, MutexGuard};

/// Allows one owner at a time.
///
/// Prefer [`SingleFlight::try_acquire`] when ownership follows a lexical async
/// operation. Long-lived connection services may use [`SingleFlight::try_start`]
/// and [`SingleFlight::finish`] because another command owns their teardown.
#[derive(Debug, Default)]
pub struct SingleFlight(AtomicBool);

impl SingleFlight {
    pub fn try_acquire(&self) -> Option<SingleFlightGuard<'_>> {
        self.try_start().then_some(SingleFlightGuard(self))
    }

    pub fn try_start(&self) -> bool {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub fn finish(&self) {
        self.0.store(false, Ordering::Release);
    }

    #[cfg(test)]
    fn is_active(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// RAII ownership returned by [`SingleFlight::try_acquire`].
pub struct SingleFlightGuard<'a>(&'a SingleFlight);

impl Drop for SingleFlightGuard<'_> {
    fn drop(&mut self) {
        self.0.finish();
    }
}

/// Whether a long-lived connection should be brought back after it drops.
///
/// Armed by an explicit `Connect` and disarmed by an explicit `Disconnect`, so
/// [`reconnect`](crate::services::reconnect) can tell a socket that failed
/// from one the user hung up. A plain flag rather than a [`SingleFlight`]: two
/// commands set it and a third only reads it, and nobody owns it in between.
#[derive(Debug, Default)]
pub struct AutoReconnect(AtomicBool);

impl AutoReconnect {
    pub fn arm(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn disarm(&self) {
        self.0.store(false, Ordering::Release);
    }

    pub fn armed(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// Whether the join in flight has been called off.
///
/// Cleared when a join starts, set by `CancelJoin`, and read at the points
/// where a join can still be stopped without leaving something half done: after
/// preparation returns, and before the join request goes to the server.
///
/// A flag checked at boundaries rather than a cancellation token that aborts
/// mid-work, because the work in question is the file loop inside the updater
/// and stopping that mid-write is how a corrupt entry gets into the content
/// store. Preparation therefore finishes the step it is on. That is the
/// difference between this and clearing the join state on its own, which is
/// what the note on `DeclineModReplacement` warned against: the state and the
/// work now agree about whether the join is still happening.
#[derive(Debug, Default)]
pub struct CancelledJoin(AtomicBool);

impl CancelledJoin {
    /// A new join is starting: nothing has been cancelled yet.
    pub fn clear(&self) {
        self.0.store(false, Ordering::Release);
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// Generation counter for requests where only the newest response may land.
#[derive(Debug, Default, Clone)]
pub struct LatestRequest(Arc<AtomicU64>);

impl LatestRequest {
    /// Invalidate earlier work and return this request's generation.
    pub fn begin(&self) -> u64 {
        self.0.fetch_add(1, Ordering::AcqRel).wrapping_add(1)
    }

    /// Invalidate earlier work without starting another request.
    pub fn invalidate(&self) {
        self.0.fetch_add(1, Ordering::AcqRel);
    }

    pub fn is_current(&self, generation: u64) -> bool {
        self.0.load(Ordering::Acquire) == generation
    }
}

/// Serializes mutations that share an external resource or persisted file.
#[derive(Debug, Default, Clone)]
pub struct SerialMutation(Arc<Mutex<()>>);

impl SerialMutation {
    pub async fn acquire(&self) -> MutexGuard<'_, ()> {
        self.0.lock().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_flight_has_one_owner_and_releases_on_drop() {
        let flight = SingleFlight::default();
        let first = flight.try_acquire().expect("first caller owns the flight");
        assert!(flight.is_active());
        assert!(flight.try_acquire().is_none());
        drop(first);
        assert!(!flight.is_active());
        assert!(flight.try_acquire().is_some());
    }

    #[test]
    fn latest_request_invalidates_every_earlier_generation() {
        let requests = LatestRequest::default();
        let shared = requests.clone();
        let first = requests.begin();
        assert!(shared.is_current(first));
        let second = shared.begin();
        assert!(!requests.is_current(first));
        assert!(requests.is_current(second));
        requests.invalidate();
        assert!(!shared.is_current(second));
    }

    #[tokio::test]
    async fn serial_mutation_releases_with_its_guard() {
        let mutation = SerialMutation::default();
        let shared = mutation.clone();
        let first = mutation.acquire().await;
        assert!(shared.0.try_lock().is_err());
        drop(first);
        assert!(shared.0.try_lock().is_ok());
    }
}
