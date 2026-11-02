//! A single, non-activating desktop popup. It receives presentation data for
//! existing notification ids, never the app snapshot or arbitrary actions.
use faf_domain::state::{
    DesktopNotificationStyle, NotificationAction, NotificationKind, ToastPosition,
};
use faf_ipc::shell::{NotificationDisplay, NotificationPopupBatch, NotificationPopupCard};
use serde::Serialize;
use std::{collections::VecDeque, sync::Mutex};
use tauri::{Emitter, Manager};

pub(crate) const LABEL: &str = "notification-popup";
const UPDATE: &str = "notifications://popup";

fn is_preview(id: &str) -> bool {
    id == "preview"
        || id.strip_prefix("preview:").is_some_and(|suffix| {
            !suffix.is_empty()
                && suffix.len() <= 96
                && suffix
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b':'))
        })
}

const VISIBLE_CARDS: usize = 3;
// The history retains 50 live entries; leave room for three local previews too.
const MAX_CARDS: usize = 53;

struct QueuedCard {
    card: NotificationPopupCard,
    held: bool,
}

#[derive(Default)]
struct PopupQueue {
    visible: NotificationPopupBatch,
    pending: VecDeque<QueuedCard>,
}

impl PopupQueue {
    fn enqueue(&mut self, cards: Vec<NotificationPopupCard>, hold: bool) -> Result<(), String> {
        let additional = cards
            .iter()
            .enumerate()
            .filter(|(index, card)| {
                !self.visible.cards.iter().any(|old| old.id == card.id)
                    && !self.pending.iter().any(|old| old.card.id == card.id)
                    && !cards[..*index].iter().any(|old| old.id == card.id)
            })
            .count();
        if self.visible.cards.len() + self.pending.len() + additional > MAX_CARDS {
            return Err("Desktop notification queue is full".into());
        }
        // An inspection preview must never block a real notification indefinitely.
        if cards.iter().any(|card| !is_preview(&card.id)) {
            self.visible
                .cards
                .retain(|card| !self.visible.held_preview_ids.contains(&card.id));
            self.visible.held_preview_ids.clear();
            self.pending.retain(|queued| !queued.held);
        }
        for card in cards {
            let held = hold && is_preview(&card.id);
            if let Some(existing) = self.visible.cards.iter_mut().find(|old| old.id == card.id) {
                self.visible.held_preview_ids.retain(|id| *id != card.id);
                if held {
                    self.visible.held_preview_ids.push(card.id.clone());
                }
                *existing = card;
            } else if let Some(existing) =
                self.pending.iter_mut().find(|old| old.card.id == card.id)
            {
                *existing = QueuedCard { card, held };
            } else {
                self.pending.push_back(QueuedCard { card, held });
            }
        }
        self.promote();
        Ok(())
    }

    fn prioritize(&mut self, immediate: &[String]) {
        // A found match cannot wait behind a long display duration. Preserve
        // the displaced card so it can be shown again after the urgent alert.
        for id in immediate {
            let Some(index) = self.pending.iter().position(|queued| queued.card.id == *id) else {
                continue;
            };
            let Some(next) = self.pending.remove(index) else {
                continue;
            };
            if self.visible.cards.len() == VISIBLE_CARDS {
                if let Some(previous) = self.visible.cards.pop() {
                    self.pending.push_front(QueuedCard {
                        card: previous,
                        held: false,
                    });
                }
            }
            self.visible.cards.insert(0, next.card);
        }
    }

    fn promote(&mut self) {
        while self.visible.cards.len() < VISIBLE_CARDS {
            let Some(next) = self.pending.pop_front() else {
                break;
            };
            if next.held {
                self.visible.held_preview_ids.push(next.card.id.clone());
            }
            self.visible.cards.push(next.card);
        }
        self.visible
            .held_preview_ids
            .retain(|id| self.visible.cards.iter().any(|card| card.id == *id));
    }

    fn remove(&mut self, id: &str) {
        self.visible.cards.retain(|card| card.id != id);
        self.pending.retain(|queued| queued.card.id != id);
        self.promote();
    }

