//! The main window: how it is built, and what happens when it loses focus or
//! is asked to close.

use tauri::{Emitter, Manager};

use crate::navigation::{is_internal_navigation, open_externally, NEWS_EXTERNAL_LINK_SCRIPT};
use crate::Core;

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

/// Process-level window events: memory trimming on blur, and the close
/// confirmation while a game is running.
pub(crate) fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    #[cfg(windows)]
    if matches!(event, tauri::WindowEvent::Focused(false)) {
        trim_working_set();
    }

    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if let Some(core) = window.try_state::<Core>() {
            // One field, not a clone of the whole state to read it.
            let is_in_game = core.0.with_state(|state| {
                matches!(state.lobby.join, faf_domain::state::JoinState::InGame)
            });
            if is_in_game {
                api.prevent_close();
                let _ = window.emit("app://request-exit-confirm", ());
                return;
            }
        }
        window.app_handle().exit(0);
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

/// Create the main window programmatically so we can attach `on_navigation`
/// and `on_new_window` hooks. These intercept external links that bubble up
/// from the embedded news/unit iframe via `allow-popups-to-escape-sandbox` and
/// `allow-top-navigation-by-user-activation`, routing them to the OS default
/// browser via the opener plugin.
pub(crate) fn build_main(app: &tauri::App) -> tauri::Result<()> {
    // Where Tauri puts the profile when none is given (`LocalData` joined with
    // the identifier); WebView2 adds the `EBWebView` folder itself.
    #[cfg(windows)]
    if let Ok(profile) = app.path().app_local_data_dir() {
        wait_for_previous_browser_process(&profile);
    }
    let nav_handle = app.handle().clone();
    let new_win_handle = app.handle().clone();
    tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
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
        .initialization_script_for_all_frames(NEWS_EXTERNAL_LINK_SCRIPT)
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
        .build()?;
    Ok(())
}
