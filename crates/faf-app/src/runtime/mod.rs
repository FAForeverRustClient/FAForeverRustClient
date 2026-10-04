//! The runtime loop: command in → service → event out → reduce → broadcast.
//!
//! This is the closed unidirectional loop from ARCHITECTURE.md §1/§3.5. It owns the
//! authoritative [`AppState`] and is the only thing that calls [`faf_domain::reduce`].
//!
//! [`App::new`] returns a handle plus an [`AppLoop`]; the caller decides how to drive
//! it ([`tokio::spawn`] in tests, `tauri::async_runtime::spawn` in the shell). This
//! keeps the runtime free of any hard dependency on a particular executor.

use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};

use faf_domain::{AppCommand, AppEvent, AppState};
use serde::Serialize;
use tokio::sync::{broadcast, mpsc, oneshot, OwnedSemaphorePermit, Semaphore};

use crate::ports::Ports;
use crate::services;

mod policies;
pub use policies::{
    AutoReconnect, LatestRequest, LoadedFromDisk, LobbyOperation, LobbyOperations, RunningGame,
    SerialMutation, SingleFlight,
};

/// Read-only context handed to every service: shared dependencies.
///
/// Holds the [`Ports`] bundle (network, fs, process, auth…) injected at startup.
pub struct ServiceCtx {
    pub backend_version: String,
    pub ports: Ports,
    /// Single-flight guard for the lobby connection while `Connect` owns an
    /// active/connecting socket. A redundant request is dropped, so overlapping
    /// connections cannot race and clobber each other's state.
    pub lobby_active: SingleFlight,
    /// The lobby's joins, hosts and launch orders: which one is current,
    /// whether it was called off, and which join holds the single-flight join
    /// slot. See [`LobbyOperations`].
    ///
    /// Named for the question the launcher asks of it (`is_cancelled`), which
    /// is why it is not called `lobby_operations`; renaming it means renaming
    /// the launcher's reads in the same change.
    pub lobby_operations: LobbyOperations,
    /// Which match the match-start watchdog was armed for. A timer for a
    /// match that was cancelled must not call off the next one found on the
    /// same queue; see `services::lobby::watch_for_match_start`.
    pub lobby_match_generation: LatestRequest,
    /// The title of the game this client last asked the server to host, so
    /// the launch order that answers it starts on the hosting preference.
    /// Taken by that launch; see `launcher::launch`.
    pub hosted_title: std::sync::Mutex<Option<String>>,
    /// The game this client is currently playing, if any. Read when the lobby
    /// socket comes back, so the server can be told to restore the game
    /// session it dropped along with the connection.
    pub running_game: RunningGame,
    /// Same single-flight guard, for the chat connection.
    pub chat_active: SingleFlight,
    /// Whether [`services::reconnect`] should bring these sockets back after
    /// an unexpected drop, so a user who hung up stays hung up while a laptop
    /// resume does not.
    pub lobby_auto_reconnect: AutoReconnect,
    pub chat_auto_reconnect: AutoReconnect,
    /// Generations cancel stale player-card requests when users rapidly switch players/queues.
    pub player_card_profile_generation: LatestRequest,
    pub player_card_matchmaker_generation: LatestRequest,
    pub player_card_map_stats_generation: LatestRequest,
    pub player_card_history_generation: LatestRequest,
    /// Party placement lookups run one at a time. The panel sends the whole
    /// party on every change, and the service skips ids it already knows, so
    /// serialising them is what turns "already known" into "asked once": two
    /// overlapping lookups would both find the map empty and both fetch.
    pub party_placements_mutation: SerialMutation,
    /// Global single-flight guards for operations whose adapters use a shared
    /// temporary file or whose state machine only represents one operation.
    pub uploads_active: SingleFlight,
    pub client_update_active: SingleFlight,
    /// One Galactic War install at a time: concurrent runs would share a
    /// staging directory and race to write the same manifest.
    pub galactic_war_active: SingleFlight,
    /// Settings commands run concurrently. Serializing the snapshot + write
    /// prevents an older command from reaching disk after a newer one.
    pub settings_persist: SerialMutation,
    /// Held across one settings command's read, merge and emit. Commands run
    /// on their own tasks, so two patches could both read the group before
    /// either emitted, and the second would carry the first's field back to
    /// its old value. Synchronous: nothing in between awaits.
    pub settings_merge: std::sync::Mutex<()>,
    /// Added sounds whose removal is under way. A notifications change that
    /// would newly choose one is refused, so a dropdown that still lists it
    /// cannot leave a saved setting naming a file about to be deleted.
    pub sounds_being_removed: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Whether the settings file has been read yet. Nothing may be persisted
    /// before it has, or a preference set during startup writes a document
    /// made of defaults over the user's own.
    pub settings_loaded: LoadedFromDisk,
    /// When a composing notice was last sent per channel, so the composer can
    /// report on every keystroke while the wire sees one line every few
    /// seconds.
    pub chat_typing_sent: std::sync::Mutex<std::collections::HashMap<String, u32>>,
    /// Read markers can change on every channel click. Only the last click in
    /// a short burst writes settings, while state updates remain immediate.
    pub chat_read_marker_persist_generation: LatestRequest,
    /// Generations discard replies from superseded leaderboard and co-op
    /// requests. The runtime intentionally executes commands concurrently, so
    /// request order is not response order.
    pub leaderboard_catalog_generation: LatestRequest,
    pub leaderboard_ratings_generation: LatestRequest,
    pub leaderboard_seasons_generation: LatestRequest,
    pub leaderboard_season_generation: LatestRequest,
    pub coop_catalog_generation: LatestRequest,
    pub coop_leaderboard_generation: LatestRequest,
    pub auth_generation: LatestRequest,
    pub auth_cancellation: std::sync::Mutex<Option<tokio_util::sync::CancellationToken>>,
    pub reviews_generation: LatestRequest,
    pub reporting_generation: LatestRequest,
    /// Whether this session has compared the matchmaker map pools with the
    /// ones last seen (#406). Once per run: pools change between releases,
    /// not between reconnects.
    pub map_pools_checked: std::sync::atomic::AtomicBool,
    pub replay_vault_generation: LatestRequest,
    pub replay_local_generation: LatestRequest,
    /// The in-flight replay launch, so the overlay's Cancel button has
    /// something to press. Same shape as `auth_cancellation`, and for the same
    /// reason: dropping the future is the only thing that actually stops work
    /// that is several awaits deep inside a port.
    pub replay_cancellation: std::sync::Mutex<Option<tokio_util::sync::CancellationToken>>,
    pub map_generator_active: SingleFlight,
    pub tutorial_launch_active: SingleFlight,
    /// The changelog tab re-mounts on every visit and asks for the index each
    /// time. Without this, two quick visits both read a not-ready status and
    /// both fetch the same index: the check on `ChangelogStatus::Ready` is a
    /// check-then-act, and commands run concurrently.
    pub changelog_active: SingleFlight,
    /// One crawl of the whole map vault at a time. The service's "already
    /// loading or loaded" check is a check-then-act, and commands run
    /// concurrently: several views ask for the vault as they mount, and two
    /// asking together both read a status that was not yet `Loading` and
    /// both crawled every page.
    pub map_vault_active: SingleFlight,
    /// Only the newest note may land. Clicking two releases in a row must not
    /// leave the first one's text on screen because it answered second, and a
    /// cached selection must not be overwritten by a slower earlier fetch.
    pub changelog_entry_generation: LatestRequest,
    /// A GitHub device-flow login polls for minutes. Pressing the button twice
    /// must not leave two loops polling, because the second code would silently
    /// invalidate the one on screen.
    pub guides_login_active: SingleFlight,
    /// Accepting and rejecting go one at a time. Two accepts would each read
    /// the catalogue, each patch their own copy, and one would be refused by
    /// the content hash; serialising means it never gets that far.
    pub guides_verdict: SerialMutation,
    /// Only the newest queue answer may land: every verdict reloads the queue,
    /// so an older response arriving late would restore rows already decided.
    pub guides_queue_generation: LatestRequest,
    pub maps_mutation: SerialMutation,
    pub mods_mutation: SerialMutation,
    /// Only the newest vault search may land. A slow earlier query answering
    /// after a fast later one would otherwise replace its page, its totals or
    /// its error with results for filters no longer on screen.
    pub map_search_generation: LatestRequest,
    pub mod_search_generation: LatestRequest,
    pub auth_mutation: SerialMutation,
    /// Player and organiser writes go one at a time. The server recomputes the
    /// bracket on every confirmed result, so two overlapping reports would each
    /// be answered against a bracket the other has already moved.
    pub tourney_mutation: SerialMutation,
    /// Clan writes go one at a time, and each ends by reloading. Two
    /// overlapping edits would otherwise reload in response order rather than
    /// command order and leave the older answer standing.
    pub clan_mutation: SerialMutation,
    /// Only the newest invite-field answer may land: the field searches per
    /// keystroke, and an earlier prefix arriving late would replace the list
    /// with matches for something no longer typed.
    pub clan_candidate_generation: LatestRequest,
    /// Only the newest detail response may land: opening three events in a row
    /// must not leave the first one's bracket on screen because it answered
    /// last.
    pub tourney_detail_generation: LatestRequest,
    /// The same, for reading a chat room.
    pub tourney_chat_generation: LatestRequest,
    /// The same, for the organiser's account search: it fires per keystroke, so
    /// answers overtaking each other is the normal case rather than the rare one.
    pub tourney_account_search_generation: LatestRequest,
    /// The same, for the entry-eligibility check. Moving to another event
    /// invalidates it as well, so a verdict about the event just left cannot
    /// land under the one now open.
    pub tourney_rating_check_generation: LatestRequest,
    /// The same, for one entrant's ratings table. Asking for another entrant,
    /// or again from FAF, supersedes the answer in flight, and moving to
    /// another event invalidates it like the eligibility check.
    pub tourney_player_ratings_generation: LatestRequest,
    /// The same, for the create form's "Fill from this": only the template
    /// asked for last may fill the form, success or refusal.
    pub tourney_template_generation: LatestRequest,
}

