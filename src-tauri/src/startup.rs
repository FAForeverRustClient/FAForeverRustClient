//! Bringing the client up: where the bundled helpers are, starting the core,
//! forwarding its events, and the replay a double-click asked for.

use std::sync::Arc;

use faf_app::App;
use faf_domain::state::{
    AuthCommand, NavCommand, ReplayCommand, SessionCommand, SettingsCommand, SettingsEvent, Tab,
};
use faf_domain::{AppCommand, AppEvent};
use tauri::{Emitter, Manager};
use tokio::sync::broadcast::error::RecvError;

use crate::{Core, FrontendMessage, EVENT_CHANNEL};

/// Wait until the startup settings have been read: their `Loaded` event, or
/// the end of the whole load where events were missed. `false` when the load
/// failed before the settings were read.
async fn settings_read(
    mut events: tokio::sync::broadcast::Receiver<AppEvent>,
    mut load: tauri::async_runtime::JoinHandle<Result<(), String>>,
) -> bool {
    let finished = |result: Result<Result<(), String>, tauri::Error>| match result {
        Ok(Ok(())) => true,
        Ok(Err(reason)) => {
            tracing::error!(%reason, "could not load startup settings");
            false
        }
        Err(error) => {
            tracing::error!(%error, "the startup settings load stopped");
            false
        }
    };
    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(AppEvent::Settings(SettingsEvent::Loaded { .. })) => return true,
                Ok(_) => {}
                // Events were missed: the end of the load is the signal then.
                Err(RecvError::Lagged(_) | RecvError::Closed) => return finished(load.await),
            },
            result = &mut load => return finished(result),
        }
    }
}

/// The replay file this process was asked to open, if it was asked to open one.
///
/// A file association starts the client with the path as an argument, and
/// nothing else this client is started with looks like one. The extension is
/// checked rather than "the first argument that is not a flag", because the
/// association is the only thing that should be able to make the client open a
/// file, and `faf-client.exe --some-flag some/path` should not.
///
/// `argv[0]` is the executable and is skipped. The backend refuses a path whose
/// extension it does not recognise anyway; this only decides whether to ask.
pub(crate) fn replay_argument(argv: &[String]) -> Option<&str> {
    argv.iter().skip(1).map(String::as_str).find(|argument| {
        let lowered = argument.to_ascii_lowercase();
        lowered.ends_with(".fafreplay") || lowered.ends_with(".scfareplay")
    })
}

/// Hand a replay path to the running client and show it.
///
/// Deliberately `try_dispatch` and not a wait: this is called from the
/// single-instance callback, which runs on Tauri's main thread, and from
/// startup. Neither is a place to block on a replay that may take seconds to
/// prepare.
pub(crate) fn open_replay_from_argument(app: &tauri::AppHandle, path: &str) {
    let Some(core) = app.try_state::<Core>() else {
        tracing::warn!("asked to open a replay before the backend was ready");
        return;
    };
    tracing::info!(%path, "opening a replay handed to the client as an argument");
    let _ = core
        .0
        .try_dispatch(AppCommand::Nav(NavCommand::Select { tab: Tab::Replays }));
    let _ = core
        .0
        .try_dispatch(AppCommand::Replays(ReplayCommand::OpenFile {
            path: path.to_string(),
        }));
}

/// [`open_replay_from_argument`] for the replay a cold start was opened with.
///
/// That one arrives before the settings are read and before a remembered
/// sign-in is restored, and playback needs both: the replay install comes
/// from the settings, and the engine build a replay needs is downloaded with
/// the session's token. Opened at once, it started FA unprepared ("Unable to
/// load game replay") or failed with "not logged in". It waits for the backend
/// to be ready and, while a remembered sign-in is being restored, briefly for
/// that too, then opens as before.
pub(crate) fn open_replay_at_startup(app: &tauri::AppHandle, path: String) {
    use faf_domain::state::{AuthEvent, AuthMode, ConnectionStatus, SessionEvent};
    use faf_domain::AppEvent;
    use std::time::Duration;

    const READY_WAIT: Duration = Duration::from_secs(60);
    const SIGN_IN_WAIT: Duration = Duration::from_secs(20);

    let Some(core) = app.try_state::<Core>() else {
        tracing::warn!("asked to open a replay before the backend was ready");
        return;
    };
    let core = core.0.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // Subscribed before the state is read, so an event in between is seen.
        let mut events = core.subscribe();
        let ready = core.with_state(|state| state.session.status == ConnectionStatus::Connected);
        if !ready {
            wait_for_event(&mut events, READY_WAIT, |event| {
                matches!(event, AppEvent::Session(SessionEvent::BackendReady { .. }))
            })
            .await;
        }
        let restoring = core.with_state(|state| {
            state.settings.general.auto_login
                && state.auth.player.is_none()
                && state.auth.mode == AuthMode::Account
        });
        if restoring {
            // A restore that fails says nothing, so this is bounded.
            wait_for_event(&mut events, SIGN_IN_WAIT, |event| {
                matches!(event, AppEvent::Auth(AuthEvent::LoggedIn { .. }))
            })
            .await;
        }
        open_replay_from_argument(&handle, &path);
    });
}

