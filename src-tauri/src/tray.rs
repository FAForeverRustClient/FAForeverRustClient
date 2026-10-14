//! The tray icon and its menu.
//!
//! Matches the Python client's small but useful tray surface: restore the
//! window, terminate a stuck or running FA process without closing the
//! client, or exit the client. Left click remains the quickest way to restore
//! the main window. Quit during a game goes the way the window's close button
//! does ([`crate::exit`]): it used to exit outright, past the warning the
//! close button gives.

use faf_domain::state::LobbyCommand;
use faf_domain::AppCommand;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

use crate::Core;

const TRAY_OPEN_ID: &str = "open-client";
const TRAY_TERMINATE_GAME_ID: &str = "terminate-game";
const TRAY_QUIT_ID: &str = "quit-client";

/// Show the window again. A client hidden until its game ends stays open
/// after it instead: coming back is changing one's mind.
///
/// A window that is not standing yet, being built again after a crash, is
/// shown once it stands rather than now, when there is no native window to
/// show; and with none standing and none on its way (a rebuild that failed),
/// one is built (`webview_recovery`).
pub(crate) fn restore_main_window(app: &tauri::AppHandle) {
    crate::exit::cancel(app);
    #[cfg(windows)]
    if crate::webview_recovery::window_state(app) != crate::webview_recovery::WindowState::Standing
    {
        crate::webview_recovery::open_when_standing(app);
        return;
    }
    if let Some(window) = crate::window::main_window(app) {
        let _ = window.show();
        // A rebuilt window keeps the crashed one's maximised state for when
        // the player brings it forward, which this is.
        #[cfg(windows)]
        crate::webview_recovery::on_activated(app);
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Build the tray. Called once from `setup`, after the core is managed.
pub(crate) fn build(app: &tauri::App) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, TRAY_OPEN_ID, "Open client", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let terminate_item = MenuItem::with_id(
        app,
        TRAY_TERMINATE_GAME_ID,
        "Terminate game",
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, TRAY_QUIT_ID, "Quit", true, None::<&str>)?;
    let tray_menu = Menu::with_items(app, &[&open_item, &separator, &terminate_item, &quit_item])?;
    let mut tray =
        TrayIconBuilder::with_id(crate::exit::TRAY_ID).tooltip(crate::exit::TRAY_TOOLTIP);
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
            } else if event.id() == TRAY_QUIT_ID
                && crate::exit::on_close_request(app, crate::exit::Origin::Tray)
                    == crate::exit::Decision::Exit
            {
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
}