    fn retain(&mut self, keep: impl Fn(&NotificationPopupCard) -> bool) -> bool {
        let before: Vec<_> = self
            .visible
            .cards
            .iter()
            .map(|card| card.id.clone())
            .collect();
        self.visible.cards.retain(&keep);
        self.pending.retain(|queued| keep(&queued.card));
        self.promote();
        before
            != self
                .visible
                .cards
                .iter()
                .map(|card| card.id.clone())
                .collect::<Vec<_>>()
    }
}

pub(crate) struct Popups {
    queue: Mutex<PopupQueue>,
    delivery: tokio::sync::Mutex<()>,
    shown: tokio::sync::watch::Sender<u64>,
}

impl Default for Popups {
    fn default() -> Self {
        let (shown, _) = tokio::sync::watch::channel(0);
        Self {
            queue: Mutex::new(PopupQueue::default()),
            delivery: tokio::sync::Mutex::new(()),
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

#[tauri::command]
pub(crate) fn notification_displays(
    app: tauri::AppHandle,
) -> Result<Vec<NotificationDisplay>, String> {
    let window = crate::window::main_window(&app).ok_or("Client window unavailable")?;
    let primary = window.primary_monitor().map_err(|e| e.to_string())?;
    Ok(window
        .available_monitors()
        .map_err(|e| e.to_string())?
        .iter()
        .filter_map(|monitor| {
            monitor.name().map(|name| NotificationDisplay {
                name: name.clone(),
                primary: primary.as_ref().is_some_and(|p| p.name() == Some(name)),
            })
        })
        .collect())
}

#[tauri::command]
pub(crate) async fn show_notification_popup(
    app: tauri::AppHandle,
    cards: Vec<NotificationPopupCard>,
    dismiss_label: String,
    preview: bool,
    hold_preview: Option<bool>,
) -> Result<(), String> {
    tracing::debug!(preview, cards = cards.len(), "desktop popup requested");
    let popups = app.state::<Popups>();
    // Two arrivals must not both create the same window or acknowledge each
    // other's batch before their own cards have been accepted.
    let _delivery = popups.delivery.lock().await;
    if cards.len() > MAX_CARDS {
        return Err("Too many desktop notifications".into());
    }
    let core = app.state::<crate::Core>().0.clone();
    let (preferences, theme, valid, immediate) = core.with_state(|state| {
        (
            state.settings.notifications.clone(),
            state.settings.theme,
            cards
                .iter()
                .filter(|card| {
                    state.notifications.items.iter().any(|n| {
                        n.id == card.id
                            && !n.read
                            && state
                                .settings
                                .notifications
                                .delivery
                                .get(&n.kind)
                                .and_then(|delivery| delivery.desktop)
                                != Some(false)
                    })
                })
                .cloned()
                .collect::<Vec<_>>(),
            state
                .notifications
                .items
                .iter()
                .filter(|n| {
                    !n.read
                        && matches!(
                            n.kind,
                            NotificationKind::MatchFound
                                | NotificationKind::GameFull
                                | NotificationKind::PartyInvite
                        )
                })
                .map(|n| n.id.clone())
                .collect::<Vec<_>>(),
        )
    });
    let cards: Vec<_> = if preview {
        cards
            .into_iter()
            .filter(|card| is_preview(&card.id))
            .take(VISIBLE_CARDS)
            .collect()
    } else {
        valid
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
    let requested_ids: Vec<_> = cards.iter().map(|card| card.id.clone()).collect();
    let window = if let Some(window) = app.get_webview_window(LABEL) {
        tracing::debug!("reusing desktop popup window");
        window
    } else {
        tracing::debug!("creating desktop popup window");
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
        .map_err(|e| {
            tracing::warn!(error = %e, "desktop popup window creation failed");
            e.to_string()
        })?
    };
    tracing::debug!("desktop popup window ready");
    {
        let mut queue = popups.queue.lock().unwrap();
        queue.enqueue(cards, preview && hold_preview == Some(true))?;
        if !preview {
            queue.prioritize(&immediate);
        }
        let batch = &mut queue.visible;
        batch.duration_seconds = preferences.toast_duration_seconds;
        batch.theme = theme;
        batch.dismiss_label = dismiss_label;
        batch.revision = batch.revision.wrapping_add(1);
    }
    // A successful build alone does not prove the page loaded or was shown.
    // Wait for its size/show acknowledgement before suppressing the OS fallback.
    let batch = popups.queue.lock().unwrap().visible.clone();
    let mut shown = popups.shown.subscribe();
    if let Err(error) = window.emit(UPDATE, &batch) {
        for id in requested_ids {
            let _ = notification_popup_interact(app.clone(), id, "expire".into());
        }
        let _ = window.close();
        return Err(error.to_string());
    }
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
        tracing::warn!(
            revision = batch.revision,
            "desktop popup display acknowledgement timed out"
        );
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
pub(crate) fn notification_popup_snapshot(
    popups: tauri::State<'_, Popups>,
) -> NotificationPopupBatch {
    popups.queue.lock().unwrap().visible.clone()
}

#[tauri::command]
pub(crate) fn notification_popup_size(
    app: tauri::AppHandle,
    revision: u64,
    height: f64,
) -> Result<(), String> {
    tracing::debug!(revision, "desktop popup layout received");
    if !height.is_finite() {
        return Err("Invalid popup height".into());
    }
    let popups = app.state::<Popups>();
    let queue = popups.queue.lock().unwrap();
    let batch = &queue.visible;
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
    tracing::debug!(revision, "desktop popup shown");
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
        let queue = popups.queue.lock().unwrap();
        let visible = queue.visible.cards.iter().any(|card| card.id == id);
        let queued_expiry =
            interaction == "expire" && queue.pending.iter().any(|queued| queued.card.id == id);
        if !(visible || queued_expiry) {
            return Ok(());
        }
    }
    let core = &app.state::<crate::Core>().0;
    let preview = is_preview(&id);
    if !preview && interaction == "activate" {
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
        let mut queue = popups.queue.lock().unwrap();
        queue.remove(&id);
        let batch = &mut queue.visible;
        batch.revision = batch.revision.wrapping_add(1);
        batch.clone()
    };
    if let Some(window) = app.get_webview_window(LABEL) {
        window.emit(UPDATE, &batch).map_err(|e| e.to_string())?;
        if batch.cards.is_empty() {
            window.hide().map_err(|e| e.to_string())?;
        }
    }
    if preview || interaction != "expire" {
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
    let (enabled, ids, duration) = app.state::<crate::Core>().0.with_state(|s| {
        (
            s.settings.notifications.enabled
                && s.settings.notifications.desktop
                && s.settings.notifications.desktop_style == DesktopNotificationStyle::Popup,
            s.notifications
                .items
                .iter()
                .filter(|n| {
                    !n.read
                        && s.settings
                            .notifications
                            .delivery
                            .get(&n.kind)
                            .and_then(|delivery| delivery.desktop)
                            != Some(false)
                })
                .map(|n| n.id.clone())
                .collect::<Vec<_>>(),
            s.settings.notifications.toast_duration_seconds,
        )
    });
    let changed = {
        let mut queue = popups.queue.lock().unwrap();
        let removed = queue.retain(|c| is_preview(&c.id) || (enabled && ids.contains(&c.id)));
        let duration_changed = queue.visible.duration_seconds != duration;
        queue.visible.duration_seconds = duration;
        if !removed && !duration_changed {
            None
        } else {
            let batch = &mut queue.visible;
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
    fn card(id: &str) -> NotificationPopupCard {
        NotificationPopupCard {
            id: id.into(),
            title: "Example".into(),
            body: "Example".into(),
            action_label: None,
            tone: String::new(),
            image_url: None,
        }
    }
    fn ids(queue: &PopupQueue) -> Vec<&str> {
        queue
            .visible
            .cards
            .iter()
            .map(|card| card.id.as_str())
            .collect()
    }
    #[test]
    fn popup_bursts_wait_for_space_without_replacing_visible_cards() {
        let mut queue = PopupQueue::default();
        queue
            .enqueue((0..5).map(|n| card(&n.to_string())).collect(), false)
            .unwrap();
        assert_eq!(ids(&queue), ["0", "1", "2"]);
        queue.enqueue(vec![card("5")], false).unwrap();
        assert_eq!(ids(&queue), ["0", "1", "2"]);
        queue.remove("0");
        assert_eq!(ids(&queue), ["1", "2", "3"]);
        queue.remove("1");
        assert_eq!(ids(&queue), ["2", "3", "4"]);
        queue.remove("2");
        assert_eq!(ids(&queue), ["3", "4", "5"]);
        assert!(queue.pending.is_empty());
    }
    #[test]
    fn urgent_popups_appear_immediately_without_discarding_the_displaced_card() {
        let mut queue = PopupQueue::default();
        queue
            .enqueue((0..5).map(|n| card(&n.to_string())).collect(), false)
            .unwrap();
        queue.enqueue(vec![card("match")], false).unwrap();
        queue.prioritize(&["match".into()]);
        assert_eq!(ids(&queue), ["match", "0", "1"]);
        queue.remove("match");
        assert_eq!(ids(&queue), ["0", "1", "2"]);
        assert_eq!(queue.pending.len(), 2);
    }
    #[test]
    fn popup_queue_cancels_pending_cards_and_promotes_after_read_or_clear() {
        let mut queue = PopupQueue::default();
        queue
            .enqueue((0..5).map(|n| card(&n.to_string())).collect(), false)
            .unwrap();
        queue.remove("3");
        assert_eq!(ids(&queue), ["0", "1", "2"]);
        assert!(queue.retain(|card| !["0", "1"].contains(&card.id.as_str())));
        assert_eq!(ids(&queue), ["2", "4"]);
        assert!(queue.retain(|_| false));
        assert!(queue.visible.cards.is_empty());
        assert!(queue.pending.is_empty());
    }
    #[test]
    fn popup_queue_is_bounded_and_duplicate_ids_do_not_consume_slots() {
        let mut queue = PopupQueue::default();
        queue
            .enqueue(
                (0..MAX_CARDS).map(|n| card(&n.to_string())).collect(),
                false,
            )
            .unwrap();
        assert!(queue.enqueue(vec![card("overflow")], false).is_err());
        queue
            .enqueue(vec![card("0"), card("3"), card("3")], false)
            .unwrap();
        assert_eq!(queue.pending.len(), MAX_CARDS - VISIBLE_CARDS);
        assert_eq!(ids(&queue), ["0", "1", "2"]);
    }
    #[test]
    fn held_popup_previews_yield_to_live_cards_and_do_not_hold_their_timer() {
        let mut queue = PopupQueue::default();
        queue.visible.duration_seconds = 5;
        queue
            .enqueue(
                vec![
                    card("preview:one"),
                    card("preview:two"),
                    card("preview:three"),
                ],
                true,
            )
            .unwrap();
        assert_eq!(queue.visible.held_preview_ids.len(), 3);
        queue.enqueue(vec![card("real-1")], false).unwrap();
        assert_eq!(ids(&queue), ["real-1"]);
        assert_eq!(queue.visible.duration_seconds, 5);
        assert!(queue.visible.held_preview_ids.is_empty());
        assert!(queue.pending.is_empty());
    }
    #[test]
    fn preview_ids_are_bounded_and_separate_from_real_notifications() {
        assert!(is_preview("preview"));
        assert!(is_preview("preview:run-1:2"));
        for invalid in [
            "preview:",
            "preview-real",
            "notification-1",
            "preview:<script>",
        ] {
            assert!(!is_preview(invalid));
        }
        assert!(!is_preview(&format!("preview:{}", "x".repeat(97))));
    }
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
