//! The tray icon and its menu.
//!
//! Matches the Python client's small but useful tray surface: restore the
//! window, terminate a stuck or running FA process without closing the
//! client, or exit the client. Left click remains the quickest way to restore
//! the main window.

use faf_domain::state::LobbyCommand;
use faf_domain::AppCommand;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

use crate::Core;

const TRAY_OPEN_ID: &str = "open-client";
const TRAY_TERMINATE_GAME_ID: &str = "terminate-game";
const TRAY_QUIT_ID: &str = "quit-client";

pub(crate) fn restore_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
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
}
