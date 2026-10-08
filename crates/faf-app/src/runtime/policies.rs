//! Named concurrency policies shared by services.
//!
//! Services describe the behavior they need instead of open-coding atomics,
//! memory ordering, and empty mutexes. This keeps the policy auditable in one
//! place and makes a service context field explain whether work is single-flight,
//! latest-response-wins, or serialized.

use std::collections::HashMap;
use std::hash::Hash;
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
/// The boundaries check the id. The work between them is reached through the
/// operation's token ([`Self::called_off`]), raised the moment the operation
/// is called off or superseded: the updater takes it and stops where stopping
/// leaves nothing half written, between two files or while one is still
/// downloading. It never aborts a write, which is how a corrupt entry would
/// get into the content store. Either way the state and the work agree about
/// whether the join is still happening, which is the difference between this
/// and clearing the join state on its own (the note on
/// `DeclineModReplacement`).
#[derive(Debug, Default)]
pub struct LobbyOperations {
    /// Source of ids. Starts at one, so zero always means "none".
    issued: AtomicU64,
    /// The current operation's id shifted left by one, with
    /// [`OPERATION_CANCELLED`] set once it is called off. One word, so that
    /// "is this mine and still wanted" is a single load.
    current: AtomicU64,
    /// The current operation's token, raised when it is called off and when
    /// another operation supersedes it.
    ///
    /// `current` is written only under this lock, so the flag and the token
    /// never disagree: a token handed out for a live operation is raised by
    /// whatever ends that operation.
    called_off: std::sync::Mutex<tokio_util::sync::CancellationToken>,
    /// Which join holds the join slot, and which called-off join the server
    /// may still answer.
    ///
    /// A custom join stays single-flight from the first click until the
    /// server accepts or rejects it. Preparation can take minutes, so a local
    /// component disabled-state alone is not a concurrency boundary.
    ///
    /// One record behind one lock. The operation and its game used to be two
    /// atomics, so a late cleanup could free the slot, a new join take it,
    /// and the cleanup then clear the new join's game. The server's answer to
    /// that join no longer matched anything, and its slot was never freed.
    join: std::sync::Mutex<JoinSlot>,
}

#[derive(Debug, Default)]
struct JoinSlot {
    holder: Option<JoinClaim>,
    /// Games whose join request went out and was then called off, one entry
    /// per request, oldest first. The server answers each anyway, and a
    /// launch order for one must not start a game the user gave up on. Every
    /// entry stays until its answer arrives or the connection ends: keeping
    /// only the latest let a second call-off erase the first, whose launch
    /// then started.
    called_off: Vec<i32>,
}