/// The sink a service emits events into.
///
/// `emit` is the single chokepoint where state changes: it reduces the event into
/// the authoritative state and then broadcasts the *same* event to subscribers
/// (the Tauri shell, which forwards it to the frontend).
#[derive(Clone)]
pub struct EventSink {
    state: Arc<RwLock<AppState>>,
    tx: broadcast::Sender<AppEvent>,
    versioned_tx: broadcast::Sender<VersionedEvent>,
    revision: Arc<AtomicU64>,
    /// Serialises delivery, so that revision N is on both channels before
    /// N+1 is handed out. Held by [`EventSink::emit`] across the whole
    /// operation; never taken by a reader. See the note on `emit`.
    send_order: Arc<Mutex<()>>,
}

/// One state delta with the exact authoritative-state revision it produced.
///
/// The ordinary service event stream intentionally stays as [`AppEvent`]. The
/// shell uses this versioned stream to hydrate a webview without either
/// replaying an event already present in its snapshot or dropping an event
/// that raced the snapshot IPC response.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionedEvent {
    pub revision: u64,
    pub event: AppEvent,
}

/// An authoritative state snapshot and the last event revision it contains.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionedSnapshot {
    pub revision: u64,
    pub state: AppState,
}

impl EventSink {
    /// Reduce an event into the authoritative state and broadcast it.
    ///
    /// Two locks, each held for exactly what it protects.
    ///
    /// `send_order` is taken first and held across the whole operation. It is
    /// what keeps revisions in order: without it two concurrent emitters can
    /// interleave and deliver N+1 before N, and the frontend mirror
    /// (`ui/src/ipc/revisionedMirror.ts`) reads any revision gap as corruption
    /// and asks for a fresh snapshot. A snapshot is a few megabytes: the map
    /// vault alone measures ~3.6 MiB of JSON at a realistic 5000-entry
    /// catalogue. No reader ever takes this lock, so holding it costs them
    /// nothing.
    ///
    /// The state write guard is held only across `reduce` and the revision
    /// bump, which is the shortest window that still leaves the two consistent
    /// for [`Self::versioned_snapshot`]: a reader must never see state that has
    /// already absorbed event N while being told the newest revision is N-1,
    /// or it would apply N a second time. Broadcasting happens after that guard
    /// is dropped, so a `with_state` reader is no longer blocked behind two
    /// channel sends. That was the review's point, and this is the version of
    /// it that does not reorder revisions.
    pub fn emit(&self, event: impl Into<AppEvent>) {
        let event = event.into();
        let _delivery = self
            .send_order
            .lock()
            .expect("event delivery lock poisoned");
        let revision = {
            let mut guard = self.state.write().expect("app state lock poisoned");
            faf_domain::reduce(&mut guard, &event);
            self.revision
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                .wrapping_add(1)
        };
        // Err only means "no subscribers yet": fine to ignore. The clone is
        // skipped when nobody is listening on the plain stream, because some
        // events carry the whole player directory and this would otherwise
        // deep copy it for a channel with no receiver.
        if self.tx.receiver_count() > 0 {
            let _ = self.tx.send(event.clone());
        }
        let _ = self.versioned_tx.send(VersionedEvent { revision, event });
    }

