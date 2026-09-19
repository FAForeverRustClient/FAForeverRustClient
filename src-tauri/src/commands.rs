//! The typed bridge and the narrowly scoped OS integrations the webview may
//! invoke. Reached from `ui/src/ipc/client.ts` (the domain commands) and
//! `ui/src/ipc/native.ts` (everything else); nothing else calls these.
//!
//! Three kinds live here, and the boundary between them is the point:
//!
//! * [`dispatch`], [`dispatch_and_wait`] and [`snapshot`] are the *only*
//!   way state moves across the boundary (ARCHITECTURE.md §1).
//! * The folder, log and sound commands are desktop plumbing with no state.
//! * [`webview_engine`] and [`exit_app`] are facts about, and control over,
//!   the shell process itself.

use faf_app::VersionedSnapshot;
use faf_domain::AppCommand;
use serde::Serialize;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

use crate::Core;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogPreview {
    file_name: String,
    content: String,
    /// Known problems recognised in this log (see
    /// [`faf_domain::protocol::log_analysis`]). Analysed here rather than in the
    /// frontend so the whole file is scanned: the preview below is truncated to
    /// the newest 512 KiB, and the trace that explains a crash is routinely
    /// older than that.
    issues: Vec<faf_domain::protocol::log_analysis::LogIssue>,
}

pub(crate) fn log_directory(
    kind: &str,
    app: &tauri::AppHandle,
) -> Result<std::path::PathBuf, String> {
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
pub(crate) fn open_log_folder(kind: String, app: tauri::AppHandle) -> Result<(), String> {
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
pub(crate) fn open_client_folder(kind: String, app: tauri::AppHandle) -> Result<(), String> {
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

/// Where one of the client's own folders is, as a path a file dialog can open.
///
/// The same resolution as [`open_client_folder`], returned rather than
/// revealed, so a picker can start somewhere useful instead of wherever the
/// operating system last left it. Created on demand for the same reason: a
/// dialog pointed at a directory that does not exist yet falls back to the
/// default, which is the behaviour this exists to avoid.
#[tauri::command]
pub(crate) fn client_folder_path(kind: String) -> Result<String, String> {
    let path = faf_app::infra::client_folder(&kind)?;
    std::fs::create_dir_all(&path)
        .map_err(|error| format!("could not create {}: {error}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Copy a picked sound file into the client's own sounds directory.
///
/// Returns the name it was stored under, which is what goes in the settings.
/// It is not always the name that was picked: see `import_sound` for why a
/// collision gets a suffix rather than overwriting.
#[tauri::command]
pub(crate) fn import_notification_sound(path: String) -> Result<String, String> {
    faf_app::infra::notification_sounds::import_sound(std::path::Path::new(&path))
}

/// The sounds the player has added, by name.
#[tauri::command]
pub(crate) fn list_notification_sounds() -> Result<Vec<String>, String> {
    faf_app::infra::notification_sounds::list_sounds()
}

/// One stored sound, as bytes the webview can decode.
///
/// Read here rather than handed over as a file:// URL: the webview's asset
/// protocol would need the whole data directory opened up to reach one file,
/// and this is a couple of hundred kilobytes read once and cached by the page.
#[tauri::command]
pub(crate) fn read_notification_sound(name: String) -> Result<Vec<u8>, String> {
    let path = faf_app::infra::notification_sounds::sound_path(&name)?;
    std::fs::read(&path).map_err(|error| format!("could not read {}: {error}", path.display()))
}

/// Forget one stored sound.
#[tauri::command]
pub(crate) fn remove_notification_sound(name: String) -> Result<(), String> {
    faf_app::infra::notification_sounds::remove_sound(&name)
}

#[tauri::command]
pub(crate) fn open_version_folder(name: String, app: tauri::AppHandle) -> Result<(), String> {
    let cache_root = faf_app::infra::cache_dir()?;
    let sanitized = faf_app::infra::sanitize_folder_name(&name);
    let version_dir = cache_root.join("versions").join(&sanitized);
    let target = if version_dir.is_dir() {
        version_dir
    } else {
        cache_root.join("game_files")
    };
    std::fs::create_dir_all(&target)
        .map_err(|error| format!("could not create {}: {error}", target.display()))?;
    app.opener()
        .open_path(target.to_string_lossy().into_owned(), None::<String>)
        .map_err(|error| format!("could not open {}: {error}", target.display()))
}

#[tauri::command]
pub(crate) async fn reveal_replay(path: String, app: tauri::AppHandle) -> Result<(), String> {
    let path =
        faf_app::infra::replay::validated_local_replay_path(std::path::Path::new(&path)).await?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| format!("could not reveal replay: {error}"))
}

#[tauri::command]
pub(crate) fn read_latest_log(
    kind: String,
    app: tauri::AppHandle,
) -> Result<Option<LogPreview>, String> {
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

#[tauri::command]
pub(crate) async fn dispatch(
    command: AppCommand,
    core: tauri::State<'_, Core>,
) -> Result<(), String> {
    let core = core.0.clone();
    core.dispatch(command).await
}

/// UI → backend when a later command depends on this service effect, not just
/// on admission to the bounded queue.
#[tauri::command]
pub(crate) async fn dispatch_and_wait(
    command: AppCommand,
    core: tauri::State<'_, Core>,
) -> Result<(), String> {
    let core = core.0.clone();
    core.dispatch_and_wait(command).await
}

/// Backend → UI: a consistent snapshot for initial hydration.
#[tauri::command]
pub(crate) fn snapshot(core: tauri::State<'_, Core>) -> VersionedSnapshot {
    core.0.versioned_snapshot()
}

/// Terminate the application process cleanly.
#[tauri::command]
pub(crate) fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Which rendering engine the client actually ended up in.
///
/// Only Linux reports a version, because only Linux can surprise us: Windows
/// and macOS roll their webview forward with the operating system, while a GTK
/// build renders in whatever WebKitGTK the distribution happens to ship. An
/// old-stable release there can predate the CSS this client is written in.
///
/// Facts only. Which release is new enough is deliberately a frontend
/// decision, because the features at stake are the ones its stylesheets use.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebviewEngine {
    pub(crate) platform: &'static str,
    pub(crate) webkit_version: Option<String>,
}

/// The three accessors are public webkit2gtk C API and the library is already
/// linked into this binary by wry, so asking it its own version costs neither
/// a dependency nor a process.
#[cfg(target_os = "linux")]
pub(crate) fn webkit_version() -> Option<String> {
    extern "C" {
        fn webkit_get_major_version() -> u32;
        fn webkit_get_minor_version() -> u32;
        fn webkit_get_micro_version() -> u32;
    }

    // Sound: three argument-less accessors that return a constant compiled into
    // the library. They touch no state and cannot fail.
    let (major, minor, micro) = unsafe {
        (
            webkit_get_major_version(),
            webkit_get_minor_version(),
            webkit_get_micro_version(),
        )
    };
    Some(format!("{major}.{minor}.{micro}"))
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn webkit_version() -> Option<String> {
    None
}

pub(crate) fn platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

/// Report the rendering engine so the frontend can warn about one too old for
/// its own stylesheets, and so a bug report carries the version without asking
/// the reporter to run `pkg-config` first.
#[tauri::command]
pub(crate) fn webview_engine() -> WebviewEngine {
    WebviewEngine {
        platform: platform_name(),
        webkit_version: webkit_version(),
    }
}