impl JoinSlot {
    /// The server answered one called-off request for `game_id`: drop the
    /// oldest such entry, and say whether there was one.
    fn take_called_off(&mut self, game_id: i32) -> bool {
        match self.called_off.iter().position(|&game| game == game_id) {
            Some(index) => {
                self.called_off.remove(index);
                true
            }
            None => false,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct JoinClaim {
    operation: LobbyOperation,
    game_id: i32,
    /// The join request went out, so the server will answer this join even
    /// if the user calls it off.
    sent: bool,
}

impl LobbyOperations {
    fn issue(&self) -> LobbyOperation {
        LobbyOperation(self.issued.fetch_add(1, Ordering::AcqRel).wrapping_add(1))
    }

    fn token(&self) -> std::sync::MutexGuard<'_, tokio_util::sync::CancellationToken> {
        self.called_off
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Make `operation` current. The one it replaces is superseded, which
    /// calls its work off as surely as a cancel does.
    fn make_current(&self, operation: LobbyOperation) {
        let mut token = self.token();
        self.current.store(operation.0 << 1, Ordering::Release);
        std::mem::take(&mut *token).cancel();
    }

    /// Start an operation that does not take the join slot (a host request,
    /// a launch order). It supersedes whatever was current.
    pub fn begin(&self) -> LobbyOperation {
        let operation = self.issue();
        self.make_current(operation);
        operation
    }

    fn join_slot(&self) -> std::sync::MutexGuard<'_, JoinSlot> {
        self.join
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Start a custom join, or `None` when another join holds the slot.
    ///
    /// The slot is taken before the operation becomes current, so a refused
    /// duplicate click cannot supersede the join it was refused for.
    pub fn try_begin_join(&self, game_id: i32) -> Option<LobbyOperation> {
        let mut slot = self.join_slot();
        if slot.holder.is_some() {
            return None;
        }
        let operation = self.issue();
        slot.holder = Some(JoinClaim {
            operation,
            game_id,
            sent: false,
        });
        self.make_current(operation);
        Some(operation)
    }

    /// Whether `operation`'s join request may go out now, marking it sent if
    /// so. From here the server answers it even if the user calls it off,
    /// so calling it off has to remember the game.
    ///
    /// One step under the join lock, and the only gate before the send. A
    /// separate "still live?" check followed by a mark left a gap: a cancel
    /// landing between them took the claim, the mark found nothing, and the
    /// request went out anyway with no record that it was called off.
    /// `CancelJoin` calls the operation off before it takes the claim, so a
    /// mark that runs in between sees the operation dead and refuses.
    pub fn try_mark_join_sent(&self, operation: LobbyOperation) -> bool {
        let mut slot = self.join_slot();
        match slot.holder.as_mut() {
            Some(claim) if claim.operation == operation && self.is_live(operation) => {
                claim.sent = true;
                true
            }
            _ => false,
        }
    }

    /// Call off the current operation, whichever it is.
    pub fn cancel(&self) {
        let token = self.token();
        self.current.fetch_or(OPERATION_CANCELLED, Ordering::AcqRel);
        token.cancel();
    }

    /// The token raised when the work running here is called off, by the same
    /// rule as [`Self::is_cancelled`]: inside [`Self::run`], the operation it
    /// runs as; outside one, the current operation.
    ///
    /// For work that stops part-way by itself rather than at the launcher's
    /// boundaries, the updater's file loop above all. Work that was called
    /// off before it asked is handed a token raised already.
    pub fn called_off(&self) -> tokio_util::sync::CancellationToken {
        let token = self.token();
        if self.is_cancelled() {
            let raised = tokio_util::sync::CancellationToken::new();
            raised.cancel();
            return raised;
        }
        token.clone()
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
        let mut slot = self.join_slot();
        if slot
            .holder
            .is_some_and(|claim| claim.operation == operation)
        {
            slot.holder = None;
        }
    }

    /// The user called the join off: free the slot for whatever they pick
    /// next. A join whose request already went out is remembered, because
    /// the server's answer to it is still coming.
    pub fn call_off_join(&self) {
        let mut slot = self.join_slot();
        if let Some(claim) = slot.holder.take() {
            if claim.sent {
                slot.called_off.push(claim.game_id);
            }
        }
    }

    /// Forget every join: the connection they were sent on is gone, or the
    /// game they led to was taken down. The server forgets them as well.
    pub fn release_any_join(&self) {
        *self.join_slot() = JoinSlot::default();
    }

    /// The server answered about game_id: release the slot if the join in
    /// it is for that game, and say whether it was.
    ///
    /// An answer about another game is a late one for a join the user has
    /// since called off. It used to release whatever join held the slot and
    /// put its failure on screen over the newer join. A server message that
    /// names no game (id zero) cannot be matched, so it keeps the old behaviour.
    ///
    /// Matching and releasing happen under one lock, so the join the answer
    /// was matched against is the one it releases.
    ///
    /// The server answers requests in the order they were sent, and a
    /// called-off request for this game went out before the current join's.
    /// So an answer for a game with one outstanding is that one's, even when
    /// the current join is a retry of the same game: a refusal for the first
    /// attempt (a wrong password, say) used to end the corrected retry.
    pub fn release_join_for_game(&self, game_id: i32) -> bool {
        let mut slot = self.join_slot();
        if game_id != 0 && slot.take_called_off(game_id) {
            return false;
        }
        let ours = game_id == 0 || slot.holder.is_some_and(|claim| claim.game_id == game_id);
        if ours {
            slot.holder = None;
        }
        ours
    }

    /// A launch order for game_id was carried out: the join waiting for this
    /// game has what it wanted, so it gives up the slot.
    ///
    /// Never consumes a called-off record. The launch order already took its
    /// own in [`Self::take_called_off_launch`]; any left belong to requests
    /// whose answers are still coming. This used to share
    /// [`Self::release_join_for_game`] with refusals, so after two called-off
    /// attempts and a retry of one game, the launch took the second attempt's
    /// record and kept the slot; that attempt's refusal then matched the
    /// retry and put "failed" over the game that had launched.
    pub fn release_join_launched(&self, game_id: i32) {
        let mut slot = self.join_slot();
        if slot.holder.is_some_and(|claim| claim.game_id == game_id) {
            slot.holder = None;
        }
    }

    /// A launch order for game_id arrived: whether it answers a join the
    /// user called off after its request went out, and so must not start.
    /// Host and matchmaker launches are never in that record. A user who
    /// called a game off and then joined it again wants it after all.
    pub fn take_called_off_launch(&self, game_id: i32) -> bool {
        let mut slot = self.join_slot();
        slot.take_called_off(game_id) && slot.holder.is_none_or(|claim| claim.game_id != game_id)
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

/// Answer ordering for reads that overlap on purpose: no answer may replace a
/// newer one about the same thing, and none is dropped only because another
/// read started.
///
/// [`LatestRequest`] keeps the answer to the request made last and drops the
/// rest, which suits a selection: once another event is open, the one before
/// it is worth nothing. It does not suit reads that are all equally wanted and
/// differ only in age, like a chat room's poll and the re-read after a post.
/// Under a generation, polls sent faster than the server answers would never
/// land at all, and a poll that does not take one lands whenever it arrives,
/// over a newer answer.
///
/// So every read takes a ticket when it asks, and its answer lands unless an
/// answer from a later ticket, for the same key, has landed already. Answers
/// only move forward. A read that asks after a write has returned takes a
/// later ticket than every read sent before it, so a write's own re-read is
/// never replaced by one of those.
#[derive(Debug)]
pub struct NewestAnswer<K> {
    next: AtomicU64,
    landed: std::sync::Mutex<HashMap<K, u64>>,
}

impl<K> Default for NewestAnswer<K> {
    fn default() -> Self {
        Self {
            next: AtomicU64::new(0),
            landed: std::sync::Mutex::new(HashMap::new()),
        }
    }
}

impl<K: Eq + Hash> NewestAnswer<K> {
    /// The ticket of a read that is about to ask. Take it immediately before
    /// the request, not when the command arrives: what orders two answers is
    /// what the server knew when each was asked.
    pub fn ticket(&self) -> u64 {
        self.next.fetch_add(1, Ordering::AcqRel).wrapping_add(1)
    }

    /// Land the answer of the read holding `ticket` for `key`: run `emit` and
    /// record the ticket, unless a later ticket's answer has landed for `key`.
    ///
    /// `emit` says whether it emitted anything. Only then is the ticket
    /// recorded, so an answer the caller chose to drop does not keep an older
    /// one out. It runs under the lock: two answers checked one after the other
    /// but emitted the other way round is the very overtaking this prevents.
    /// `emit` must not call back into this value.
    pub fn land(&self, key: K, ticket: u64, emit: impl FnOnce() -> bool) -> bool {
        let mut landed = self
            .landed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if landed.get(&key).is_some_and(|newest| *newest >= ticket) {
            return false;
        }
        if !emit() {
            return false;
        }
        landed.insert(key, ticket);
        true
    }
}

/// Background work a cancel command can reach: what is running, under which
/// key, and the token that calls each one off.
///
/// The service races the work against [`CancelTicket::called_off`], so a
/// cancel drops the port's future (or, where the port takes the token, raises
/// it), and settles under its own ticket afterwards. Each run has its own
/// ticket, so a run that settles late can only forget itself, never a newer
/// run of the same key, and a cancel aimed at one key never stops another.
#[derive(Debug)]
pub struct Cancellable<K> {
    next: AtomicU64,
    running: std::sync::Mutex<Vec<(u64, K, tokio_util::sync::CancellationToken)>>,
}

impl<K> Default for Cancellable<K> {
    fn default() -> Self {
        Self {
            next: AtomicU64::new(0),
            running: std::sync::Mutex::new(Vec::new()),
        }
    }
}

/// One run registered with a [`Cancellable`].
#[derive(Debug)]
pub struct CancelTicket {
    id: u64,
    pub called_off: tokio_util::sync::CancellationToken,
}

impl<K> Cancellable<K> {
    fn running(
        &self,
    ) -> std::sync::MutexGuard<'_, Vec<(u64, K, tokio_util::sync::CancellationToken)>> {
        self.running
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Register a run under `key`, so a cancel for that key reaches it.
    pub fn begin(&self, key: K) -> CancelTicket {
        let id = self.next.fetch_add(1, Ordering::AcqRel);
        let called_off = tokio_util::sync::CancellationToken::new();
        self.running().push((id, key, called_off.clone()));
        CancelTicket { id, called_off }
    }

    /// The run holding `ticket` has settled: a cancel no longer reaches it.
    pub fn end(&self, ticket: &CancelTicket) {
        self.running().retain(|(id, _, _)| *id != ticket.id);
    }

    /// Call off every run whose key `matches`, and say whether there was one.
    pub fn cancel(&self, matches: impl Fn(&K) -> bool) -> bool {
        let running = self.running();
        let mut any = false;
        for (_, key, called_off) in running.iter() {
            if matches(key) {
                called_off.cancel();
                any = true;
            }
        }
        any
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
        let first = operations.try_begin_join(1).expect("the slot is free");
        assert!(operations.try_begin_join(1).is_none(), "one join at a time");
        assert!(operations.is_live(first));

        operations.cancel();
        operations.release_any_join();
        let second = operations.try_begin_join(1).expect("cancel frees the slot");

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
            operations.try_begin_join(1).is_none(),
            "the slot is still held"
        );
        operations.release_join(second);
        assert!(operations.try_begin_join(1).is_some());
    }

    /// A late cleanup for join A runs after B took the slot. It must leave
    /// B's claim whole, so the server's answer about B still releases it.
    #[test]
    fn a_late_cleanup_leaves_the_next_joins_game_alone() {
        let operations = LobbyOperations::default();
        let first = operations.try_begin_join(1).expect("the slot is free");
        operations.call_off_join();
        operations.try_begin_join(2).expect("calling off frees it");

        operations.release_join(first);
        assert!(
            !operations.release_join_for_game(1),
            "A's answer is not B's"
        );
        assert!(operations.try_begin_join(3).is_none(), "B still holds it");
        assert!(operations.release_join_for_game(2), "B's answer is B's");
        assert!(operations.try_begin_join(3).is_some());
    }

    /// Only a join whose request went out is answered by the server, so only
    /// that one's launch order is turned away, and only once.
    #[test]
    fn a_launch_for_a_join_called_off_after_its_request_is_turned_away() {
        let operations = LobbyOperations::default();
        operations.try_begin_join(1).expect("the slot is free");
        operations.call_off_join();
        assert!(
            !operations.take_called_off_launch(1),
            "never sent, so the server has nothing to answer"
        );

        let sent = operations.try_begin_join(1).expect("the slot is free");
        assert!(operations.try_mark_join_sent(sent));
        operations.call_off_join();
        operations.try_begin_join(2).expect("calling off frees it");
        assert!(!operations.take_called_off_launch(2), "B's launch is B's");
        assert!(operations.take_called_off_launch(1));
        assert!(!operations.take_called_off_launch(1), "turned away once");
    }

    /// Two joins sent and called off in turn: both are remembered, so the
    /// first one's late launch is still turned away.
    #[test]
    fn every_called_off_join_is_remembered_until_answered() {
        let operations = LobbyOperations::default();
        for game in [1, 2] {
            let join = operations.try_begin_join(game).expect("the slot is free");
            assert!(operations.try_mark_join_sent(join));
            operations.call_off_join();
        }
        assert!(
            operations.take_called_off_launch(1),
            "B's call-off erased A's"
        );
        assert!(
            !operations.release_join_for_game(2),
            "B's refusal is not ours"
        );
        assert!(!operations.take_called_off_launch(2), "and it answered B");
    }

    /// A cancel that lands before the request goes out stops it: the mark is
    /// refused, so nothing is sent without a record.
    #[test]
    fn a_join_called_off_before_its_request_may_not_send() {
        let operations = LobbyOperations::default();
        let join = operations.try_begin_join(1).expect("the slot is free");
        // `CancelJoin`'s first step, with the claim not yet taken.
        operations.cancel();
        assert!(!operations.try_mark_join_sent(join));
        operations.call_off_join();
        assert!(
            !operations.try_mark_join_sent(join),
            "nor after the claim is gone"
        );
        assert!(!operations.take_called_off_launch(1), "nothing was sent");
    }

    /// Join with the wrong password, call it off, retry the same game with
    /// the right one. The refusal for the first attempt is that attempt's:
    /// it must not end the retry, whose own answer still releases it.
    #[test]
    fn a_refusal_for_a_called_off_attempt_leaves_a_retry_of_the_same_game() {
        let operations = LobbyOperations::default();
        let first = operations.try_begin_join(1).expect("the slot is free");
        assert!(operations.try_mark_join_sent(first));
        operations.call_off_join();
        let retry = operations.try_begin_join(1).expect("calling off frees it");
        assert!(operations.try_mark_join_sent(retry));

        assert!(
            !operations.release_join_for_game(1),
            "the first attempt's refusal ended the retry"
        );
        assert!(
            operations.try_begin_join(2).is_none(),
            "the retry still holds it"
        );
        assert!(
            operations.release_join_for_game(1),
            "the retry's own answer"
        );
        assert!(operations.try_begin_join(2).is_some());
    }

    /// Two attempts at one game sent and called off, then a retry. The first
    /// attempt's launch is carried out for the retry; the second attempt's
    /// refusal is that attempt's, and must not touch the launched game.
    #[test]
    fn a_launch_for_a_retry_leaves_the_other_attempts_records() {
        let operations = LobbyOperations::default();
        for _ in 0..2 {
            let attempt = operations.try_begin_join(1).expect("the slot is free");
            assert!(operations.try_mark_join_sent(attempt));
            operations.call_off_join();
        }
        let retry = operations.try_begin_join(1).expect("calling off frees it");
        assert!(operations.try_mark_join_sent(retry));

        assert!(!operations.take_called_off_launch(1), "the retry wants it");
        operations.release_join_launched(1);
        assert!(
            !operations.release_join_for_game(1),
            "the second attempt's refusal was taken for the launched retry"
        );
        assert!(!operations.release_join_for_game(1), "the slot is free");
        assert!(operations.try_begin_join(2).is_some());
    }

    /// Joining the called-off game again means the user wants it after all.
    #[test]
    fn a_called_off_game_joined_again_is_launched() {
        let operations = LobbyOperations::default();
        let sent = operations.try_begin_join(1).expect("the slot is free");
        assert!(operations.try_mark_join_sent(sent));
        operations.call_off_join();
        operations.try_begin_join(1).expect("calling off frees it");
        assert!(!operations.take_called_off_launch(1));
    }

    /// The token reaches the work at once, whichever way its operation ends:
    /// called off, or superseded by the next one. Work that asks for its token
    /// after it was called off is handed one raised already.
    #[tokio::test]
    async fn an_operations_token_is_raised_when_it_is_called_off_or_superseded() {
        let operations = LobbyOperations::default();
        let join = operations.try_begin_join(1).expect("the slot is free");
        let joining = operations
            .run(join, async { operations.called_off() })
            .await;
        assert!(!joining.is_cancelled());
        operations.cancel();
        assert!(joining.is_cancelled(), "a cancel did not reach the work");
        assert!(
            operations
                .run(join, async { operations.called_off() })
                .await
                .is_cancelled(),
            "work called off before it asked was handed a live token"
        );

        operations.call_off_join();
        let host = operations.begin();
        let hosting = operations
            .run(host, async { operations.called_off() })
            .await;
        assert!(
            !hosting.is_cancelled(),
            "the next operation began called off"
        );
        let launch = operations.begin();
        assert!(
            hosting.is_cancelled(),
            "a superseded operation's work was not called off"
        );
        assert!(!operations
            .run(launch, async { operations.called_off() })
            .await
            .is_cancelled());
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

    /// Answers arriving in any order: one older than an answer already landed
    /// for its key is dropped, one newer lands, and keys do not hold each
    /// other up.
    #[test]
    fn a_newest_answer_is_never_replaced_by_an_older_one_for_the_same_key() {
        let answers = NewestAnswer::default();
        let (older, newer) = (answers.ticket(), answers.ticket());
        let elsewhere = answers.ticket();
        let mut shown = Vec::new();

        assert!(answers.land("room", newer, || {
            shown.push("newer");
            true
        }));
        assert!(!answers.land("room", older, || {
            shown.push("older");
            true
        }));
        // Another key's answer is its own, however old its ticket.
        assert!(answers.land("other room", older, || true));
        assert!(answers.land("other room", elsewhere, || true));
        assert_eq!(shown, ["newer"]);

        // An answer the caller declined does not count as landed, so it keeps
        // nothing out.
        let declined = answers.ticket();
        let after = answers.ticket();
        assert!(!answers.land("third", after, || false));
        assert!(answers.land("third", declined, || true));
    }

    /// The reason it is not a generation: a read that started while another
    /// was out still lands if it is the newest to arrive, and the older one
    /// lands too when it is first.
    #[test]
    fn starting_a_read_drops_nothing_that_is_still_newest_to_arrive() {
        let answers = NewestAnswer::default();
        let first = answers.ticket();
        let second = answers.ticket();
        assert!(answers.land((), first, || true), "first to arrive lands");
        assert!(answers.land((), second, || true), "and the newer after it");
    }

    /// A cancel reaches the runs of its key and no other, and a run that has
    /// settled is out of reach: a late cancel cannot stop the next run of the
    /// same key, which holds a ticket of its own.
    #[test]
    fn a_cancel_reaches_only_the_running_work_of_its_key() {
        let work = Cancellable::default();
        let first = work.begin("a.v0001");
        let other = work.begin("b.v0001");

        assert!(work.cancel(|key| *key == "a.v0001"));
        assert!(first.called_off.is_cancelled());
        assert!(!other.called_off.is_cancelled());

        work.end(&first);
        let next = work.begin("a.v0001");
        work.end(&first);
        assert!(!next.called_off.is_cancelled());
        assert!(
            work.cancel(|key| *key == "a.v0001"),
            "the late end of the first left the second registered"
        );
        assert!(next.called_off.is_cancelled());

        work.end(&next);
        work.end(&other);
        assert!(!work.cancel(|_| true), "nothing is running");
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