    /// A snapshot of the authoritative state, for a test that wants to read
    /// the whole thing back after an `emit`.
    ///
    /// Not for services: every one of them uses [`Self::with_state`], which
    /// copies out the one slice it needs instead of cloning a state whose map
    /// catalogue alone is megabytes. The doc here used to point at "IPC
    /// hydration boundaries", and that boundary goes through
    /// `App::versioned_snapshot`, not through the sink.
    #[cfg(test)]
    pub fn snapshot(&self) -> AppState {
        self.state.read().expect("app state lock poisoned").clone()
    }

    /// Read a projection of the authoritative state without cloning unrelated
    /// slices. The closure executes while the read lock is held, so callers
    /// must copy out what they need and must not block or perform IO inside it.
    ///
    /// Prefer this for service decisions and persistence of a single slice;
    /// [`Self::snapshot`] remains appropriate at IPC hydration boundaries.
    pub fn with_state<T>(&self, read: impl FnOnce(&AppState) -> T) -> T {
        let state = self.state.read().expect("app state lock poisoned");
        read(&state)
    }

    /// Observe the same event stream the shell forwards to the frontend.
    ///
    /// For the rare service that is driven by state rather than by a command,
    /// Discord Rich Presence is one: nothing *asks* for a status update, it is
    /// a consequence of joining or leaving a game. Read-only, like
    /// [`Self::snapshot`]: an observer reacts, and any state change it causes
    /// still goes back through [`Self::emit`].
    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.tx.subscribe()
    }
}

/// Handle to the application core. Created once, shared (behind `Arc`) by the shell.
pub struct App {
    state: Arc<RwLock<AppState>>,
    cmd_tx: mpsc::Sender<QueuedCommand>,
    /// Commands that call work off, kept apart so they never queue behind it.
    /// See [`is_urgent`].
    urgent_tx: mpsc::Sender<QueuedCommand>,
    /// See [`ReleaseOrder`].
    order: Arc<ReleaseOrder>,
    event_tx: broadcast::Sender<AppEvent>,
    versioned_event_tx: broadcast::Sender<VersionedEvent>,
    revision: Arc<AtomicU64>,
}

/// The command-processing loop. Spawn `run()` on any async runtime.
pub struct AppLoop {
    cmd_rx: mpsc::Receiver<QueuedCommand>,
    urgent_rx: mpsc::Receiver<QueuedCommand>,
    order: Arc<ReleaseOrder>,
    ctx: ServiceCtx,
    sink: EventSink,
}

struct QueuedCommand {
    command: AppCommand,
    completion: Option<oneshot::Sender<()>>,
    /// When it was dispatched, from [`ReleaseOrder::stamp`].
    seq: u64,
    /// When it entered the queue, for the late-start warning in
    /// [`spawn_command`].
    queued_at: std::time::Instant,
}

/// Which half of a start/stop pair a command is, and what the pair acts on.
#[derive(Debug, PartialEq, Eq)]
enum PairHalf {
    Start(String),
    Release(String),
}

/// The pair a command belongs to, if any.
///
/// Releases travel in the urgent queue (see [`is_urgent`]) and starts in the
/// ordinary one, so a release can overtake a start that was sent before it.
/// Without this, "Play" then "Stop" under load ran the stop first and the
/// start last, leaving the player queued after they had pressed Stop. The key
/// names what both halves act on, so only a release of the same thing counts.
fn pair_of(command: &AppCommand) -> Option<PairHalf> {
    use faf_domain::state::{
        AuthCommand, ChatCommand, GuidesCommand, LobbyCommand, MapGeneratorCommand, ReplayCommand,
    };
    let start = |key: &str| Some(PairHalf::Start(key.to_owned()));
    let release = |key: &str| Some(PairHalf::Release(key.to_owned()));
    match command {
        AppCommand::Lobby(LobbyCommand::Join { .. } | LobbyCommand::Host { .. }) => start("join"),
        AppCommand::Lobby(LobbyCommand::CancelJoin | LobbyCommand::DeclineModReplacement) => {
            release("join")
        }
        AppCommand::Lobby(LobbyCommand::Connect) => start("lobby"),
        AppCommand::Lobby(LobbyCommand::Disconnect) => release("lobby"),
        AppCommand::Lobby(LobbyCommand::Matchmake {
            queue_name,
            start: true,
        }) => Some(PairHalf::Start(format!("matchmake:{queue_name}"))),
        AppCommand::Lobby(LobbyCommand::Matchmake {
            queue_name,
            start: false,
        }) => Some(PairHalf::Release(format!("matchmake:{queue_name}"))),
        AppCommand::Chat(ChatCommand::Connect { .. }) => start("chat"),
        AppCommand::Chat(ChatCommand::Disconnect) => release("chat"),
        AppCommand::Auth(
            AuthCommand::Login { .. } | AuthCommand::LoginTest | AuthCommand::Restore,
        ) => start("auth"),
        AppCommand::Auth(
            AuthCommand::CancelLogin | AuthCommand::Logout | AuthCommand::LogoutTest,
        ) => release("auth"),
        AppCommand::Guides(GuidesCommand::SignIn) => start("guides"),
        AppCommand::Guides(GuidesCommand::CancelSignIn) => release("guides"),
        AppCommand::MapGenerator(
            MapGeneratorCommand::Generate { .. } | MapGeneratorCommand::GenerateNamed { .. },
        ) => start("map-generator"),
        AppCommand::MapGenerator(MapGeneratorCommand::Cancel) => release("map-generator"),
        AppCommand::Replays(
            ReplayCommand::WatchVault { .. }
            | ReplayCommand::WatchLive { .. }
            | ReplayCommand::OpenFile { .. },
        ) => start("replay-watch"),
        AppCommand::Replays(ReplayCommand::CancelWatch) => release("replay-watch"),
        AppCommand::Replays(ReplayCommand::TrackLive { .. }) => start("live-tracking"),
        AppCommand::Replays(ReplayCommand::CancelLiveTracking) => release("live-tracking"),
        _ => None,
    }
}

/// Dispatch order, so a start that a later release overtook is dropped.
///
/// Every command is stamped as it is dispatched; a release also records its
/// stamp against its pair. When a start finally leaves the ordinary queue, a
/// release of the same pair stamped after it means the user called it off
/// before it ever ran, and running it now would undo that.
#[derive(Debug, Default)]
struct ReleaseOrder {
    next: AtomicU64,
    released: std::sync::Mutex<std::collections::HashMap<String, u64>>,
}

impl ReleaseOrder {
    fn stamp(&self, command: &AppCommand) -> u64 {
        let seq = self.next.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;
        if let Some(PairHalf::Release(key)) = pair_of(command) {
            self.released
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(key, seq);
        }
        seq
    }

    fn superseded(&self, command: &AppCommand, seq: u64) -> bool {
        let Some(PairHalf::Start(key)) = pair_of(command) else {
            return false;
        };
        self.released
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&key)
            .is_some_and(|&released| released > seq)
    }
}

