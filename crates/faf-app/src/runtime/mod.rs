//! The runtime loop: command in → service → event out → reduce → broadcast.
//!
//! This is the closed unidirectional loop from ARCHITECTURE.md §1/§3.5. It owns the
//! authoritative [`AppState`] and is the only thing that calls [`faf_domain::reduce`].
//!
//! [`App::new`] returns a handle plus an [`AppLoop`]; the caller decides how to drive
//! it ([`tokio::spawn`] in tests, `tauri::async_runtime::spawn` in the shell). This
//! keeps the runtime free of any hard dependency on a particular executor.

use std::sync::{Arc, RwLock};

use faf_domain::{AppCommand, AppEvent, AppState};
use tokio::sync::{broadcast, mpsc};

use crate::ports::Ports;
use crate::services;

/// Read-only context handed to every service: shared dependencies.
///
/// Holds the [`Ports`] bundle (network, fs, process, auth…) injected at startup.
pub struct ServiceCtx {
    pub backend_version: String,
    pub ports: Ports,
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
}

impl EventSink {
    pub fn emit(&self, event: impl Into<AppEvent>) {
        let event = event.into();
        {
            let mut guard = self.state.write().expect("app state lock poisoned");
            faf_domain::reduce(&mut guard, &event);
        }
        // Err only means "no subscribers yet" — fine to ignore.
        let _ = self.tx.send(event);
    }
}

/// Handle to the application core. Created once, shared (behind `Arc`) by the shell.
pub struct App {
    state: Arc<RwLock<AppState>>,
    cmd_tx: mpsc::Sender<AppCommand>,
    event_tx: broadcast::Sender<AppEvent>,
}

/// The command-processing loop. Spawn `run()` on any async runtime.
pub struct AppLoop {
    cmd_rx: mpsc::Receiver<AppCommand>,
    ctx: ServiceCtx,
    sink: EventSink,
}

impl App {
    /// Construct the core and its loop. The caller spawns `loop.run()`.
    pub fn new(backend_version: impl Into<String>, ports: Ports) -> (Self, AppLoop) {
        let state = Arc::new(RwLock::new(AppState::default()));
        let (event_tx, _) = broadcast::channel::<AppEvent>(256);
        let (cmd_tx, cmd_rx) = mpsc::channel::<AppCommand>(64);

        let sink = EventSink {
            state: state.clone(),
            tx: event_tx.clone(),
        };
        let ctx = ServiceCtx {
            backend_version: backend_version.into(),
            ports,
        };

        let app = Self {
            state,
            cmd_tx,
            event_tx,
        };
        let app_loop = AppLoop { cmd_rx, ctx, sink };
        (app, app_loop)
    }

    /// Send a command into the loop (async — applies backpressure).
    pub async fn dispatch(&self, cmd: AppCommand) {
        let _ = self.cmd_tx.send(cmd).await;
    }

    /// Send a command without awaiting (for sync call sites like Tauri commands).
    pub fn try_dispatch(&self, cmd: AppCommand) {
        let _ = self.cmd_tx.try_send(cmd);
    }

    /// Subscribe to the event stream (the Tauri shell forwards this to the frontend).
    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.event_tx.subscribe()
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
        while let Some(cmd) = self.cmd_rx.recv().await {
            let ctx = ctx.clone();
            let sink = self.sink.clone();
            tokio::spawn(async move {
                dispatch(cmd, &ctx, &sink).await;
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
        AppCommand::Lobby(c) => services::lobby::handle(c, ctx, sink).await,
    }
}
