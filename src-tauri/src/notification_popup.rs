//! A single, non-activating desktop popup. It receives presentation data for
//! existing notification ids, never the app snapshot or arbitrary actions.
use faf_domain::state::{DesktopNotificationStyle, NotificationAction, Theme, ToastPosition};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub(crate) const LABEL: &str = "notification-popup";
const UPDATE: &str = "notifications://popup";

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PopupCard {
    id: String,
    title: String,
    body: String,
    action_label: Option<String>,
    tone: String,
    #[serde(default)]
    image_url: Option<String>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PopupBatch {
    revision: u64,
    cards: Vec<PopupCard>,
    duration_seconds: u16,
    theme: Theme,
    dismiss_label: String,
}

pub(crate) struct Popups {
    batch: Mutex<PopupBatch>,
    shown: tokio::sync::watch::Sender<u64>,
}

impl Default for Popups {
    fn default() -> Self {
        let (shown, _) = tokio::sync::watch::channel(0);
        Self {
            batch: Mutex::new(PopupBatch::default()),
            shown,
        }
    }
}

/// The auxiliary window may only read and interact with its own bounded stack.
pub(crate) fn allowed(label: &str, command: &str, main: bool) -> bool {
    main || (label == LABEL
        && matches!(
            command,
            "notification_popup_snapshot"
                | "notification_popup_interact"
                | "notification_popup_size"
        ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Display {
    name: String,
    primary: bool,
}

#[tauri::command]
pub(crate) fn notification_displays(app: tauri::AppHandle) -> Result<Vec<Display>, String> {
    let window = crate::window::main_window(&app).ok_or("Client window unavailable")?;
    let primary = window.primary_monitor().map_err(|e| e.to_string())?;
    Ok(window
        .available_monitors()
        .map_err(|e| e.to_string())?
        .iter()
        .filter_map(|monitor| {
            monitor.name().map(|name| Display {
                name: name.clone(),
                primary: primary.as_ref().is_some_and(|p| p.name() == Some(name)),
            })
        })
        .collect())
}

#[tauri::command]
pub(crate) async fn show_notification_popup(
    app: tauri::AppHandle,
    cards: Vec<PopupCard>,
    dismiss_label: String,
    preview: bool,
) -> Result<(), String> {
    let core = app.state::<crate::Core>().0.clone();
    let (preferences, theme, valid) = core.with_state(|state| {
        (
            state.settings.notifications.clone(),
            state.settings.theme,
            cards
                .iter()
                .filter(|card| {
                    state
                        .notifications
                        .items
                        .iter()
                        .any(|n| n.id == card.id && !n.read)
                })
                .cloned()
                .collect::<Vec<_>>(),
        )
    });
    let cards: Vec<_> = if preview {
        cards
            .into_iter()
            .filter(|card| card.id == "preview")
            .take(1)
            .collect()
    } else {
        valid.into_iter().take(3).collect()
    };
    if cards.iter().any(|card| {
        card.image_url.as_ref().is_some_and(|image| {
            let local = image.starts_with("/assets/") && !image.contains('\\');
            let remote = tauri::Url::parse(image).is_ok_and(|url| {
                url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
            });
            !local && !remote
        })
    }) {
        return Err("Invalid notification artwork".into());
    }
    if cards.is_empty() {
        return Ok(());
    }
    if !preview
        && (!preferences.enabled
            || !preferences.desktop
            || preferences.desktop_style != DesktopNotificationStyle::Popup)
    {
        return Ok(());
    }
    if cards.iter().any(|c| {
        c.id.len() > 128
            || c.title.len() > 512
            || c.body.len() > 4096
            || c.action_label.as_ref().is_some_and(|l| l.len() > 256)
    }) || dismiss_label.len() > 256
    {
        return Err("Notification popup content is too large".into());
    }
    let state = app.state::<Popups>();
    {
        let mut batch = state.batch.lock().unwrap();
        batch
            .cards
            .retain(|card| !cards.iter().any(|new| new.id == card.id));
        batch.cards.splice(0..0, cards);
        batch.cards.truncate(3);
        batch.duration_seconds = preferences.toast_duration_seconds;
        batch.theme = theme;
        batch.dismiss_label = dismiss_label;
        batch.revision = batch.revision.wrapping_add(1);
    }
    let window = if let Some(window) = app.get_webview_window(LABEL) {
        window
    } else {
        tauri::WebviewWindowBuilder::new(
            &app,
            LABEL,
            tauri::WebviewUrl::App("notifications.html".into()),
        )
        .title("FAForever notifications")
        .inner_size(400.0, 160.0)
        .decorations(false)
        // The cards draw their own frame. Without these, Windows gives an
        // undecorated window a one-pixel border of its own around the page,
        // which read as a second frame around every card.
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // WS_EX_NOACTIVATE on Windows: showing or clicking this window
        // must not interrupt game input. Actions explicitly choose focus.
        .focused(false)
        .focusable(false)
        .visible(false)
        .on_navigation(|url| {
            matches!(url.host_str(), Some("localhost" | "tauri.localhost"))
                && matches!(url.scheme(), "tauri" | "http" | "https")
                && url.path() == "/notifications.html"
        })
        .build()
        .map_err(|e| e.to_string())?
    };
    // A successful build alone does not prove the page loaded or was shown.
    // Wait for its size/show acknowledgement before suppressing the OS fallback.
    let batch = state.batch.lock().unwrap().clone();
    let requested_ids: Vec<_> = batch.cards.iter().map(|card| card.id.clone()).collect();
    let mut shown = state.shown.subscribe();
    window.emit(UPDATE, &batch).map_err(|e| e.to_string())?;
    let displayed = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if *shown.borrow() >= batch.revision {
                return Ok::<(), String>(());
            }
            shown.changed().await.map_err(|e| e.to_string())?;
        }
    })
    .await;
    if !matches!(displayed, Ok(Ok(()))) {
        // Do not let a late page load display the same cards after fallback.
        for id in requested_ids {
            let _ = notification_popup_interact(app.clone(), id, "expire".into());
        }
        // Recreate an unresponsive page on the next attempt, rather than
        // keeping a hidden broken window for the rest of this session.
        let _ = window.close();
        return Err("The desktop notification window could not be displayed".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn notification_popup_snapshot(popups: tauri::State<'_, Popups>) -> PopupBatch {
    popups.batch.lock().unwrap().clone()
}

#[tauri::command]
pub(crate) fn notification_popup_size(
    app: tauri::AppHandle,
    revision: u64,
    height: f64,
) -> Result<(), String> {
    if !height.is_finite() {
        return Err("Invalid popup height".into());
    }
    let popups = app.state::<Popups>();
    let batch = popups.batch.lock().unwrap();
    if batch.revision != revision || batch.cards.is_empty() {
        return Ok(());
    }
    let preferences = app
        .state::<crate::Core>()
        .0
        .with_state(|s| s.settings.notifications.clone());
    let window = app
        .get_webview_window(LABEL)
        .ok_or("Popup window unavailable")?;
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let monitor = preferences
        .desktop_monitor
        .as_ref()
        .and_then(|name| monitors.iter().find(|m| m.name() == Some(name)))
        .cloned()
        .or(window.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("Display unavailable")?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let (x, y, width, height) = popup_bounds(
        (area.position.x, area.position.y),
        (area.size.width, area.size.height),
        scale,
        preferences.desktop_position,
        height,
    );
    window
        .set_size(tauri::PhysicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    popups.shown.send_replace(revision);
    Ok(())
}

/// Work-area coordinates include the taskbar exclusion and may be negative.
///
/// The window sits flush with the work area's corner: the page pads its cards,
/// and that padding is both the room for their shadow and their distance from
/// the edge of the screen.
fn popup_bounds(
    origin: (i32, i32),
    size: (u32, u32),
    scale: f64,
    position: ToastPosition,
    height: f64,
) -> (i32, i32, u32, u32) {
    let width = ((400.0 * scale).round() as u32).min(size.0).max(1);
    let height = ((height.clamp(80.0, 900.0) * scale).ceil() as u32)
        .min(size.1)
        .max(1);
    let right = matches!(
        position,
        ToastPosition::TopRight | ToastPosition::BottomRight
    );
    let bottom = matches!(
        position,
        ToastPosition::BottomRight | ToastPosition::BottomLeft
    );
    let x = origin.0
        + if right {
            size.0.saturating_sub(width) as i32
        } else {
            0
        };
    let y = origin.1
        + if bottom {
            size.1.saturating_sub(height) as i32
        } else {
            0
        };
    (x, y, width, height)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Interaction {
    id: String,
    interaction: String,
}

#[tauri::command]
pub(crate) fn notification_popup_interact(
    app: tauri::AppHandle,
    id: String,
    interaction: String,
) -> Result<(), String> {
    if !matches!(interaction.as_str(), "activate" | "dismiss" | "expire") {
        return Err("Invalid popup interaction".into());
    }
    let popups = app.state::<Popups>();
    {
        let batch = popups.batch.lock().unwrap();
        if !batch.cards.iter().any(|card| card.id == id) {
            return Ok(());
        }
    }
    let core = &app.state::<crate::Core>().0;
    if id != "preview" && interaction == "activate" {
        let action = core.with_state(|s| {
            s.notifications
                .items
                .iter()
                .find(|n| n.id == id)
                .map(|n| n.action.clone())
        });
        match action {
            None => {}
            Some(Some(NotificationAction::FocusGame)) => core.focus_game()?,
            Some(_) => crate::tray::restore_main_window(&app),
        }
    }
    let batch = {
        let mut batch = popups.batch.lock().unwrap();
        batch.cards.retain(|card| card.id != id);
        batch.revision = batch.revision.wrapping_add(1);
        batch.clone()
    };
    if let Some(window) = app.get_webview_window(LABEL) {
        window.emit(UPDATE, &batch).map_err(|e| e.to_string())?;
        if batch.cards.is_empty() {
            window.hide().map_err(|e| e.to_string())?;
        }
    }
    if id != "preview" && interaction != "expire" {
        if let Some(main) = crate::window::main_window(&app) {
            main.emit("notifications://interact", Interaction { id, interaction })
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn game_notification_attention(
    core: tauri::State<'_, crate::Core>,
    activate: bool,
) -> Result<bool, String> {
    if activate {
        core.0.focus_game()?;
        return Ok(true);
    }
    let focused = core.0.game_is_focused();
    if !focused {
        core.0.request_game_attention();
    }
    Ok(focused)
}

/// Keep displayed cards consistent with read/dismiss/clear and master settings.
pub(crate) fn refresh(app: &tauri::AppHandle) {
    let Some(popups) = app.try_state::<Popups>() else {
        return;
    };
    let (enabled, ids) = app.state::<crate::Core>().0.with_state(|s| {
        (
            s.settings.notifications.enabled
                && s.settings.notifications.desktop
                && s.settings.notifications.desktop_style == DesktopNotificationStyle::Popup,
            s.notifications
                .items
                .iter()
                .filter(|n| !n.read)
                .map(|n| n.id.clone())
                .collect::<Vec<_>>(),
        )
    });
    let changed = {
        let mut batch = popups.batch.lock().unwrap();
        let previous = batch.cards.len();
        batch
            .cards
            .retain(|c| enabled && (c.id == "preview" || ids.contains(&c.id)));
        if batch.cards.len() == previous {
            None
        } else {
            batch.revision = batch.revision.wrapping_add(1);
            Some(batch.clone())
        }
    };
    if let (Some(batch), Some(window)) = (changed, app.get_webview_window(LABEL)) {
        let _ = window.emit(UPDATE, &batch);
        if batch.cards.is_empty() {
            let _ = window.hide();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn popup_placement_uses_work_area_dpi_and_negative_monitor_coordinates() {
        assert_eq!(
            popup_bounds(
                (-2560, 0),
                (2560, 1440),
                2.0,
                ToastPosition::BottomRight,
                160.0
            ),
            (-800, 1120, 800, 320)
        );
        assert_eq!(
            popup_bounds((0, 30), (1920, 1010), 1.0, ToastPosition::TopLeft, 160.0),
            (0, 30, 400, 160)
        );
        let (x, y, w, h) = popup_bounds((0, 0), (320, 240), 2.0, ToastPosition::BottomRight, 900.0);
        assert!(x >= 0 && y >= 0 && x as u32 + w <= 320 && y as u32 + h <= 240);
    }

    #[test]
    fn the_popup_cannot_reach_the_app_bridge_or_file_commands() {
        for command in [
            "snapshot",
            "dispatch",
            "dispatch_and_wait",
            "pick_path",
            "read_latest_log",
            "open_client_folder",
            "exit_app",
            "show_notification_popup",
            "game_notification_attention",
        ] {
            assert!(!allowed(LABEL, command, false));
        }
        assert!(allowed(LABEL, "notification_popup_snapshot", false));
        assert!(allowed("main-2", "snapshot", true));
        assert!(!allowed("unknown", "notification_popup_snapshot", false));
    }
}