impl App {
    /// Construct the core and its loop. The caller spawns `loop.run()`.
    pub fn new(backend_version: impl Into<String>, ports: Ports) -> (Self, AppLoop) {
        let state = Arc::new(RwLock::new(AppState::default()));
        let (event_tx, _) = broadcast::channel::<AppEvent>(256);
        // Four times the plain stream's room. A receiver that falls behind on
        // this one does not merely miss events: the mirror reads a revision
        // gap as corruption and asks for a whole `AppState` back, which is
        // megabytes of JSON requested exactly when the client is already
        // behind. Lag here is self-feeding, so the cheapest thing to spend on
        // it is queue.
        let (versioned_event_tx, _) = broadcast::channel::<VersionedEvent>(1024);
        let (cmd_tx, cmd_rx) = mpsc::channel::<QueuedCommand>(COMMAND_QUEUE);
        let (urgent_tx, urgent_rx) = mpsc::channel::<QueuedCommand>(URGENT_QUEUE);
        let revision = Arc::new(AtomicU64::new(0));
        let order = Arc::new(ReleaseOrder::default());
        let send_order = Arc::new(Mutex::new(()));

        let sink = EventSink {
            state: state.clone(),
            tx: event_tx.clone(),
            versioned_tx: versioned_event_tx.clone(),
            revision: revision.clone(),
            send_order: send_order.clone(),
        };
        let ctx = ServiceCtx {
            backend_version: backend_version.into(),
            ports,
            lobby_active: SingleFlight::default(),
            lobby_operations: LobbyOperations::default(),
            lobby_match_generation: LatestRequest::default(),
            hosted_title: std::sync::Mutex::new(None),
            running_game: RunningGame::default(),
            chat_active: SingleFlight::default(),
            lobby_auto_reconnect: AutoReconnect::default(),
            chat_auto_reconnect: AutoReconnect::default(),
            player_card_profile_generation: LatestRequest::default(),
            player_card_matchmaker_generation: LatestRequest::default(),
            player_card_map_stats_generation: LatestRequest::default(),
            player_card_history_generation: LatestRequest::default(),
            party_placements_mutation: SerialMutation::default(),
            uploads_active: SingleFlight::default(),
            client_update_active: SingleFlight::default(),
            galactic_war_active: SingleFlight::default(),
            settings_persist: SerialMutation::default(),
            settings_merge: std::sync::Mutex::new(()),
            sounds_being_removed: std::sync::Mutex::new(std::collections::HashSet::new()),
            settings_loaded: LoadedFromDisk::default(),
            chat_typing_sent: std::sync::Mutex::new(std::collections::HashMap::new()),
            chat_read_marker_persist_generation: LatestRequest::default(),
            leaderboard_catalog_generation: LatestRequest::default(),
            leaderboard_ratings_generation: LatestRequest::default(),
            leaderboard_seasons_generation: LatestRequest::default(),
            leaderboard_season_generation: LatestRequest::default(),
            coop_catalog_generation: LatestRequest::default(),
            coop_leaderboard_generation: LatestRequest::default(),
            auth_generation: LatestRequest::default(),
            auth_cancellation: std::sync::Mutex::new(None),
            reviews_generation: LatestRequest::default(),
            reporting_generation: LatestRequest::default(),
            map_pools_checked: std::sync::atomic::AtomicBool::new(false),
            replay_vault_generation: LatestRequest::default(),
            replay_local_generation: LatestRequest::default(),
            replay_cancellation: std::sync::Mutex::new(None),
            map_generator_active: SingleFlight::default(),
            tutorial_launch_active: SingleFlight::default(),
            changelog_active: SingleFlight::default(),
            map_vault_active: SingleFlight::default(),
            changelog_entry_generation: LatestRequest::default(),
            guides_login_active: SingleFlight::default(),
            guides_verdict: SerialMutation::default(),
            guides_queue_generation: LatestRequest::default(),
            maps_mutation: SerialMutation::default(),
            mods_mutation: SerialMutation::default(),
            map_search_generation: LatestRequest::default(),
            mod_search_generation: LatestRequest::default(),
            auth_mutation: SerialMutation::default(),
            tourney_mutation: SerialMutation::default(),
            clan_mutation: SerialMutation::default(),
            clan_candidate_generation: LatestRequest::default(),
            tourney_detail_generation: LatestRequest::default(),
            tourney_chat_generation: LatestRequest::default(),
            tourney_account_search_generation: LatestRequest::default(),
            tourney_rating_check_generation: LatestRequest::default(),
            tourney_player_ratings_generation: LatestRequest::default(),
            tourney_template_generation: LatestRequest::default(),
        };

        let app = Self {
            state,
            cmd_tx,
            urgent_tx,
            order: order.clone(),
            event_tx,
            versioned_event_tx,
            revision,
        };
        let app_loop = AppLoop {
            cmd_rx,
            urgent_rx,
            order,
            ctx,
            sink,
        };
        (app, app_loop)
    }

    /// Send a command into the loop, applying backpressure when the bounded
    /// queue is busy and reporting a stopped runtime to the caller.
    pub async fn dispatch(&self, cmd: AppCommand) -> Result<(), String> {
        self.queue_for(&cmd)
            .send(QueuedCommand {
                queued_at: std::time::Instant::now(),
                seq: self.order.stamp(&cmd),
                command: cmd,
                completion: None,
            })
            .await
            .map_err(|_| "application command loop is not running".to_string())
    }

    /// Execute a command and wait until its service effect has completed.
    ///
    /// Normal UI commands use [`Self::dispatch`] and remain asynchronous. This
    /// stronger boundary is reserved for startup dependencies such as loading
    /// persisted settings before announcing backend readiness.
    pub async fn dispatch_and_wait(&self, cmd: AppCommand) -> Result<(), String> {
        let (completion, finished) = oneshot::channel();
        self.queue_for(&cmd)
            .send(QueuedCommand {
                queued_at: std::time::Instant::now(),
                seq: self.order.stamp(&cmd),
                command: cmd,
                completion: Some(completion),
            })
            .await
            .map_err(|_| "application command loop is not running".to_string())?;
        finished
            .await
            .map_err(|_| "application command task stopped before completion".to_string())
    }

