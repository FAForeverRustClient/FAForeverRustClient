//! The runtime loop: command in → service → event out → reduce → broadcast.
//!
//! This is the closed unidirectional loop from ARCHITECTURE.md §1/§3.5. It owns the
//! authoritative [`AppState`] and is the only thing that calls [`faf_domain::reduce`].
//!
//! [`App::new`] returns a handle plus an [`AppLoop`]; the caller decides how to drive
//! it ([`tokio::spawn`] in tests, `tauri::async_runtime::spawn` in the shell). This
//! keeps the runtime free of any hard dependency on a particular executor.

use std::sync::atomic::AtomicU64;
use std::sync::{Arc, RwLock};

use faf_domain::{AppCommand, AppEvent, AppState};
use serde::Serialize;
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::ports::Ports;
use crate::services;

mod policies;
pub use policies::{AutoReconnect, LatestRequest, SerialMutation, SingleFlight};

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
    /// A custom-game join stays single-flight from the first click until the
    /// server accepts or rejects it. Preparation can take minutes, so a local
    /// component disabled-state alone is not a concurrency boundary.
    pub lobby_join_active: SingleFlight,
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
    pub replay_vault_generation: LatestRequest,
    pub replay_local_generation: LatestRequest,
    pub map_generator_active: SingleFlight,
    pub tutorial_launch_active: SingleFlight,
    pub maps_mutation: SerialMutation,
    pub mods_mutation: SerialMutation,
    pub auth_mutation: SerialMutation,
    /// Player and organiser writes go one at a time. The server recomputes the
    /// bracket on every confirmed result, so two overlapping reports would each
    /// be answered against a bracket the other has already moved.
    pub tourney_mutation: SerialMutation,
    /// Only the newest detail response may land: opening three events in a row
    /// must not leave the first one's bracket on screen because it answered
    /// last.
    pub tourney_detail_generation: LatestRequest,
    /// The same, for reading a chat room.
    pub tourney_chat_generation: LatestRequest,
    /// The same, for the organiser's account search: it fires per keystroke, so
    /// answers overtaking each other is the normal case rather than the rare one.
    pub tourney_account_search_generation: LatestRequest,
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
    /// **The write guard is deliberately held across both sends.** It looks
    /// like an easy win to drop it right after `reduce` so readers are not
    /// blocked by broadcast work, and that is wrong: revisions are handed out
    /// under this lock, so releasing it early lets two concurrent emitters
    /// interleave and deliver revision N+1 before N. The frontend mirror
    /// (`ui/src/ipc/revisionedMirror.ts`) treats any revision gap as
    /// corruption and requests a fresh snapshot, and a snapshot is a few
    /// megabytes: the map vault alone measures ~3.6 MiB of JSON at a
    /// realistic 5000-entry catalogue. Trading a microsecond of lock hold for
    /// intermittent multi-megabyte refetches is a bad deal. `broadcast::send`
    /// does not block on slow receivers, so the hold is bounded anyway.
    pub fn emit(&self, event: impl Into<AppEvent>) {
        let event = event.into();
        let mut guard = self.state.write().expect("app state lock poisoned");
        faf_domain::reduce(&mut guard, &event);
        let revision = self
            .revision
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .wrapping_add(1);
        // Err only means "no subscribers yet": fine to ignore.
        let _ = self.tx.send(event.clone());
        let _ = self.versioned_tx.send(VersionedEvent { revision, event });
    }

    /// A snapshot of the authoritative state. Lets a service read back the result
    /// of its own `emit` (e.g. to persist the post-reduce slice). Read-only,
    /// state still only changes through [`Self::emit`].
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
    event_tx: broadcast::Sender<AppEvent>,
    versioned_event_tx: broadcast::Sender<VersionedEvent>,
    revision: Arc<AtomicU64>,
}

/// The command-processing loop. Spawn `run()` on any async runtime.
pub struct AppLoop {
    cmd_rx: mpsc::Receiver<QueuedCommand>,
    ctx: ServiceCtx,
    sink: EventSink,
}

struct QueuedCommand {
    command: AppCommand,
    completion: Option<oneshot::Sender<()>>,
}

