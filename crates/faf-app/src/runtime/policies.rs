//! Named concurrency policies shared by services.
//!
//! Services describe the behavior they need instead of open-coding atomics,
//! memory ordering, and empty mutexes. This keeps the policy auditable in one
//! place and makes a `ServiceCtx` field explain whether work is single-flight,
//! latest-response-wins, or serialized.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
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
        // `then`, never `then_some`: `then_some` builds its argument whether
        // or not it is used, so a refused caller made a guard anyway, dropped
        // it, and its `Drop` released the flight the owner still held. The
        // next caller then started alongside the first.
        self.try_start().then(|| SingleFlightGuard(self))
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

/// Whether the persisted copy of a slice has been read into state yet.
///
/// One way: it starts closed, opens once, and never closes again. It exists so
/// that a writer can tell "this is what the user has" from "this is what the
/// defaults are, because the file has not been read yet", which nothing else
/// in the loop can distinguish: `SettingsState::default()` and a genuinely
/// empty settings file look identical in state.
///
/// That distinction is the difference between saving a preference and erasing
/// every other one with it. Commands run on their own tasks, so a write can
/// reach the service before the load that is still in flight, and settings are
/// persisted as a whole document.
#[derive(Debug, Default)]
pub struct LoadedFromDisk(AtomicBool);