    /// Send a command without awaiting (for sync call sites like Tauri commands).
    pub fn try_dispatch(&self, cmd: AppCommand) -> Result<(), String> {
        self.queue_for(&cmd)
            .try_send(QueuedCommand {
                queued_at: std::time::Instant::now(),
                seq: self.order.stamp(&cmd),
                command: cmd,
                completion: None,
            })
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => {
                    "application command queue is full".to_string()
                }
                mpsc::error::TrySendError::Closed(_) => {
                    "application command loop is not running".to_string()
                }
            })
    }

    /// The queue a command waits in. Cancellations get their own, so a
    /// saturated ordinary queue cannot hold back the command meant to relieve
    /// it.
    fn queue_for(&self, cmd: &AppCommand) -> &mpsc::Sender<QueuedCommand> {
        if is_urgent(cmd) {
            &self.urgent_tx
        } else {
            &self.cmd_tx
        }
    }

    /// Subscribe to the event stream (the Tauri shell forwards this to the frontend).
    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.event_tx.subscribe()
    }

    /// Atomically subscribe at the event-stream tail and clone the state at
    /// that exact boundary. Events represented by the snapshot precede the
    /// receiver; every later event is queued for it.
    ///
    /// The unversioned twin of [`Self::subscribe_versioned_with_snapshot`],
    /// which is what the shell uses: without a revision the frontend cannot
    /// tell a gap from a quiet moment, so this is kept for the tests that
    /// exercise the subscribe-and-snapshot boundary itself.
    #[cfg(test)]
    pub fn subscribe_with_snapshot(&self) -> (broadcast::Receiver<AppEvent>, AppState) {
        let guard = self.state.read().expect("app state lock poisoned");
        let events = self.event_tx.subscribe();
        let snapshot = guard.clone();
        (events, snapshot)
    }

    /// Atomically subscribe to the shell's revisioned stream and clone the
    /// state at the same boundary. Unlike a plain snapshot followed by a
    /// listener, this protocol is safe when event delivery and IPC responses
    /// are scheduled independently by the webview runtime.
    pub fn subscribe_versioned_with_snapshot(
        &self,
    ) -> (broadcast::Receiver<VersionedEvent>, VersionedSnapshot) {
        let guard = self.state.read().expect("app state lock poisoned");
        let events = self.versioned_event_tx.subscribe();
        let snapshot = VersionedSnapshot {
            revision: self.revision.load(std::sync::atomic::Ordering::Relaxed),
            state: guard.clone(),
        };
        (events, snapshot)
    }

    /// A revisioned snapshot for initial frontend hydration.
    pub fn versioned_snapshot(&self) -> VersionedSnapshot {
        let guard = self.state.read().expect("app state lock poisoned");
        VersionedSnapshot {
            revision: self.revision.load(std::sync::atomic::Ordering::Relaxed),
            state: guard.clone(),
        }
    }

    /// A consistent snapshot of current state (for initial frontend hydration).
    pub fn snapshot(&self) -> AppState {
        self.state.read().expect("app state lock poisoned").clone()
    }

    /// Read one projection of the state without cloning the rest of it.
    ///
    /// The twin of [`EventSink::with_state`], for the shell. Closing the
    /// window used to clone the whole `AppState` to read a single enum out of
    /// `lobby.join`: a few megabytes at a realistic catalogue size, to answer
    /// "is a game running".
    ///
    /// The closure runs under the read lock, so it must copy out what it needs
    /// and must not block or do IO.
    pub fn with_state<T>(&self, read: impl FnOnce(&AppState) -> T) -> T {
        let state = self.state.read().expect("app state lock poisoned");
        read(&state)
    }
}

impl AppLoop {
    /// Drive the loop until all command senders are dropped.
    ///
    /// Each command is handled on its own task so a slow effect (e.g. an
    /// interactive login) never blocks the processing of other commands. Ordering
    /// of *state* changes is still well-defined: every mutation goes through the
    /// single [`EventSink::emit`] chokepoint.
    pub async fn run(self) {
        let ctx = Arc::new(self.ctx);

        // Discord Rich Presence is the one feature no command drives: the
        // status mirrors state, so it observes the event stream instead. It
        // owns its own tasks and never blocks this loop.
        services::discord::spawn(ctx.clone(), self.sink.clone());

        // Likewise state-driven: a socket that dropped while the user is still
        // signed in should come back without them asking.
        services::reconnect::spawn(ctx.clone(), self.sink.clone());

        // And likewise: a calendar reminder is due at a moment, not in answer
        // to anything the user just did.
        services::events::spawn(ctx.clone(), self.sink.clone());

        // And a channel goes live when it goes live. Starts no task at all on a
        // build whose Twitch credentials are absent, which is most of them.
        services::streams::spawn(ctx.clone(), self.sink.clone());

        // And a release is published while the client is running. The check at
        // startup is the one the settings load performs; this is the one that
        // reaches a client nobody has restarted since Friday.
        services::client_update::spawn(ctx.clone(), self.sink.clone());

        let sink = self.sink.clone();
        let handle = move |command: AppCommand| {
            let ctx = ctx.clone();
            let sink = sink.clone();
            async move { dispatch(command, &ctx, &sink).await }
        };
        drive(
            self.cmd_rx,
            self.urgent_rx,
            self.order,
            PRODUCTION_LIMITS,
            handle,
        )
        .await;
    }
}

/// How many ordinary commands may wait in the queue. Once it is full,
/// [`App::dispatch`] waits and [`App::try_dispatch`] reports it.
const COMMAND_QUEUE: usize = 64;

/// The same, for cancellations. Small: these are single clicks.
const URGENT_QUEUE: usize = 16;

/// See [`drive`]. Not a tuning knob: it exists so a runaway dispatcher
/// cannot open a thousand sockets, and is far above any honest workload.
const MAX_CONCURRENT_COMMANDS: usize = 64;

/// Cancellations running at once. Each one only flips a flag or closes a
/// socket, so a handful is plenty; the ceiling exists so that even these
/// cannot pile up without bound.
const MAX_CONCURRENT_URGENT: usize = 8;

/// How much work [`drive`] lets run at once, per queue.
#[derive(Debug, Clone, Copy)]
struct Limits {
    ordinary: usize,
    urgent: usize,
}

const PRODUCTION_LIMITS: Limits = Limits {
    ordinary: MAX_CONCURRENT_COMMANDS,
    urgent: MAX_CONCURRENT_URGENT,
};

/// Commands that call work off rather than start it.
///
/// They get their own queue and their own permits. With one shared pool, a
/// cancel clicked while the pool was full of the very work it was meant to
/// stop waited behind that work, and a stuck join could not be called off
/// until something else finished.
///
/// Matchmaker *stop* is here, *start* is not; the same goes for every pair.
/// Only the half that releases something jumps the queue.
///
/// Navigation is here as well, for the same reason from the other side: a
/// click on a tab only changes what is on screen and never waits on anything,
/// so it must not wait behind the work it is moving away from. The Live tab
/// once filled every ordinary slot with vault lookups, and a click on Online
/// did nothing until they had all come back.
fn is_urgent(command: &AppCommand) -> bool {
    use faf_domain::state::{
        AuthCommand, ChatCommand, GuidesCommand, LobbyCommand, MapGeneratorCommand, ReplayCommand,
    };
    matches!(
        command,
        AppCommand::Nav(_)
            | AppCommand::Lobby(
                LobbyCommand::CancelJoin
                    | LobbyCommand::DeclineModReplacement
                    | LobbyCommand::TerminateGame
                    | LobbyCommand::Disconnect
                    | LobbyCommand::Matchmake { start: false, .. }
            )
            | AppCommand::Auth(AuthCommand::CancelLogin | AuthCommand::Logout)
            | AppCommand::Chat(ChatCommand::Disconnect)
            | AppCommand::Guides(GuidesCommand::CancelSignIn)
            | AppCommand::MapGenerator(MapGeneratorCommand::Cancel)
            | AppCommand::Replays(ReplayCommand::CancelWatch | ReplayCommand::CancelLiveTracking)
    )
}