impl App {
    /// Construct the core and its loop. The caller spawns `loop.run()`.
    pub fn new(backend_version: impl Into<String>, ports: Ports) -> (Self, AppLoop) {
        let state = Arc::new(RwLock::new(AppState::default()));
        let (event_tx, _) = broadcast::channel::<AppEvent>(256);
        let (versioned_event_tx, _) = broadcast::channel::<VersionedEvent>(256);
        let (cmd_tx, cmd_rx) = mpsc::channel::<QueuedCommand>(64);
        let revision = Arc::new(AtomicU64::new(0));

        let sink = EventSink {
            state: state.clone(),
            tx: event_tx.clone(),
            versioned_tx: versioned_event_tx.clone(),
            revision: revision.clone(),
        };
        let ctx = ServiceCtx {
            backend_version: backend_version.into(),
            ports,
            lobby_active: SingleFlight::default(),
            lobby_join_active: SingleFlight::default(),
            chat_active: SingleFlight::default(),
            lobby_auto_reconnect: AutoReconnect::default(),
            chat_auto_reconnect: AutoReconnect::default(),
            player_card_profile_generation: LatestRequest::default(),
            player_card_matchmaker_generation: LatestRequest::default(),
            player_card_map_stats_generation: LatestRequest::default(),
            player_card_history_generation: LatestRequest::default(),
            uploads_active: SingleFlight::default(),
            client_update_active: SingleFlight::default(),
            galactic_war_active: SingleFlight::default(),
            settings_persist: SerialMutation::default(),
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
            replay_vault_generation: LatestRequest::default(),
            replay_local_generation: LatestRequest::default(),
            map_generator_active: SingleFlight::default(),
            tutorial_launch_active: SingleFlight::default(),
            maps_mutation: SerialMutation::default(),
            mods_mutation: SerialMutation::default(),
            auth_mutation: SerialMutation::default(),
            tourney_mutation: SerialMutation::default(),
            tourney_detail_generation: LatestRequest::default(),
            tourney_chat_generation: LatestRequest::default(),
            tourney_account_search_generation: LatestRequest::default(),
        };

        let app = Self {
            state,
            cmd_tx,
            event_tx,
            versioned_event_tx,
            revision,
        };
        let app_loop = AppLoop { cmd_rx, ctx, sink };
        (app, app_loop)
    }

    /// Send a command into the loop, applying backpressure when the bounded
    /// queue is busy and reporting a stopped runtime to the caller.
    pub async fn dispatch(&self, cmd: AppCommand) -> Result<(), String> {
        self.cmd_tx
            .send(QueuedCommand {
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
        self.cmd_tx
            .send(QueuedCommand {
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
        self.cmd_tx
            .try_send(QueuedCommand {
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

    /// Subscribe to the event stream (the Tauri shell forwards this to the frontend).
    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.event_tx.subscribe()
    }

    /// Atomically subscribe at the event-stream tail and clone the state at
    /// that exact boundary. Events represented by the snapshot precede the
    /// receiver; every later event is queued for it. This lets IPC recover from
    /// broadcast lag without dropping or replaying state transitions.
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
}

impl AppLoop {
    /// Drive the loop until all command senders are dropped.
    ///
    /// Each command is handled on its own task so a slow effect (e.g. an
    /// interactive login) never blocks the processing of other commands. Ordering
    /// of *state* changes is still well-defined: every mutation goes through the
    /// single [`EventSink::emit`] chokepoint.
    pub async fn run(mut self) {
        let ctx = Arc::new(self.ctx);

        // Discord Rich Presence is the one feature no command drives: the
        // status mirrors state, so it observes the event stream instead. It
        // owns its own tasks and never blocks this loop.
        services::discord::spawn(ctx.clone(), self.sink.clone());

        // Likewise state-driven: a socket that dropped while the user is still
        // signed in should come back without them asking.
        services::reconnect::spawn(ctx.clone(), self.sink.clone());

        while let Some(queued) = self.cmd_rx.recv().await {
            let ctx = ctx.clone();
            let sink = self.sink.clone();
            tokio::spawn(async move {
                dispatch(queued.command, &ctx, &sink).await;
                if let Some(completion) = queued.completion {
                    let _ = completion.send(());
                }
            });
        }
    }
}

/// Route a command to the owning service. One arm per slice (ARCHITECTURE.md §8).
async fn dispatch(cmd: AppCommand, ctx: &ServiceCtx, sink: &EventSink) {
    match cmd {
        AppCommand::Session(c) => services::session::handle(c, ctx, sink).await,
        AppCommand::Auth(c) => services::auth::handle(c, ctx, sink).await,
        AppCommand::Nav(c) => services::nav::handle(c, ctx, sink).await,
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
        AppCommand::Reviews(c) => services::reviews::handle(c, ctx, sink).await,
        AppCommand::Tourney(c) => services::tourney::handle(c, ctx, sink).await,
        AppCommand::Tutorials(c) => services::tutorials::handle(c, ctx, sink).await,
        AppCommand::Changelog(c) => services::changelog::handle(c, ctx, sink).await,
        AppCommand::Uploads(c) => services::uploads::handle(c, ctx, sink).await,
        AppCommand::GalacticWar(c) => services::galactic_war::handle(c, ctx, sink).await,
        AppCommand::ClientUpdate(c) => services::client_update::handle(c, ctx, sink).await,
        AppCommand::Social(c) => services::social::handle(c, ctx, sink).await,
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