impl LoadedFromDisk {
    /// The stored copy is now in state, whether it came from a file or from
    /// there being no file to read.
    pub fn mark_loaded(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn has_loaded(&self) -> bool {
        self.0.load(Ordering::Acquire)
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

/// One piece of lobby work that owns the join state while it runs: a custom
/// join, a host request, or the launch a server order starts.
///
/// Issued by [`LobbyOperations`] and never reused, so a preparation that is
/// still draining after it was called off can always tell that the operation
/// now on screen is somebody else's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LobbyOperation(u64);

tokio::task_local! {
    /// The operation the code running on this task is doing the work of.
    ///
    /// Set by [`LobbyOperations::run`] around the launcher's preparation, so
    /// that the launcher's own checks (`is_cancelled`, `clear`) answer for the
    /// operation it is preparing rather than for whichever one is newest.
    static SCOPED_OPERATION: LobbyOperation;
}

/// Low bit of [`LobbyOperations::current`]: the current operation was called
/// off. The rest of the word is the operation's id.
const OPERATION_CANCELLED: u64 = 1;

/// Which lobby operation is current, whether it was called off, and which one
/// holds the join slot.
///
/// This replaced a single shared "cancelled" flag, and the difference is the
/// bug it fixes. `CancelJoin` set the flag and released the join guard while
/// the cancelled preparation was still running, because the updater has to
/// finish the step it is on. The next `Join` or `Host` then cleared that same
/// flag, so the old preparation saw "not cancelled" at its next boundary: it
/// narrated progress again, sent its original `game_join`, and its cleanup
/// released the guard the newer join was holding. Every operation now has its
/// own id, the work checks that id against the current one at each boundary,
/// and a cleanup can only release the slot it took itself.
///
/// Still a check at boundaries rather than a token that aborts mid-work: the
/// work in question is the file loop inside the updater, and stopping that
/// mid-write is how a corrupt entry gets into the content store. Preparation
/// therefore finishes the step it is on and is no longer narrated, which is
/// the difference between this and clearing the join state on its own (the
/// note on `DeclineModReplacement`): the state and the work agree about
/// whether the join is still happening.
#[derive(Debug, Default)]
pub struct LobbyOperations {
    /// Source of ids. Starts at one, so zero always means "none".
    issued: AtomicU64,
    /// The current operation's id shifted left by one, with
    /// [`OPERATION_CANCELLED`] set once it is called off. One word, so that
    /// "is this mine and still wanted" is a single load.
    current: AtomicU64,
    /// The operation holding the join slot, or zero when it is free.
    ///
    /// A custom join stays single-flight from the first click until the
    /// server accepts or rejects it. Preparation can take minutes, so a local
    /// component disabled-state alone is not a concurrency boundary.
    join_slot: AtomicU64,
}

impl LobbyOperations {
    fn issue(&self) -> LobbyOperation {
        LobbyOperation(self.issued.fetch_add(1, Ordering::AcqRel).wrapping_add(1))
    }

    fn make_current(&self, operation: LobbyOperation) {
        self.current.store(operation.0 << 1, Ordering::Release);
    }

    /// Start an operation that does not take the join slot (a host request,
    /// a launch order). It supersedes whatever was current.
    pub fn begin(&self) -> LobbyOperation {
        let operation = self.issue();
        self.make_current(operation);
        operation
    }

    /// Start a custom join, or `None` when another join holds the slot.
    ///
    /// The slot is taken before the operation becomes current, so a refused
    /// duplicate click cannot supersede the join it was refused for.
    pub fn try_begin_join(&self) -> Option<LobbyOperation> {
        let operation = self.issue();
        self.join_slot
            .compare_exchange(0, operation.0, Ordering::AcqRel, Ordering::Acquire)
            .ok()?;
        self.make_current(operation);
        Some(operation)
    }

    /// Call off the current operation, whichever it is.
    pub fn cancel(&self) {
        self.current.fetch_or(OPERATION_CANCELLED, Ordering::AcqRel);
    }

    /// Whether `operation` is still the current one and nobody called it off.
    /// Every boundary where its work could still touch the join state, or
    /// reach the server, asks this first.
    pub fn is_live(&self, operation: LobbyOperation) -> bool {
        self.current.load(Ordering::Acquire) == operation.0 << 1
    }

    /// Release the join slot if, and only if, `operation` holds it. A
    /// cancelled join's cleanup runs after the next join may have started,
    /// and must leave that one's slot alone.
    pub fn release_join(&self, operation: LobbyOperation) {
        let _ =
            self.join_slot
                .compare_exchange(operation.0, 0, Ordering::AcqRel, Ordering::Acquire);
    }

    /// Release the join slot whoever holds it: the server answered the join,
    /// the user called it off, or the connection it was sent on is gone.
    pub fn release_any_join(&self) {
        self.join_slot.store(0, Ordering::Release);
    }

    /// Run `work` as `operation`, so the launcher's checks inside it answer
    /// for this operation. See [`Self::is_cancelled`].
    pub async fn run<F: std::future::Future>(
        &self,
        operation: LobbyOperation,
        work: F,
    ) -> F::Output {
        SCOPED_OPERATION.scope(operation, work).await
    }

    /// The launcher's "new work starts uncancelled".
    ///
    /// Inside [`Self::run`] there is nothing to do: the operation was begun
    /// fresh by whoever started it, and beginning another here would
    /// supersede the very work that is about to check it. Outside one, this
    /// begins an operation so the old behaviour holds for any caller that
    /// does not name its operation.
    pub fn clear(&self) {
        if SCOPED_OPERATION.try_with(|_| ()).is_err() {
            self.begin();
        }
    }

    /// Whether the work running here should stop: its operation was called
    /// off or superseded. Outside [`Self::run`], whether the current
    /// operation was called off.
    pub fn is_cancelled(&self) -> bool {
        match SCOPED_OPERATION.try_with(|operation| *operation) {
            Ok(operation) => !self.is_live(operation),
            Err(_) => self.current.load(Ordering::Acquire) & OPERATION_CANCELLED != 0,
        }
    }
}

/// Which game this client is playing, for as long as the process is alive.
///
/// Not in the view state, because nothing on screen reads it: what needs it is
/// the reconnection handshake. When the lobby socket comes back while a game
/// is still running, the server has to be told which game this player belongs
/// to (`restore_game_session`), or it keeps no game connection for them and
/// the ICE adapter has nothing on the other end to talk to. The reference
/// client keeps the same field for the same reason.
///
/// An explicit Disconnect ends the update stream and with it the connect loop,
/// so this cannot live in that loop's locals: it has to outlast the socket
/// that was lost, which is the whole case it exists for.
/// `Arc` because the game-exit watcher is a spawned task that outlives the
/// call that started it, and it is the one that clears this.
#[derive(Debug, Clone)]
pub struct RunningGame(Arc<AtomicI64>);

/// No game. Game ids are positive, so this cannot collide with one -- and it
/// is not zero, which a derived `Default` would have made indistinguishable
/// from a game whose id genuinely is nothing.
const NO_GAME: i64 = -1;

impl Default for RunningGame {
    fn default() -> Self {
        Self(Arc::new(AtomicI64::new(NO_GAME)))
    }
}

impl RunningGame {
    /// The game process is up, playing this game.
    pub fn set(&self, game_id: i32) {
        self.0.store(i64::from(game_id), Ordering::Release);
    }

    /// The game is over, or was never really running.
    pub fn clear(&self) {
        self.0.store(NO_GAME, Ordering::Release);
    }

    /// The game being played, or `None`.
    pub fn id(&self) -> Option<i32> {
        match self.0.load(Ordering::Acquire) {
            id if id <= 0 => None,
            id => i32::try_from(id).ok(),
        }
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

    /// Nothing is running until something is, and "nothing" has to survive a
    /// `Default` rather than reading as game zero.
    #[test]
    fn a_running_game_is_remembered_until_the_game_ends() {
        let running = RunningGame::default();
        assert_eq!(running.id(), None);

        running.set(4242);
        assert_eq!(running.id(), Some(4242));

        // The game-exit watcher holds a clone of this, so the two have to be
        // the same value rather than two copies of it.
        let watcher = running.clone();
        watcher.clear();
        assert_eq!(running.id(), None);
    }

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

    /// The case the eager guard got wrong: a refused second caller must leave
    /// the first one's ownership alone, so a third is refused as well.
    #[test]
    fn a_refused_caller_does_not_release_the_owners_flight() {
        let flight = SingleFlight::default();
        let first = flight.try_acquire().expect("first caller owns the flight");
        assert!(flight.try_acquire().is_none(), "second caller is refused");
        assert!(flight.is_active(), "the refusal left the owner in place");
        assert!(
            flight.try_acquire().is_none(),
            "third caller is refused too"
        );
        drop(first);
        assert!(!flight.is_active());
    }

    /// The reported interleaving at the policy level: join A is called off,
    /// join B starts while A's preparation is still draining. A must stay
    /// stopped, and A's cleanup must not free B's slot.
    #[tokio::test]
    async fn a_cancelled_join_stays_cancelled_after_the_next_one_starts() {
        let operations = LobbyOperations::default();
        let first = operations.try_begin_join().expect("the slot is free");
        assert!(operations.try_begin_join().is_none(), "one join at a time");
        assert!(operations.is_live(first));

        operations.cancel();
        operations.release_any_join();
        let second = operations.try_begin_join().expect("cancel frees the slot");

        assert!(
            !operations.is_live(first),
            "the next join revived the first"
        );
        assert!(operations.is_live(second));
        // The launcher's own check, made from inside each operation's work.
        assert!(
            operations
                .run(first, async { operations.is_cancelled() })
                .await
        );
        assert!(
            !operations
                .run(second, async { operations.is_cancelled() })
                .await
        );

        // The first join's cleanup runs late and must leave the slot alone.
        operations.release_join(first);
        assert!(
            operations.try_begin_join().is_none(),
            "the slot is still held"
        );
        operations.release_join(second);
        assert!(operations.try_begin_join().is_some());
    }

    /// The launcher's `clear` inside a named operation must not supersede the
    /// operation that is about to check it.
    #[tokio::test]
    async fn clear_inside_an_operation_keeps_it_current() {
        let operations = LobbyOperations::default();
        let launch = operations.begin();
        let cancelled = operations
            .run(launch, async {
                operations.clear();
                operations.is_cancelled()
            })
            .await;
        assert!(!cancelled);
        assert!(operations.is_live(launch));
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