/// Run commands from both queues until the ordinary one closes.
///
/// A permit is taken *before* a command leaves its queue, not inside the task
/// that runs it. Taking it inside the task bounded how many ran but not how
/// many waited: the loop kept draining the bounded channel into an unbounded
/// pile of spawned tasks, each parked on the semaphore, so the channel's
/// backpressure never reached the caller. Now a saturated pool leaves commands
/// in the channel, the channel fills, and `dispatch` waits.
///
/// Urgent commands are checked first and draw on their own permits, so they
/// are never stuck behind a full ordinary pool or a full ordinary queue.
/// That lets a release overtake its own start, so a start the user has since
/// called off is dropped here rather than run (see [`ReleaseOrder`]).
async fn drive<H, F>(
    mut ordinary: mpsc::Receiver<QueuedCommand>,
    mut urgent: mpsc::Receiver<QueuedCommand>,
    order: Arc<ReleaseOrder>,
    limits: Limits,
    handle: H,
) where
    H: Fn(AppCommand) -> F,
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let ordinary_permits = Arc::new(Semaphore::new(limits.ordinary));
    let urgent_permits = Arc::new(Semaphore::new(limits.urgent));
    let running = Running::default();
    let mut ordinary_permit: Option<OwnedSemaphorePermit> = None;
    let mut urgent_permit: Option<OwnedSemaphorePermit> = None;
    let mut urgent_open = true;

    loop {
        tokio::select! {
            biased;
            acquired = urgent_permits.clone().acquire_owned(),
                if urgent_open && urgent_permit.is_none() =>
            {
                urgent_permit = Some(acquired.expect("the urgent semaphore is never closed"));
            }
            queued = urgent.recv(), if urgent_open && urgent_permit.is_some() => match queued {
                Some(queued) => spawn_command(queued, urgent_permit.take(), &handle, &running),
                None => urgent_open = false,
            },
            acquired = ordinary_permits.clone().acquire_owned(), if ordinary_permit.is_none() => {
                ordinary_permit = Some(acquired.expect("the command semaphore is never closed"));
            }
            queued = ordinary.recv(), if ordinary_permit.is_some() => match queued {
                Some(queued) if order.superseded(&queued.command, queued.seq) => {
                    // Keep the permit for the next command, and still answer
                    // anyone waiting on this one: it is finished, by not running.
                    tracing::debug!(seq = queued.seq, "dropped a start that a later release called off");
                    if let Some(completion) = queued.completion {
                        let _ = completion.send(());
                    }
                }
                Some(queued) => spawn_command(queued, ordinary_permit.take(), &handle, &running),
                None => break,
            },
        }
    }
}

/// How late a command may start before it is logged. A click is a command, so
/// half a second of waiting is already a client that ignored somebody.
const LATE_START: std::time::Duration = std::time::Duration::from_millis(500);

/// The commands running now: a short name and when each started.
///
/// Only read when a command starts late, to say what it waited behind. A tab
/// that would not change for ten seconds left nothing in the log to say why;
/// this names the work that held every slot.
#[derive(Default, Clone)]
struct Running(Arc<std::sync::Mutex<RunningCommands>>);

#[derive(Default)]
struct RunningCommands {
    next: u64,
    commands: std::collections::HashMap<u64, (String, std::time::Instant)>,
}

impl Running {
    fn lock(&self) -> std::sync::MutexGuard<'_, RunningCommands> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn start(&self, name: String) -> u64 {
        let mut running = self.lock();
        running.next += 1;
        let id = running.next;
        running
            .commands
            .insert(id, (name, std::time::Instant::now()));
        id
    }

    fn finish(&self, id: u64) {
        self.lock().commands.remove(&id);
    }

    /// The longest-running few, as "Maps::LoadVault 12.3s".
    fn longest(&self, limit: usize) -> (usize, Vec<String>) {
        let running = self.lock();
        let mut all: Vec<_> = running.commands.values().collect();
        all.sort_by_key(|(_, started)| *started);
        let listed = all
            .iter()
            .take(limit)
            .map(|(name, started)| format!("{name} {:.1}s", started.elapsed().as_secs_f32()))
            .collect();
        (all.len(), listed)
    }
}

/// A command's slice and variant, as "Nav::SelectReplaysSection", without its
/// payload. Read from the `Debug` text, cut off after a few dozen characters
/// so a command carrying a picture costs no more to name than one that does
/// not.
fn command_name(command: &AppCommand) -> String {
    struct Capped(String);
    impl std::fmt::Write for Capped {
        fn write_str(&mut self, text: &str) -> std::fmt::Result {
            let room = 96usize.saturating_sub(self.0.len());
            self.0.extend(text.chars().take(room));
            if self.0.len() >= 96 {
                Err(std::fmt::Error)
            } else {
                Ok(())
            }
        }
    }
    let mut text = Capped(String::new());
    let _ = std::fmt::write(&mut text, format_args!("{command:?}"));
    let text = text.0;
    let (slice, rest) = text.split_once('(').unwrap_or((text.as_str(), ""));
    let variant: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if variant.is_empty() {
        slice.to_string()
    } else {
        format!("{slice}::{variant}")
    }
}

/// Run one command on its own task, holding `permit` until it finishes.
fn spawn_command<H, F>(
    queued: QueuedCommand,
    permit: Option<OwnedSemaphorePermit>,
    handle: &H,
    running: &Running,
) where
    H: Fn(AppCommand) -> F,
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let name = command_name(&queued.command);
    let waited = queued.queued_at.elapsed();
    if waited >= LATE_START {
        let (count, longest) = running.longest(12);
        tracing::warn!(
            command = %name,
            waited_seconds = waited.as_secs_f32(),
            running = count,
            ?longest,
            "a command waited for a free slot before it could start"
        );
    }
    let id = running.start(name);
    let work = handle(queued.command);
    let completion = queued.completion;
    let running = running.clone();
    tokio::spawn(async move {
        let _permit = permit;
        work.await;
        running.finish(id);
        if let Some(completion) = completion {
            let _ = completion.send(());
        }
    });
}