/// Wait up to `limit` for an event `done` accepts.
async fn wait_for_event(
    events: &mut tokio::sync::broadcast::Receiver<faf_domain::AppEvent>,
    limit: std::time::Duration,
    done: impl Fn(&faf_domain::AppEvent) -> bool,
) {
    let _ = tokio::time::timeout(limit, async {
        loop {
            match events.recv().await {
                Ok(event) if done(&event) => return,
                Err(RecvError::Closed) => return,
                _ => {}
            }
        }
    })
    .await;
}

/// Point the environment at the helpers the installer bundles.
///
/// Packaged builds place native helpers under Tauri's resource directory. The
/// lobby provider also searches the development `natives/` directory, while
/// each `FAF_*_PATH` variable remains an explicit override for custom
/// installations, which is why a value already set is left alone.
pub(crate) fn locate_bundled_helpers(app: &tauri::App) {
    // Packaged builds place native helpers under Tauri's resource
    // directory. The lobby provider also searches the development
    // `natives/` directory, while FAF_UID_PATH remains an explicit
    // override for custom installations.
    if std::env::var("FAF_UID_PATH").unwrap_or_default().is_empty() {
        let uid_name = if cfg!(windows) {
            "faf-uid.exe"
        } else if cfg!(target_os = "macos") {
            "faf-uid-macos"
        } else {
            "faf-uid"
        };
        if let Ok(resource_dir) = app.path().resource_dir() {
            let bundled_uid = resource_dir.join("natives").join(uid_name);
            if bundled_uid.is_file() {
                std::env::set_var("FAF_UID_PATH", bundled_uid);
            }
        }
    }

    if std::env::var("FAF_ICE_ADAPTER_JAR")
        .unwrap_or_default()
        .is_empty()
    {
        if let Ok(resource_dir) = app.path().resource_dir() {
            let bundled_adapter = resource_dir
                .join("natives")
                .join("java-ice-adapter")
                .join("faf-ice-adapter.jar");
            if bundled_adapter.is_file() {
                std::env::set_var("FAF_ICE_ADAPTER_JAR", bundled_adapter);
            }
        }
    }

    // The two below are also found beside the executable, which is where the
    // Windows installer puts them. A Linux package does not: the binary goes
    // to /usr/bin and the resources to /usr/lib/<product>, so without this
    // the experimental adapter reported itself as not installed there and
    // faf-pioneer was looked up on PATH.
    if std::env::var("FAF_EXP_JAVA_ICE_ADAPTER_JAR")
        .unwrap_or_default()
        .is_empty()
    {
        if let Ok(resource_dir) = app.path().resource_dir() {
            let bundled_adapter = resource_dir
                .join("natives")
                .join("exp-java-ice-adapter")
                .join("faf-ice-adapter.jar");
            if bundled_adapter.is_file() {
                std::env::set_var("FAF_EXP_JAVA_ICE_ADAPTER_JAR", bundled_adapter);
            }
        }
    }

    if std::env::var("FAF_ICE_ADAPTER_PATH")
        .unwrap_or_default()
        .is_empty()
    {
        if let Ok(resource_dir) = app.path().resource_dir() {
            let pioneer_name = if cfg!(windows) {
                "faf-pioneer.exe"
            } else {
                "faf-pioneer"
            };
            let bundled_pioneer = resource_dir.join("natives").join(pioneer_name);
            if bundled_pioneer.is_file() {
                std::env::set_var("FAF_ICE_ADAPTER_PATH", bundled_pioneer);
            }
        }
    }

    if std::env::var("FAF_JAVA_PATH")
        .unwrap_or_default()
        .is_empty()
    {
        if let Ok(resource_dir) = app.path().resource_dir() {
            let java_name = if cfg!(windows) { "java.exe" } else { "java" };
            let bundled_java = resource_dir
                .join("natives")
                .join("jre")
                .join("bin")
                .join(java_name);
            if bundled_java.is_file() {
                std::env::set_var("FAF_JAVA_PATH", bundled_java);
            }
        }
    }

    // Valve's library, for showing a game on Steam. Windows and Linux only,
    // and absent from a build that does not carry it, in which case the
    // setting that uses it simply does nothing.
    if let Some((library_name, _)) = faf_app::infra::steam_presence::LIBRARY {
        if std::env::var("FAF_STEAM_API_PATH")
            .unwrap_or_default()
            .is_empty()
        {
            if let Ok(resource_dir) = app.path().resource_dir() {
                let bundled_library = resource_dir
                    .join("natives")
                    .join("steam")
                    .join(library_name);
                if bundled_library.is_file() {
                    std::env::set_var("FAF_STEAM_API_PATH", bundled_library);
                }
            }
        }
    }
}

