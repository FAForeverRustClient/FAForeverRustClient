//! Tauri shell: the thin glue between [`faf_app`] and the webview.
//!
//! Responsibilities (and nothing more, per ARCHITECTURE.md §2):
//! - expose the typed application bridge and narrowly scoped OS integrations;
//! - forward every [`AppEvent`] from the core to the frontend on `app://event`;
//! - own desktop-only concerns such as the tray and diagnostic-log access.
//!
//! All logic lives in `faf-app`/`faf-domain`. This file must stay boring.

use std::sync::Arc;

use faf_app::{App, VersionedSnapshot};
use faf_domain::state::{AuthCommand, LobbyCommand, SessionCommand, SettingsCommand};
use faf_domain::{AppCommand, AppEvent, AppState};
use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::broadcast::error::RecvError;

mod diagnostics;

/// The channel the backend emits state deltas on. The frontend listens here.
const EVENT_CHANNEL: &str = "app://event";
const TRAY_OPEN_ID: &str = "open-client";
const TRAY_TERMINATE_GAME_ID: &str = "terminate-game";
const TRAY_QUIT_ID: &str = "quit-client";

/// One ordered shell-to-webview stream. Recovery snapshots deliberately use
/// the same channel as deltas so the webview cannot observe a post-recovery
/// event and then roll itself back to an older snapshot from another channel.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum FrontendMessage {
    Event { revision: u64, event: Box<AppEvent> },
    Snapshot { revision: u64, state: Box<AppState> },
}

/// Managed state: the shared application core.
struct Core(Arc<App>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogPreview {
    file_name: String,
    content: String,
    /// Known problems recognised in this log (see
    /// [`faf_domain::protocol::log_analysis`]). Analysed here rather than in the
    /// frontend so the whole file is scanned: the preview below is truncated to
    /// the newest 512 KiB, and the trace that explains a crash is routinely
    /// older than that.
    issues: Vec<faf_domain::protocol::log_analysis::LogIssue>,
}

fn restore_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn log_directory(kind: &str, app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    match kind {
        "game" => faf_app::infra::game_logs::directory(),
        "client" => app
            .path()
            .app_log_dir()
            .map_err(|error| format!("could not resolve client logs: {error}")),
        _ => Err("unknown log category".into()),
    }
}

#[tauri::command]
fn open_log_folder(kind: String, app: tauri::AppHandle) -> Result<(), String> {
    let directory = log_directory(&kind, &app)?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("could not create diagnostics folder: {error}"))?;
    app.opener()
        .open_path(directory.to_string_lossy().into_owned(), None::<String>)
        .map_err(|error| format!("could not open diagnostics folder: {error}"))
}

/// Open one of the client's own folders in the system file manager.
///
/// `gamePrefs` resolves to a file, so it is revealed in its parent rather than
/// handed to `open_path`, which would ask the OS to *launch* it.
#[tauri::command]
fn open_client_folder(kind: String, app: tauri::AppHandle) -> Result<(), String> {
    let path = faf_app::infra::client_folder(&kind)?;
    if kind == "gamePrefs" {
        return app
            .opener()
            .reveal_item_in_dir(&path)
            .map_err(|error| format!("could not reveal {}: {error}", path.display()));
    }
    // Created on demand: several of these only exist once the client has
    // written something, and "the folder is missing" is a worse answer than an
    // empty folder.
    std::fs::create_dir_all(&path)
        .map_err(|error| format!("could not create {}: {error}", path.display()))?;
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<String>)
        .map_err(|error| format!("could not open {}: {error}", path.display()))
}

#[tauri::command]
async fn reveal_replay(path: String, app: tauri::AppHandle) -> Result<(), String> {
    let path =
        faf_app::infra::replay::validated_local_replay_path(std::path::Path::new(&path)).await?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| format!("could not reveal replay: {error}"))
}

#[tauri::command]
fn read_latest_log(kind: String, app: tauri::AppHandle) -> Result<Option<LogPreview>, String> {
    const MAX_PREVIEW_BYTES: u64 = 512 * 1024;
    let directory = log_directory(&kind, &app)?;
    let Some(path) = std::fs::read_dir(&directory)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "log"))
        .max_by_key(|path| {
            path.metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
        })
    else {
        return Ok(None);
    };
    let bytes =
        std::fs::read(&path).map_err(|error| format!("could not read latest log: {error}"))?;
    // Analyse the whole file, then truncate for display. The other way round
    // would miss any trace older than the preview window, which is most of them
    // in a long game.
    let whole = String::from_utf8_lossy(&bytes);
    let issues = faf_domain::protocol::log_analysis::analyze_game_log(&whole);
    let start = bytes.len().saturating_sub(MAX_PREVIEW_BYTES as usize);
    let content = String::from_utf8_lossy(&bytes[start..]).into_owned();
    Ok(Some(LogPreview {
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("diagnostic.log")
            .to_string(),
        content,
        issues,
    }))
}