/// Route a command to the owning service. One arm per slice (ARCHITECTURE.md §8).
async fn dispatch(cmd: AppCommand, ctx: &ServiceCtx, sink: &EventSink) {
    match cmd {
        AppCommand::Session(c) => services::session::handle(c, ctx, sink).await,
        AppCommand::Auth(c) => services::auth::handle(c, ctx, sink).await,
        AppCommand::Nav(c) => services::nav::handle(c, ctx, sink).await,
        AppCommand::Events(c) => services::events::handle(c, ctx, sink).await,
        AppCommand::Notifications(c) => services::notifications::handle(c, ctx, sink).await,
        AppCommand::Chat(c) => services::chat::handle(c, ctx, sink).await,
        AppCommand::Coop(c) => services::coop::handle(c, ctx, sink).await,
        AppCommand::Lobby(c) => services::lobby::handle(c, ctx, sink).await,
        AppCommand::Replays(c) => services::replays::handle(c, ctx, sink).await,
        AppCommand::Maps(c) => services::maps::handle(c, ctx, sink).await,
        AppCommand::MapGenerator(c) => services::map_generator::handle(c, ctx, sink).await,
        AppCommand::Mods(c) => services::mods::handle(c, ctx, sink).await,
        AppCommand::Leaderboard(c) => services::leaderboard::handle(c, ctx, sink).await,
        AppCommand::PlayerCard(c) => services::player_card::handle(c, ctx, sink).await,
        AppCommand::Reporting(c) => services::reporting::handle(c, ctx, sink).await,
        AppCommand::Clan(c) => services::clan::handle(c, ctx, sink).await,
        AppCommand::Reviews(c) => services::reviews::handle(c, ctx, sink).await,
        AppCommand::Tourney(c) => services::tourney::handle(c, ctx, sink).await,
        AppCommand::Guides(c) => services::guides::handle(c, ctx, sink).await,
        AppCommand::Training(c) => services::training::handle(c, ctx, sink).await,
        AppCommand::Tutorials(c) => services::tutorials::handle(c, ctx, sink).await,
        AppCommand::Changelog(c) => services::changelog::handle(c, ctx, sink).await,
        AppCommand::Uploads(c) => services::uploads::handle(c, ctx, sink).await,
        AppCommand::GalacticWar(c) => services::galactic_war::handle(c, ctx, sink).await,
        AppCommand::ClientUpdate(c) => services::client_update::handle(c, ctx, sink).await,
        AppCommand::Social(c) => services::social::handle(c, ctx, sink).await,
        AppCommand::Streams(c) => services::streams::handle(c, ctx, sink).await,
        AppCommand::Settings(c) => services::settings::handle(c, ctx, sink).await,
    }
}

#[cfg(test)]
mod tests {
    use faf_domain::state::{ConnectionStatus, SessionCommand, SessionEvent};

    use super::*;

    #[tokio::test]
    async fn dispatch_reports_a_stopped_command_loop() {
        let (app, app_loop) = App::new("test", crate::infra::fake_ports());
        drop(app_loop);

        let error = app
            .dispatch(SessionCommand::Hello.into())
            .await
            .expect_err("a dropped receiver must be reported");

        assert!(error.contains("not running"));
    }

    #[test]
    fn try_dispatch_reports_queue_saturation() {
        let (app, _app_loop) = App::new("test", crate::infra::fake_ports());
        for _ in 0..64 {
            app.try_dispatch(SessionCommand::Hello.into())
                .expect("the configured queue capacity should accept this command");
        }

        let error = app
            .try_dispatch(SessionCommand::Hello.into())
            .expect_err("the next command must observe a full queue");

        assert!(error.contains("full"));

        // A cancellation still gets through: it has a queue of its own.
        app.try_dispatch(faf_domain::state::LobbyCommand::CancelJoin.into())
            .expect("a cancellation must not wait behind a full ordinary queue");
    }

    #[test]
    fn a_command_is_named_by_slice_and_variant_without_its_payload() {
        assert_eq!(
            command_name(&faf_domain::state::MapsCommand::LoadVault.into()),
            "Maps::LoadVault"
        );
        let named = command_name(
            &faf_domain::state::LobbyCommand::Join {
                id: 42,
                password: Some("secret".into()),
                replace_mods: false,
            }
            .into(),
        );
        assert_eq!(named, "Lobby::Join");
    }

    #[test]
    fn only_the_releasing_half_of_a_command_pair_is_urgent() {
        use faf_domain::state::LobbyCommand;

        assert!(is_urgent(&LobbyCommand::CancelJoin.into()));
        assert!(is_urgent(&LobbyCommand::Disconnect.into()));
        assert!(is_urgent(
            &LobbyCommand::Matchmake {
                queue_name: "ladder1v1".into(),
                start: false,
            }
            .into()
        ));
        assert!(!is_urgent(
            &LobbyCommand::Matchmake {
                queue_name: "ladder1v1".into(),
                start: true,
            }
            .into()
        ));
        assert!(!is_urgent(&SessionCommand::Hello.into()));
        // A tab click never waits behind work it is leaving.
        assert!(is_urgent(
            &faf_domain::state::NavCommand::SelectReplaysSection {
                section: faf_domain::state::ReplaysSection::Online,
            }
            .into()
        ));
    }

    /// Saturated work leaves later commands in the channel instead of piling
    /// up as parked tasks, and a cancellation still runs past it.
    #[tokio::test]
    async fn a_saturated_pool_backs_up_into_the_channel_but_not_over_cancellations() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::Duration;

        use faf_domain::state::LobbyCommand;

        let (ordinary_tx, ordinary_rx) = mpsc::channel::<QueuedCommand>(2);
        let (urgent_tx, urgent_rx) = mpsc::channel::<QueuedCommand>(2);
        let started = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(Semaphore::new(0));

        let handle = {
            let started = started.clone();
            let gate = gate.clone();
            move |command: AppCommand| {
                let started = started.clone();
                let gate = gate.clone();
                async move {
                    if !is_urgent(&command) {
                        started.fetch_add(1, Ordering::SeqCst);
                        // Held until the test opens the gate: saturated work.
                        let _ = gate.acquire().await;
                    }
                }
            }
        };
        let limits = Limits {
            ordinary: 2,
            urgent: 1,
        };
        let driver = tokio::spawn(drive(
            ordinary_rx,
            urgent_rx,
            Arc::new(ReleaseOrder::default()),
            limits,
            handle,
        ));

        let queued = |command: AppCommand| QueuedCommand {
            queued_at: std::time::Instant::now(),
            command,
            completion: None,
            seq: 0,
        };
        // Two run, two more wait in the channel, which is then full.
        for _ in 0..4 {
            ordinary_tx
                .send(queued(SessionCommand::Hello.into()))
                .await
                .expect("the loop is running");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            started.load(Ordering::SeqCst),
            2,
            "only the permitted two run"
        );
        assert!(
            matches!(
                ordinary_tx.try_send(queued(SessionCommand::Hello.into())),
                Err(mpsc::error::TrySendError::Full(_))
            ),
            "waiting work stays in the bounded channel"
        );

