//! The main window: how it is built, and what happens when it loses focus or
//! is asked to close.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use tauri::Manager;

use crate::navigation::{
    is_internal_navigation, open_externally, NEWS_EXTERNAL_LINK_SCRIPT, UNIT_DATABASE_EMBED_SCRIPT,
};

/// The first main window's label.
pub(crate) const MAIN_LABEL: &str = "main";

/// Which window is the main one.
///
/// "main" at a start, and a fresh label for each window built again after a
/// crash (`webview_recovery`): `main-2`, `main-3`. Fresh because Tauri
/// registers a window's label before its native window exists, and when that
/// native creation fails the label stays registered with nothing behind it,
/// so a second window by the same label could never be built.
pub(crate) struct MainWindow {
    label: Mutex<String>,
    built: AtomicU32,
}

impl Default for MainWindow {
    fn default() -> Self {
        Self {
            label: Mutex::new(MAIN_LABEL.to_string()),
            built: AtomicU32::new(0),
        }
    }
}

/// The label for the `built`-th main window, counted from zero.
fn label_for(built: u32) -> String {
    if built == 0 {
        MAIN_LABEL.to_string()
    } else {
        format!("{MAIN_LABEL}-{}", built + 1)
    }
}

fn current_label(app: &tauri::AppHandle) -> String {
    app.try_state::<MainWindow>().map_or_else(
        || MAIN_LABEL.to_string(),
        |main| {
            main.label
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        },
    )
}

/// The main window, if one is registered. Registered is not the same as
/// standing: see `webview_recovery::window_ready`.
pub(crate) fn main_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(&current_label(app))
}

/// Whether `label` is the main window's. Only the crash recovery
/// (`webview_recovery`, Windows only) has more than one.
#[cfg(windows)]
pub(crate) fn is_main(app: &tauri::AppHandle, label: &str) -> bool {
    current_label(app) == label
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

/// Process-level window events: memory trimming on blur, and what closing
/// does while a game is running ([`crate::exit`]).
pub(crate) fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    #[cfg(windows)]
    if matches!(event, tauri::WindowEvent::Focused(false)) {
        trim_working_set();
    }

    // The player focused the main window: the moment a rebuilt window may
    // take its predecessor's maximised state (`webview_recovery`).
    #[cfg(windows)]
    if matches!(event, tauri::WindowEvent::Focused(true))
        && is_main(window.app_handle(), window.label())
    {
        crate::webview_recovery::on_activated(window.app_handle());
    }

    #[cfg(windows)]
    if matches!(event, tauri::WindowEvent::Destroyed)
        && is_main(window.app_handle(), window.label())
    {
        crate::webview_recovery::on_main_destroyed(window.app_handle());
    }

    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        match crate::exit::on_close_request(window.app_handle(), crate::exit::Origin::Window) {
            crate::exit::Decision::Exit => window.app_handle().exit(0),
            // Hidden to the tray, or asking first: either way the window
            // stays, and the decision has already acted on it.
            crate::exit::Decision::Hide | crate::exit::Decision::Ask => api.prevent_close(),
        }
    }
}

/// Wait until no WebView2 browser process holds this client's profile.
///
/// One browser process serves every webview that uses the same user data
/// folder, whichever process created it (WebView2 "Process model": a user
/// data folder's browser process is started by the first webview and shared
/// by the rest). So a client that starts while the previous one's browser
/// process is still winding down does not get a browser process of its own:
/// it attaches to the old one, whose parent is the client that has just
/// exited. Task Manager then shows the WebView2 processes as a group of their
/// own instead of under the client (#412). It is a race, which is why it
/// happened only sometimes: `tauri dev` restarts the client on every rebuild,
/// and an update or a quick restart does the same.
///
/// The browser process holds `EBWebView\lockfile` in the profile exclusively
/// for as long as it runs. Only one client runs at a time (the single-instance
/// plugin hands a second start to the first), so a held lock at this point is
/// a previous client's browser process, which exits within a second or two of
/// losing its last webview. Waiting for it costs nothing on a normal start,
/// where the lock is not there at all, and gives up after a few seconds
/// rather than holding the window back for good.
#[cfg(windows)]
fn wait_for_previous_browser_process(profile: &std::path::Path) {
    use std::os::windows::fs::OpenOptionsExt;

    const ERROR_SHARING_VIOLATION: i32 = 32;
    const MAX_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

    let lock = profile.join("EBWebView").join("lockfile");
    let started = std::time::Instant::now();
    let mut waited = false;
    loop {
        // Never created here: an absent lock is the usual, free case.
        let probe = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&lock);
        match probe {
            Err(error) if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION) => {
                if started.elapsed() >= MAX_WAIT {
                    tracing::warn!(
                        "a previous WebView2 browser process still holds the profile; \
                         starting anyway, and it will be shared"
                    );
                    return;
                }
                waited = true;
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            _ => {
                if waited {
                    tracing::info!(
                        waited_ms = started.elapsed().as_millis() as u64,
                        "waited for the previous WebView2 browser process to exit"
                    );
                }
                return;
            }
        }
    }
}