/// UI → backend: enqueue a command with bounded backpressure; results still
/// arrive asynchronously as events.
#[tauri::command]
async fn dispatch(command: AppCommand, core: tauri::State<'_, Core>) -> Result<(), String> {
    let core = core.0.clone();
    core.dispatch(command).await
}

/// UI → backend when a later command depends on this service effect, not just
/// on admission to the bounded queue.
#[tauri::command]
async fn dispatch_and_wait(
    command: AppCommand,
    core: tauri::State<'_, Core>,
) -> Result<(), String> {
    let core = core.0.clone();
    core.dispatch_and_wait(command).await
}

/// Backend → UI: a consistent snapshot for initial hydration.
#[tauri::command]
fn snapshot(core: tauri::State<'_, Core>) -> VersionedSnapshot {
    core.0.versioned_snapshot()
}

/// Terminate the application process cleanly.
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg(windows)]
fn trim_working_set() {
    unsafe {
        extern "system" {
            fn GetCurrentProcess() -> isize;
            fn SetProcessWorkingSetSize(process: isize, min: usize, max: usize) -> i32;
        }
        SetProcessWorkingSetSize(GetCurrentProcess(), usize::MAX, usize::MAX);
    }
}

pub fn run() {
    #[cfg(windows)]
    if std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_err() {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--enable-features=msLowMemoryMode --renderer-process-limit=1 --js-flags=\"--max-old-space-size=256 --scavenger_max_new_space_capacity_mb=8\" --disable-features=Translate,OptimizationHints,MediaRouter",
        );
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            #[cfg(windows)]
            if matches!(event, tauri::WindowEvent::Focused(false)) {
                trim_working_set();
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(core) = window.try_state::<Core>() {
                    let snapshot = core.0.versioned_snapshot();
                    let is_in_game = matches!(
                        snapshot.state.lobby.join,
                        faf_domain::state::JoinState::InGame
                    );
                    if is_in_game {
                        api.prevent_close();
                        let _ = window.emit("app://request-exit-confirm", ());
                        return;
                    }
                }
                window.app_handle().exit(0);
            }
        })
        .setup(|app| {
            let log_dir = app.path().app_log_dir()?;
            app.manage(diagnostics::init(&log_dir)?);
            // Before anything resolves a path: the client used to store its
            // cache, data and settings under "forgeclient/forge-client", and
            // this moves them to the current name once. Best effort, and a
            // no-op after the first run. Placed after diagnostics so the
            // outcome is actually logged.
            faf_app::infra::migrate_legacy_directories();
            let ice_log_dir = log_dir.join("iceAdapterLogs");
            std::fs::create_dir_all(&ice_log_dir)?;
            std::env::set_var("FAF_ICE_LOG_DIR", &ice_log_dir);
            let backend_version = env!("CARGO_PKG_VERSION").to_string();

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

            if std::env::var("FAF_JAVA_PATH").unwrap_or_default().is_empty() {
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

            // Real OAuth2 auth + (still-faked) lobby. Set FAF_FAKE_AUTH=1 to run
            // fully offline without a browser login during local dev.
            let ports = faf_app::infra::ports_from_env();
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
                        Err(RecvError::Lagged(_)) => {
                            let (replacement, snapshot) =
                                event_core.subscribe_versioned_with_snapshot();
                            events = replacement;
                            let _ = handle.emit(
                                EVENT_CHANNEL,
                                FrontendMessage::Snapshot {
                                    revision: snapshot.revision,
                                    state: Box::new(snapshot.state),
                                },
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
            let startup_core = core.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(reason) = startup_core
                    .dispatch_and_wait(AppCommand::Settings(SettingsCommand::Load))
                    .await
                {
                    tracing::error!(%reason, "could not load startup settings");
                    return;
                }
                let _ = startup_core.try_dispatch(AppCommand::Auth(AuthCommand::Restore));
                let _ = startup_core.try_dispatch(AppCommand::Session(SessionCommand::Hello));
            });

            app.manage(Core(core));

            // Match the Python client's small but useful tray surface: restore
            // the window, terminate a stuck/running FA process without closing
            // the client, or exit the client. Left click remains the quickest
            // way to restore the main window.
            let open_item =
                MenuItem::with_id(app, TRAY_OPEN_ID, "Open client", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let terminate_item = MenuItem::with_id(
                app,
                TRAY_TERMINATE_GAME_ID,
                "Terminate game",
                true,
                None::<&str>,
            )?;
            let quit_item =
                MenuItem::with_id(app, TRAY_QUIT_ID, "Quit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[&open_item, &separator, &terminate_item, &quit_item],
            )?;
            let mut tray = TrayIconBuilder::new().tooltip("FAForever Rust Client");
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id() == TRAY_OPEN_ID {
                        restore_main_window(app);
                    } else if event.id() == TRAY_TERMINATE_GAME_ID {
                        let core = app.state::<Core>();
                        if let Err(reason) = core
                            .0
                            .try_dispatch(AppCommand::Lobby(LobbyCommand::TerminateGame))
                        {
                            tracing::warn!(%reason, "could not enqueue tray game-termination command");
                        }
                    } else if event.id() == TRAY_QUIT_ID {
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        restore_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dispatch,
            dispatch_and_wait,
            snapshot,
            open_log_folder,
            open_client_folder,
            reveal_replay,
            read_latest_log,
            exit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    fn tauri_config() -> serde_json::Value {
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid tauri config")
    }

    fn capabilities() -> serde_json::Value {
        serde_json::from_str(include_str!("../capabilities/default.json"))
            .expect("valid capabilities")
    }

    #[test]
    fn package_versions_stay_in_sync() {
        let cargo_version = env!("CARGO_PKG_VERSION");
        let tauri = tauri_config();
        let package: serde_json::Value =
            serde_json::from_str(include_str!("../../package.json")).expect("valid package.json");

        assert_eq!(
            tauri["version"].as_str(),
            Some(cargo_version),
            "tauri.conf.json must match the Cargo workspace version"
        );
        assert_eq!(
            package["version"].as_str(),
            Some(cargo_version),
            "package.json must match the Cargo workspace version"
        );
    }

    #[test]
    fn package_identifier_is_stable_and_release_ready() {
        assert_eq!(
            tauri_config()["identifier"],
            "com.faforever.rustclient",
            "changing the installed application identity requires an explicit migration"
        );
    }

    #[test]
    fn bundled_native_resources_have_stable_runtime_paths() {
        let tauri = tauri_config();
        let resources = tauri["bundle"]["resources"]
            .as_object()
            .expect("native resources must use explicit bundle destinations");

        assert_eq!(
            resources["../natives/jre/"], "natives/jre/",
            "the packaged Java resolver expects this directory layout"
        );
        assert_eq!(
            resources["../natives/java-ice-adapter/faf-ice-adapter.jar"],
            "natives/java-ice-adapter/faf-ice-adapter.jar"
        );
    }

    #[test]
    fn production_content_security_policy_keeps_tauri_ipc_and_embeds_scoped() {
        let tauri = tauri_config();
        let csp = tauri["app"]["security"]["csp"]
            .as_object()
            .expect("production CSP must stay enabled");

        assert_eq!(csp["default-src"], "'self'");
        assert_eq!(csp["connect-src"], "ipc: http://ipc.localhost");
        assert_eq!(csp["object-src"], "'none'");
        assert_eq!(csp["frame-ancestors"], "'none'");

        let frames = csp["frame-src"].as_str().expect("frame-src string");
        assert!(frames.contains("https://www.faforever.com"));
        assert!(frames.contains("https://faforever.github.io"));
        assert!(!frames.contains('*'));

        let dev_connect = tauri["app"]["security"]["devCsp"]["connect-src"]
            .as_str()
            .expect("development connect-src string");
        assert!(dev_connect.contains("ipc: http://ipc.localhost"));
        assert!(dev_connect.contains("ws://localhost:5173"));
    }

    #[test]
    fn native_url_opener_is_scoped_to_https() {
        let capabilities = capabilities();
        let permission = capabilities["permissions"]
            .as_array()
            .expect("permissions list")
            .iter()
            .find(|permission| permission["identifier"] == "opener:allow-open-url")
            .expect("scoped opener permission");

        assert_eq!(
            permission["allow"],
            serde_json::json!([{ "url": "https://*" }])
        );
    }
}