        let (completion, finished) = oneshot::channel();
        urgent_tx
            .send(QueuedCommand {
                queued_at: std::time::Instant::now(),
                command: LobbyCommand::CancelJoin.into(),
                completion: Some(completion),
                seq: 0,
            })
            .await
            .expect("the loop is running");
        tokio::time::timeout(Duration::from_secs(5), finished)
            .await
            .expect("a cancellation runs while the pool is saturated")
            .expect("the cancellation completed");

        // Releasing the work lets the queued commands through.
        gate.add_permits(16);
        drop(ordinary_tx);
        drop(urgent_tx);
        tokio::time::timeout(Duration::from_secs(5), driver)
            .await
            .expect("the loop ends once its queues close")
            .expect("the loop did not panic");
        // The last two were spawned before the loop ended; give them a moment
        // to start.
        tokio::time::timeout(Duration::from_secs(5), async {
            while started.load(Ordering::SeqCst) < 4 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the queued commands ran once the pool freed up");
    }

    /// "Play" then "Stop" while the pool is busy: the stop overtakes the start
    /// in its own queue, so the start must not run afterwards and requeue the
    /// player. A start sent after the stop still runs.
    #[tokio::test]
    async fn a_start_overtaken_by_its_release_is_dropped() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::Duration;

        use faf_domain::state::LobbyCommand;

        let order = Arc::new(ReleaseOrder::default());
        let matchmake = |start: bool| -> AppCommand {
            LobbyCommand::Matchmake {
                queue_name: "ladder1v1".into(),
                start,
            }
            .into()
        };
        let queued = |command: AppCommand, completion| QueuedCommand {
            queued_at: std::time::Instant::now(),
            seq: order.stamp(&command),
            command,
            completion,
        };

        let (ordinary_tx, ordinary_rx) = mpsc::channel::<QueuedCommand>(4);
        let (urgent_tx, urgent_rx) = mpsc::channel::<QueuedCommand>(4);
        let starts = Arc::new(AtomicUsize::new(0));
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let handle = {
            let (starts, gate) = (starts.clone(), gate.clone());
            move |command: AppCommand| {
                let (starts, gate) = (starts.clone(), gate.clone());
                async move {
                    match command {
                        AppCommand::Session(_) => drop(gate.acquire().await),
                        AppCommand::Lobby(LobbyCommand::Matchmake { start: true, .. }) => {
                            starts.fetch_add(1, Ordering::SeqCst);
                        }
                        _ => {}
                    }
                }
            }
        };
        let limits = Limits {
            ordinary: 1,
            urgent: 1,
        };
        let driver = tokio::spawn(drive(ordinary_rx, urgent_rx, order.clone(), limits, handle));

        // The only ordinary permit is busy, so "Play" waits in the queue.
        ordinary_tx
            .send(queued(SessionCommand::Hello.into(), None))
            .await
            .unwrap();
        let (played, play_done) = oneshot::channel();
        ordinary_tx
            .send(queued(matchmake(true), Some(played)))
            .await
            .unwrap();
        // "Stop" overtakes it.
        urgent_tx
            .send(queued(matchmake(false), None))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        gate.add_permits(1);
        tokio::time::timeout(Duration::from_secs(5), play_done)
            .await
            .expect("the dropped start still answers its caller")
            .unwrap();
        assert_eq!(
            starts.load(Ordering::SeqCst),
            0,
            "the overtaken start never ran"
        );

        // Pressing Play again afterwards is a new start and runs.
        let (replayed, replay_done) = oneshot::channel();
        ordinary_tx
            .send(queued(matchmake(true), Some(replayed)))
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), replay_done)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            starts.load(Ordering::SeqCst),
            1,
            "a start sent after the stop runs"
        );

        drop(ordinary_tx);
        drop(urgent_tx);
        tokio::time::timeout(Duration::from_secs(5), driver)
            .await
            .unwrap()
            .unwrap();
    }

    #[test]
    fn releases_only_cancel_starts_of_the_same_pair() {
        use faf_domain::state::LobbyCommand;

        let matchmake = |queue: &str, start: bool| -> AppCommand {
            LobbyCommand::Matchmake {
                queue_name: queue.into(),
                start,
            }
            .into()
        };
        let order = ReleaseOrder::default();
        let start_a = matchmake("ladder1v1", true);
        let start_b = matchmake("tmm2v2", true);
        let (seq_a, seq_b) = (order.stamp(&start_a), order.stamp(&start_b));
        order.stamp(&matchmake("ladder1v1", false));
        assert!(order.superseded(&start_a, seq_a));
        assert!(
            !order.superseded(&start_b, seq_b),
            "another queue's start is untouched"
        );
        assert!(
            !order.superseded(&SessionCommand::Hello.into(), 0),
            "unpaired commands always run"
        );
    }

    #[tokio::test]
    async fn snapshot_subscription_draws_an_exact_event_boundary() {
        let (app, app_loop) = App::new("test", crate::infra::fake_ports());
        app_loop.sink.emit(SessionEvent::Connecting);

        let (mut events, snapshot) = app.subscribe_with_snapshot();
        assert_eq!(snapshot.session.status, ConnectionStatus::Connecting);

        app_loop.sink.emit(SessionEvent::BackendReady {
            version: "1.2.3".into(),
            offline_auth: false,
        });
        assert!(matches!(
            events.recv().await,
            Ok(AppEvent::Session(SessionEvent::BackendReady { version, .. })) if version == "1.2.3"
        ));
    }

    #[tokio::test]
    async fn revisioned_snapshot_deduplicates_earlier_events() {
        let (app, app_loop) = App::new("test", crate::infra::fake_ports());
        let (mut events, initial) = app.subscribe_versioned_with_snapshot();
        assert_eq!(initial.revision, 0);

        app_loop.sink.emit(SessionEvent::Connecting);
        let event = events.recv().await.expect("versioned event");
        assert_eq!(event.revision, 1);

        let snapshot = app.versioned_snapshot();
        assert_eq!(snapshot.revision, event.revision);
        assert_eq!(snapshot.state.session.status, ConnectionStatus::Connecting);
    }

    #[tokio::test]
    async fn dispatch_and_wait_observes_the_completed_service_effect() {
        let (app, app_loop) = App::new("test", crate::infra::fake_ports());
        tokio::spawn(app_loop.run());

        app.dispatch_and_wait(SessionCommand::Hello.into())
            .await
            .expect("command completes");

        assert_eq!(app.snapshot().session.status, ConnectionStatus::Connected);
    }
}