/// Build the core, drive its loop, forward its events, and kick off the
/// startup commands. Returns the handle `setup` puts under Tauri's management.
pub(crate) fn start_core(app: &tauri::App, backend_version: String) -> Arc<App> {
    // Real OAuth2 auth and the real lobby WebSocket
    // (`infra::LobbyClient`). Set FAF_FAKE_AUTH=1 to run fully offline
    // without a browser login during local dev.
    let ports = faf_app::infra::ports_from_env();
    let cleanup_files = !ports.offline_auth;
    let (core, app_loop) = App::new(backend_version, ports);
    let core = Arc::new(core);

    // Drive the command-processing loop on Tauri's async runtime.
    tauri::async_runtime::spawn(app_loop.run());

    // Forward backend events to the frontend.
    let handle = app.handle().clone();
    let (mut events, _) = core.subscribe_versioned_with_snapshot();
    let event_core = core.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
                    #[cfg(windows)]
                    if matches!(
                        event.event,
                        AppEvent::ClientUpdate(faf_domain::state::ClientUpdateEvent::Installing)
                    ) {
                        // Explicit exit bypasses close-to-tray and the window's
                        // recovery handler. Release the single-instance slot
                        // before the installer replaces files and restarts us.
                        handle.exit(0);
                        return;
                    }
                    let _ = handle.emit(
                        EVENT_CHANNEL,
                        FrontendMessage::Event {
                            revision: event.revision,
                            event: Box::new(event.event),
                        },
                    );
                }
                // Re-establish an atomic state/event boundary rather
                // than skipping deltas and permanently diverging from
                // the authoritative Rust state.
                // Logged, with its size and how long it took to send: it is
                // the whole state, map and mod catalogues included, and while
                // the webview takes it in, nothing else on screen updates. A
                // client that looked frozen for seconds left nothing behind to
                // say whether this was why. Sizing it serialises it once more,
                // which a lag, rare by design, can afford.
                Err(RecvError::Lagged(skipped)) => {
                    let started = std::time::Instant::now();
                    let (replacement, snapshot) = event_core.subscribe_versioned_with_snapshot();
                    events = replacement;
                    #[cfg(windows)]
                    if matches!(
                        snapshot.state.client_update.status,
                        faf_domain::state::ClientUpdateStatus::Installing
                    ) {
                        handle.exit(0);
                        return;
                    }
                    let bytes = serde_json::to_vec(&snapshot.state).map_or(0, |json| json.len());
                    let _ = handle.emit(
                        EVENT_CHANNEL,
                        FrontendMessage::Snapshot {
                            revision: snapshot.revision,
                            state: Box::new(snapshot.state),
                        },
                    );
                    tracing::warn!(
                        skipped,
                        bytes,
                        seconds = started.elapsed().as_secs_f32(),
                        "webview event stream fell behind; sent a full state snapshot"
                    );
                }
                Err(RecvError::Closed) => break,
            }
        }
    });

    // Persisted settings must be authoritative before the backend is
    // announced as ready. Otherwise a fast webview can migrate legacy
    // browser preferences into Rust defaults while the settings file
    // is still being read. Auth restore can proceed concurrently once
    // that dependency is satisfied.
    //
    // That dependency is the file, not the whole command: `Load` goes on to
    // measure the game cache and ask GitHub for a client update, which on a
    // cold disk or with GitHub slow or blocked took from seconds to over a
    // minute, and auto sign-in waited for all of it. Sign-in starts at
    // `Loaded` now and the rest of the load runs beside it.
    let startup_core = core.clone();
    // Subscribed before the load starts, so its `Loaded` cannot be missed.
    let settings_events = startup_core.subscribe();
    tauri::async_runtime::spawn(async move {
        let load_core = startup_core.clone();
        let load = tauri::async_runtime::spawn(async move {
            load_core
                .dispatch_and_wait(AppCommand::Settings(SettingsCommand::Load))
                .await
        });
        if !settings_read(settings_events, load).await {
            return;
        }
        let cleanup = if cleanup_files {
            let generator_output = startup_core.snapshot().settings.map_generator.output_path;
            tauri::async_runtime::spawn_blocking(move || {
                faf_app::infra::recover_interrupted_work(&generator_output)
            })
            .await
            .ok()
        } else {
            None
        };
        let _ = startup_core.try_dispatch(AppCommand::Auth(AuthCommand::Restore));
        let _ = startup_core.try_dispatch(AppCommand::Session(SessionCommand::Hello));
        if let Some(cleanup) = cleanup {
            tauri::async_runtime::spawn_blocking(move || cleanup.finish());
        }
    });

    core
}
