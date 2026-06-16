//! Tauri shell — the thin glue between [`faf_app`] and the webview.
//!
//! Responsibilities (and nothing more, per ARCHITECTURE.md §2):
//! - expose two commands: [`dispatch`] (UI → backend) and [`snapshot`] (initial hydrate);
//! - forward every [`AppEvent`] from the core to the frontend on `app://event`.
//!
//! All logic lives in `faf-app`/`faf-domain`. This file must stay boring.

use std::sync::Arc;

use faf_app::App;
use faf_domain::{AppCommand, AppState};
use tauri::{Emitter, Manager};
use tokio::sync::broadcast::error::RecvError;

/// The channel the backend emits state deltas on. The frontend listens here.
const EVENT_CHANNEL: &str = "app://event";

/// Managed state: the shared application core.
struct Core(Arc<App>);

/// UI → backend: enqueue a command. Returns immediately; results arrive as events.
#[tauri::command]
fn dispatch(command: AppCommand, core: tauri::State<'_, Core>) {
    core.0.try_dispatch(command);
}

/// Backend → UI: a consistent snapshot for initial hydration.
#[tauri::command]
fn snapshot(core: tauri::State<'_, Core>) -> AppState {
    core.0.snapshot()
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let backend_version = env!("CARGO_PKG_VERSION").to_string();
            // Real OAuth2 auth + (still-faked) lobby. Set FAF_FAKE_AUTH=1 to run
            // fully offline without a browser login during local dev.
            let ports = faf_app::infra::ports_from_env();
            let (core, app_loop) = App::new(backend_version, ports);
            let core = Arc::new(core);

            // Drive the command-processing loop on Tauri's async runtime.
            tauri::async_runtime::spawn(app_loop.run());

            // Forward backend events to the frontend.
            let handle = app.handle().clone();
            let mut events = core.subscribe();
            tauri::async_runtime::spawn(async move {
                loop {
                    match events.recv().await {
                        Ok(event) => {
                            let _ = handle.emit(EVENT_CHANNEL, event);
                        }
                        // We lagged behind the broadcast buffer — skip and continue.
                        Err(RecvError::Lagged(_)) => continue,
                        Err(RecvError::Closed) => break,
                    }
                }
            });

            app.manage(Core(core));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![dispatch, snapshot])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