/// Which main window is being built.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Build {
    /// The one a start opens: shown and focused.
    First,
    /// One built again after its web view's browser process exited: hidden
    /// and unfocused, until the recovery decides once it stands.
    #[cfg_attr(not(windows), allow(dead_code))]
    Recovery,
}

/// Create the main window programmatically so we can attach `on_navigation`
/// and `on_new_window` hooks. These intercept external links that bubble up
/// from the embedded news/unit iframe via `allow-popups-to-escape-sandbox` and
/// `allow-top-navigation-by-user-activation`, routing them to the OS default
/// browser via the opener plugin.
///
/// Also what builds it again when its web view's browser process has exited
/// (`webview_recovery`), which is why it takes a handle rather than the app
/// being set up. Each build takes the next label ([`MainWindow`]).
///
/// Returning is not standing: off the main thread, Tauri queues the native
/// window and returns its handle at once. The page starting to load is the
/// sign it stands ([`on_page_load`]).
pub(crate) fn build_main(
    app: &tauri::AppHandle,
    build: Build,
) -> tauri::Result<tauri::WebviewWindow> {
    // Where Tauri puts the profile when none is given (`LocalData` joined with
    // the identifier); WebView2 adds the `EBWebView` folder itself.
    #[cfg(windows)]
    if let Ok(profile) = app.path().app_local_data_dir() {
        wait_for_previous_browser_process(&profile);
    }
    let label = app.try_state::<MainWindow>().map_or_else(
        || MAIN_LABEL.to_string(),
        |main| {
            let label = label_for(main.built.fetch_add(1, Ordering::SeqCst));
            *main
                .label
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = label.clone();
            label
        },
    );
    let nav_handle = app.clone();
    let new_win_handle = app.clone();
    tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::default())
        .title("FAForever Client")
        // First run only: the window-state plugin replaces this with the
        // remembered geometry when there is one.
        .inner_size(1100.0, 720.0)
        // The stylesheet already declares `min-width: 560px` on `body`, and
        // the shell hides overflow, so a window below that clips content
        // with no way to scroll to it. Enforcing the same floor on the
        // window keeps a remembered geometry from restoring into a size the
        // interface cannot be used at.
        .min_inner_size(560.0, 480.0)
        .resizable(true)
        .visible(build == Build::First)
        // Not focused when built again: a crash can come mid-game, and taking
        // the focus would pull the player out of it. Tao shows a window built
        // this way without activating it the first time, the one time a
        // recovery shows it (`webview_recovery`).
        .focused(build == Build::First)
        .initialization_script_for_all_frames(NEWS_EXTERNAL_LINK_SCRIPT)
        .initialization_script_for_all_frames(UNIT_DATABASE_EMBED_SCRIPT)
        // The only navigation hook. A plugin carrying a second copy of
        // this used to be registered as well, and never ran: Tauri asks
        // the builder closure first (`manager::webview::prepare_pending_webview`)
        // and skips the plugin store when it answers `false`, which this
        // does for every external URL. Two copies of a security decision
        // where one is unreachable is how the reachable one drifts.
        .on_navigation(move |url| {
            // Allow the Tauri app origin and the two embedded site roots.
            if is_internal_navigation(url) {
                return true;
            }
            open_externally(&nav_handle, url);
            false
        })
        .on_new_window(move |url, _features| {
            // Any new-window request (target="_blank", window.open, popup)
            // that escapes the iframe sandbox is routed to the OS browser.
            open_externally(&new_win_handle, &url);
            tauri::webview::NewWindowResponse::Deny
        })
        .on_page_load(|window, _payload| on_page_load(&window))
        .build()
}

/// The main window's page has started or finished loading, so its native
/// window and web view stand.
fn on_page_load(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    crate::webview_recovery::on_main_page_load(window);
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(test)]
mod tests {
    use super::label_for;

    #[test]
    fn each_main_window_built_takes_a_fresh_label() {
        assert_eq!(label_for(0), "main");
        assert_eq!(label_for(1), "main-2");
        assert_eq!(label_for(2), "main-3");
    }
}
