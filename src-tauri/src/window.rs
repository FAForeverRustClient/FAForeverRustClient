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

/// Create the main window programmatically so we can attach `on_navigation`
/// and `on_new_window` hooks. These intercept external links that bubble up
/// from the embedded news/unit iframe via `allow-popups-to-escape-sandbox` and
/// `allow-top-navigation-by-user-activation`, routing them to the OS default
/// browser via the opener plugin.
pub(crate) fn build_main(app: &tauri::App) -> tauri::Result<()> {
    let nav_handle = app.handle().clone();
    let new_win_handle = app.handle().clone();
    let window = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
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

    // Browser-style inspection in development mode
    // `FAF_OPEN_DEVTOOLS=1 pnpm run tauri dev`.
    #[cfg(debug_assertions)]
    if std::env::var_os("FAF_OPEN_DEVTOOLS").is_some() {
        window.open_devtools();
    }

    Ok(())
}
