//! A single, non-activating desktop popup. It receives presentation data for
//! existing notification ids, never the app snapshot or arbitrary actions.
use faf_domain::state::{
    AuthMode, AuthStatus, ClientNotification, DesktopNotificationStyle, NotificationAction,
    NotificationCommand, NotificationKind, NotificationPreferences, NotificationState,
    ToastPosition,
};
use faf_domain::{AppCommand, AppState};
use faf_ipc::shell::{NotificationDisplay, NotificationPopupBatch, NotificationPopupCard};
use serde::Serialize;
use std::{collections::VecDeque, sync::Mutex};
use tauri::{Emitter, Manager};

pub(crate) const LABEL: &str = "notification-popup";
const UPDATE: &str = "notifications://popup";
const ACTIVATION_READY: &str = "notifications://activation-ready";

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

type PopupOwner = (AuthMode, Option<i32>);

fn popup_owner(state: &AppState) -> Option<PopupOwner> {
    (state.auth.status == AuthStatus::LoggedIn).then(|| {
        (
            state.auth.mode,
            state.auth.player.as_ref().map(|player| player.id),
        )
    })
}

struct PendingActivation {
    item: ClientNotification,
    owner: PopupOwner,
}

#[derive(Default)]
struct PopupQueue {
    visible: NotificationPopupBatch,
    pending: VecDeque<QueuedCard>,
    activations: VecDeque<PendingActivation>,
}

impl PopupQueue {
    /// Run under the current core state read lock, after native window creation.
    fn admit(
        &mut self,
        state: &AppState,
        mut cards: Vec<NotificationPopupCard>,
        preview: bool,
        hold: bool,
        dismiss_label: String,
    ) -> Result<bool, String> {
        self.retain_activations(state);
        let preferences = &state.settings.notifications;
        let eligible_ids = popup_notification_ids(&state.notifications, preferences);
        if !preview {
            cards.retain(|card| {
                eligible_ids.contains(&card.id)
                    && !self
                        .activations
                        .iter()
                        .any(|click| click.item.id == card.id)
            });
        }
        if cards.is_empty() {
            return Ok(false);
        }
        // Enqueue can promote pending cards too. Prune stale ones first.
        self.refresh(&eligible_ids, preferences.toast_duration_seconds);
        self.enqueue(cards, hold)?;
        if !preview {
            let immediate = state
                .notifications
                .items
                .iter()
                .filter(|item| {
                    matches!(
                        item.kind,
                        NotificationKind::MatchFound
                            | NotificationKind::GameFull
                            | NotificationKind::PartyInvite
                    )
                })
                .map(|item| item.id.clone())
                .collect::<Vec<_>>();
            self.prioritize(&immediate);
        }
        self.visible.theme = state.settings.theme;
        self.visible.dismiss_label = dismiss_label;
        Ok(true)
    }

    fn contains_any(&self, ids: &[String]) -> bool {
        self.visible.cards.iter().any(|card| ids.contains(&card.id))
            || self
                .pending
                .iter()
                .any(|queued| ids.contains(&queued.card.id))
    }

    fn retain_activations(&mut self, state: &AppState) {
        let owner = popup_owner(state);
        self.activations.retain(|click| Some(click.owner) == owner);
    }

    /// Reading leaves a click queued. Only the main page acknowledges it after
    /// handling it. The accepted action survives history eviction while the
    /// page rebuilds.
    fn next_activation(
        &mut self,
        state: &AppState,
        acknowledged_id: Option<&str>,
    ) -> Option<ClientNotification> {
        if let Some(id) = acknowledged_id {
            self.activations.retain(|click| click.item.id != id);
        }
        self.retain_activations(state);
        self.activations.front().map(|click| click.item.clone())
    }

    fn reconcile(&mut self, state: &AppState) -> Option<NotificationPopupBatch> {
        self.retain_activations(state);
        self.refresh(
            &popup_notification_ids(&state.notifications, &state.settings.notifications),
            state.settings.notifications.toast_duration_seconds,
        )
    }

    fn revised_batch(&mut self) -> NotificationPopupBatch {
        self.visible.revision = self.visible.revision.wrapping_add(1);
        self.visible.clone()
    }

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

    fn refresh(
        &mut self,
        eligible_ids: &[String],
        duration: u16,
    ) -> Option<NotificationPopupBatch> {
        let removed = self.retain(|card| is_preview(&card.id) || eligible_ids.contains(&card.id));
        let duration_changed = self.visible.duration_seconds != duration;
        self.visible.duration_seconds = duration;
        if !removed && !duration_changed {
            return None;
        }
        Some(self.revised_batch())
    }
}

/// Admission and queue refresh use the same effective desktop preferences.
/// An absent per-event choice inherits the default list, not an unconditional opt-in.
fn popup_notification_ids(
    notifications: &NotificationState,
    preferences: &NotificationPreferences,
) -> Vec<String> {
    if !preferences.enabled
        || !preferences.desktop
        || preferences.desktop_style != DesktopNotificationStyle::Popup
    {
        return Vec::new();
    }
    notifications
        .items
        .iter()
        .filter(|notification| {
            !notification.read
                && preferences
                    .delivery
                    .get(&notification.kind)
                    .and_then(|delivery| delivery.desktop)
                    .unwrap_or_else(|| {
                        preferences.desktop_all_kinds || notification.kind.raises_os_notification()
                    })
        })
        .map(|notification| notification.id.clone())
        .collect()
}

/// What the popup page has confirmed about the batches it was sent.
///
/// `shown` follows its size report, after which the shell shows the window.
/// `painted` follows two animation frames after the cards were laid out.
/// Layout runs whether or not Chromium draws the page, so a webview that had
/// stopped drawing kept confirming batches nobody could see, and every popup
/// after it went to a window that stayed transparent. Chromium runs animation
/// frames only for a page it is drawing.
#[derive(Clone, Copy, Default)]
struct Confirmed {
    shown: u64,
    painted: u64,
}

impl Confirmed {
    fn on_screen(self, revision: u64) -> bool {
        self.shown >= revision && self.painted >= revision
    }
}

pub(crate) struct Popups {
    queue: Mutex<PopupQueue>,
    delivery: tokio::sync::Mutex<()>,
    confirmed: tokio::sync::watch::Sender<Confirmed>,
}

impl Default for Popups {
    fn default() -> Self {
        let (confirmed, _) = tokio::sync::watch::channel(Confirmed::default());
        Self {
            queue: Mutex::new(PopupQueue::default()),
            delivery: tokio::sync::Mutex::new(()),
            confirmed,
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
                | "notification_popup_painted"
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
    let cards: Vec<_> = if preview {
        cards
            .into_iter()
            .filter(|card| is_preview(&card.id))
            .take(VISIBLE_CARDS)
            .collect()
    } else {
        let eligible_ids = core.with_state(|state| {
            popup_notification_ids(&state.notifications, &state.settings.notifications)
        });
        cards
            .into_iter()
            .filter(|card| eligible_ids.contains(&card.id))
            .collect()
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
    let window = popup_window(&app)?;
    tracing::debug!("desktop popup window ready");
    let admitted = {
        let mut queue = popups.queue.lock().unwrap();
        core.with_state(|state| {
            queue.admit(
                state,
                cards,
                preview,
                preview && hold_preview == Some(true),
                dismiss_label,
            )
        })?
    };
    if !admitted {
        refresh(&app);
        return Ok(());
    }
    let mut displayed = display(&app, &requested_ids).await;
    // A page that has stopped drawing does not start again in that window, so
    // it gets one fresh window. Not while the game is in front: a missing
    // frame then usually means the game covers the corner, and building
    // webviews during a match costs more than the client popup is worth.
    if let Err(failure) = &displayed {
        if !core.game_is_focused() {
            tracing::warn!(%failure, "desktop popup not on screen; recreating its window");
            displayed = match replace_window(&app, window).await {
                Ok(_) => display(&app, &requested_ids).await,
                Err(error) => Err(error),
            };
        }
    }
    if let Err(failure) = displayed {
        tracing::warn!(%failure, "desktop popup not on screen");
        // Do not let a late page load display the same cards after fallback.
        for id in requested_ids {
            let _ = notification_popup_interact(app.clone(), id, "expire".into());
        }
        // Recreate the page on the next attempt, rather than keeping a broken
        // window for the rest of this session.
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.destroy();
        }
        return Err("The desktop notification window could not be displayed".into());
    }
    Ok(())
}

/// The popup window, built hidden on first use.
fn popup_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        tracing::debug!("reusing desktop popup window");
        return Ok(window);
    }
    tracing::debug!("creating desktop popup window");
    tauri::WebviewWindowBuilder::new(
        app,
        LABEL,
        tauri::WebviewUrl::App("notifications.html".into()),
    )
    .title("FAForever notifications")
    .inner_size(POPUP_WIDTH, 160.0)
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
    })
}

/// Destroy the popup window and build a new one around a fresh page.
///
/// The label is fixed, since the popup's capability names it, so the new
/// window can only be built once the old one has left the window list.
async fn replace_window(
    app: &tauri::AppHandle,
    old: tauri::WebviewWindow,
) -> Result<tauri::WebviewWindow, String> {
    old.destroy().map_err(|e| e.to_string())?;
    drop(old);
    for _ in 0..20 {
        if app.get_webview_window(LABEL).is_none() {
            return popup_window(app);
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Err("The previous desktop notification window did not close".into())
}

/// Send the current stack to the page and wait until it is on screen.
///
/// Every attempt gets a new revision, so a confirmation from a page that was
/// replaced cannot vouch for the one that replaced it.
async fn display(app: &tauri::AppHandle, requested_ids: &[String]) -> Result<(), String> {
    refresh(app);
    let popups = app.state::<Popups>();
    let mut confirmed = popups.confirmed.subscribe();
    let batch = {
        let mut queue = popups.queue.lock().unwrap();
        if !queue.contains_any(requested_ids) {
            return Ok(());
        }
        queue.revised_batch()
    };
    // A successful build alone does not prove the page loaded, was shown or
    // was drawn. Wait for both confirmations before suppressing the OS
    // fallback.
    publish(app, &batch)?;
    let waited = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let on_screen = confirmed.borrow().on_screen(batch.revision);
            if on_screen || !popups.queue.lock().unwrap().contains_any(requested_ids) {
                return Ok::<(), String>(());
            }
            confirmed.changed().await.map_err(|e| e.to_string())?;
        }
    })
    .await;
    match waited {
        Ok(result) => result,
        Err(_) if confirmed.borrow().shown >= batch.revision => Err(format!(
            "revision {} was laid out and shown but never drawn",
            batch.revision
        )),
        Err(_) => Err(format!("revision {} was never laid out", batch.revision)),
    }
}

#[tauri::command]
pub(crate) fn notification_popup_snapshot(app: tauri::AppHandle) -> NotificationPopupBatch {
    refresh(&app);
    app.state::<Popups>().queue.lock().unwrap().visible.clone()
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
    let mut queue = popups.queue.lock().unwrap();
    let (changed, preferences) = app
        .state::<crate::Core>()
        .0
        .with_state(|state| (queue.reconcile(state), state.settings.notifications.clone()));
    if let Some(batch) = changed {
        drop(queue);
        return publish(&app, &batch);
    }
    let batch = &queue.visible;
    if batch.revision != revision || batch.cards.is_empty() {
        return Ok(());
    }
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
    popups
        .confirmed
        .send_modify(|confirmed| confirmed.shown = confirmed.shown.max(revision));
    Ok(())
}

/// The page drew `revision`: two animation frames ran after its cards were
/// laid out, and Chromium runs those only for a page it is drawing.
#[tauri::command]
pub(crate) fn notification_popup_painted(popups: tauri::State<'_, Popups>, revision: u64) {
    tracing::debug!(revision, "desktop popup drawn");
    popups
        .confirmed
        .send_modify(|confirmed| confirmed.painted = confirmed.painted.max(revision));
}

/// The popup window's width in logical pixels, its cards' padding included.
/// Wide enough for a card with map art to keep a message beside an action as
/// long as "Start when replay ready".
const POPUP_WIDTH: f64 = 440.0;

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
    let width = ((POPUP_WIDTH * scale).round() as u32).min(size.0).max(1);
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

/// Main renderer only. It subscribes before fetching so an activation made
/// between window registration and mounting the consumer stays deliverable.
#[tauri::command]
pub(crate) fn notification_popup_next_activation(
    core: tauri::State<'_, crate::Core>,
    popups: tauri::State<'_, Popups>,
    acknowledged_id: Option<String>,
) -> Option<ClientNotification> {
    let mut queue = popups.queue.lock().unwrap();
    core.0
        .with_state(|state| queue.next_activation(state, acknowledged_id.as_deref()))
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
    let core = app.state::<crate::Core>();
    let preview = is_preview(&id);
    let (batch, interaction_result) = {
        let mut queue = popups.queue.lock().unwrap();
        // A card made visible by reconciliation has not been shown yet.
        let was_visible = queue.visible.cards.iter().any(|card| card.id == id);
        let (changed, activation) = core.0.with_state(|state| {
            // Removal may promote another card. Check live preferences and
            // history first, even if the event forwarder has not caught up.
            let changed = queue.reconcile(state);
            let activation = if !preview && interaction == "activate" {
                popup_owner(state).and_then(|owner| {
                    state
                        .notifications
                        .items
                        .iter()
                        .find(|item| item.id == id)
                        .map(|item| PendingActivation {
                            item: item.clone(),
                            owner,
                        })
                })
            } else {
                None
            };
            (changed, activation)
        });
        let visible = was_visible && queue.visible.cards.iter().any(|card| card.id == id);
        let queued_expiry =
            interaction == "expire" && queue.pending.iter().any(|queued| queued.card.id == id);
        if !(visible || queued_expiry) {
            (changed, Ok(None))
        } else {
            let mut open_main = false;
            let handled =
                match (interaction.as_str(), activation) {
                    ("activate", Some(click))
                        if matches!(click.item.action, Some(NotificationAction::FocusGame)) =>
                    {
                        core.0.focus_game().and_then(|()| {
                            core.0.try_dispatch(AppCommand::Notifications(
                                NotificationCommand::MarkRead { id: id.clone() },
                            ))
                        })
                    }
                    ("activate", Some(_)) if queue.activations.len() >= MAX_CARDS => {
                        Err("Desktop notification action queue is full".into())
                    }
                    ("activate", Some(click)) => {
                        queue.activations.push_back(click);
                        open_main = true;
                        Ok(())
                    }
                    ("dismiss", _) if !preview => core.0.try_dispatch(AppCommand::Notifications(
                        NotificationCommand::Dismiss { id: id.clone() },
                    )),
                    _ => Ok(()),
                };
            let batch = if handled.is_ok() {
                queue.remove(&id);
                Some(queue.revised_batch())
            } else {
                changed
            };
            (batch, handled.map(|()| Some(open_main)))
        }
    };
    let updated = batch.map_or(Ok(()), |batch| publish(&app, &batch));
    if let Some(open_main) = interaction_result? {
        if open_main {
            crate::tray::restore_main_window(&app);
            if let Some(main) = crate::window::main_window(&app) {
                // This is a wake-up, not the only copy of the click.
                let _ = main.emit_to(
                    tauri::EventTarget::webview_window(main.label()),
                    ACTIVATION_READY,
                    (),
                );
            }
        } else if preview {
            if let Some(main) = crate::window::main_window(&app) {
                main.emit_to(
                    tauri::EventTarget::webview_window(main.label()),
                    "notifications://interact",
                    Interaction { id, interaction },
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    updated
}

fn publish(app: &tauri::AppHandle, batch: &NotificationPopupBatch) -> Result<(), String> {
    let popups = app.state::<Popups>();
    let queue = popups.queue.lock().unwrap();
    if queue.visible.revision != batch.revision {
        return Ok(());
    }
    // Wake a pending display even when the new stack is empty and the popup
    // page has no batch to paint. A cleared card does not need OS fallback.
    popups.confirmed.send_modify(|_| {});
    if let Some(window) = app.get_webview_window(LABEL) {
        let emitted = window.emit_to(tauri::EventTarget::webview_window(LABEL), UPDATE, batch);
        let hidden = if batch.cards.is_empty() {
            window.hide()
        } else {
            Ok(())
        };
        emitted.and(hidden).map_err(|e| e.to_string())?;
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
    let Some(core) = app.try_state::<crate::Core>() else {
        return;
    };
    let changed = {
        let mut queue = popups.queue.lock().unwrap();
        core.0.with_state(|state| queue.reconcile(state))
    };
    if let Some(batch) = changed {
        let _ = publish(app, &batch);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use faf_domain::state::NotificationDelivery;

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

    fn notice(id: &str, kind: NotificationKind) -> ClientNotification {
        ClientNotification {
            id: id.into(),
            kind,
            title: "Example".into(),
            body: "Example".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            read: false,
            action: None,
            text: None,
        }
    }

    #[test]
    fn popup_activation_waits_for_acknowledgement() {
        let mut state = AppState::default();
        state.auth.status = AuthStatus::LoggedIn;
        state.auth.mode = AuthMode::Offline;
        state.notifications.items = ["first", "second"]
            .map(|id| notice(id, NotificationKind::MatchFound))
            .into();
        let owner = popup_owner(&state).unwrap();
        let mut queue = PopupQueue::default();
        queue.activations.extend(
            state
                .notifications
                .items
                .iter()
                .cloned()
                .map(|item| PendingActivation { item, owner }),
        );

        // The renderer can disappear after seeing the first click. Its
        // replacement sees the same one until it acknowledges handling it.
        assert_eq!(queue.next_activation(&state, None).unwrap().id, "first");
        state.notifications.items.remove(0);
        assert_eq!(queue.next_activation(&state, None).unwrap().id, "first");
        assert_eq!(
            queue.next_activation(&state, Some("first")).unwrap().id,
            "second"
        );

        // A different session must not inherit an unhandled click even if
        // the old notice still appears in the retained history.
        state.auth.mode = AuthMode::Account;
        assert!(queue.next_activation(&state, None).is_none());
        assert!(queue.activations.is_empty());
    }

    #[test]
    fn popup_admission_rechecks_cards_after_a_clear_or_opt_out() {
        let mut state = AppState::default();
        state.settings.notifications = NotificationPreferences {
            desktop_all_kinds: true,
            ..Default::default()
        };
        state.notifications.items = vec![notice("arrival", NotificationKind::MatchFound)];
        assert_eq!(
            popup_notification_ids(&state.notifications, &state.settings.notifications),
            ["arrival"]
        );
        for clear in [false, true] {
            let mut current = state.clone();
            if clear {
                current.notifications.items.clear();
            } else {
                current.settings.notifications.desktop = false;
            }
            let mut queue = PopupQueue::default();
            assert!(!queue
                .admit(&current, vec![card("arrival")], false, false, String::new())
                .unwrap());
            assert!(!queue.contains_any(&["arrival".into()]));
        }
    }

    #[test]
    fn narrowing_desktop_delivery_prunes_visible_and_pending_inherited_alerts() {
        let notifications = NotificationState {
            items: vec![
                notice("friend-visible", NotificationKind::FriendOnline),
                notice("match-visible", NotificationKind::MatchFound),
                notice("opted-visible", NotificationKind::FriendJoinedGame),
                notice("friend-pending", NotificationKind::FriendOnline),
                notice("match-pending", NotificationKind::MatchFound),
                notice("opted-pending", NotificationKind::FriendJoinedGame),
                notice("muted-pending", NotificationKind::GameFull),
            ],
        };
        let mut preferences = NotificationPreferences {
            desktop_all_kinds: true,
            ..Default::default()
        };
        let mut queue = PopupQueue::default();
        queue
            .enqueue(
                popup_notification_ids(&notifications, &preferences)
                    .iter()
                    .map(|id| card(id))
                    .collect(),
                false,
            )
            .unwrap();
        assert_eq!(
            ids(&queue),
            ["friend-visible", "match-visible", "opted-visible"]
        );

        preferences.desktop_all_kinds = false;
        preferences.delivery.insert(
            NotificationKind::FriendJoinedGame,
            NotificationDelivery {
                desktop: Some(true),
                ..Default::default()
            },
        );
        preferences.delivery.insert(
            NotificationKind::GameFull,
            NotificationDelivery {
                desktop: Some(false),
                ..Default::default()
            },
        );
        let batch = queue
            .refresh(
                &popup_notification_ids(&notifications, &preferences),
                preferences.toast_duration_seconds,
            )
            .unwrap();
        assert_eq!(batch.cards.len(), VISIBLE_CARDS);
        assert_eq!(
            ids(&queue),
            ["match-visible", "opted-visible", "match-pending"]
        );
        assert_eq!(queue.pending.len(), 1);
        assert_eq!(queue.pending[0].card.id, "opted-pending");
        queue.remove("match-visible");
        assert_eq!(
            ids(&queue),
            ["opted-visible", "match-pending", "opted-pending"]
        );
        // Delivery changes remove popup copies, not the notification history.
        assert_eq!(notifications.items.len(), 7);
        assert!(notifications.items.iter().all(|item| !item.read));
    }

    #[test]
    fn narrowing_desktop_delivery_prunes_pending_only_alerts_without_resending_visible_cards() {
        let notifications = NotificationState {
            items: vec![
                notice("match", NotificationKind::MatchFound),
                notice("full", NotificationKind::GameFull),
                notice("invite", NotificationKind::PartyInvite),
                notice("friend", NotificationKind::FriendOnline),
            ],
        };
        let mut preferences = NotificationPreferences {
            desktop_all_kinds: true,
            ..Default::default()
        };
        let mut queue = PopupQueue::default();
        queue.visible.duration_seconds = preferences.toast_duration_seconds;
        queue
            .enqueue(
                notifications
                    .items
                    .iter()
                    .map(|item| card(&item.id))
                    .collect(),
                false,
            )
            .unwrap();
        preferences.desktop_all_kinds = false;
        assert!(queue
            .refresh(
                &popup_notification_ids(&notifications, &preferences),
                preferences.toast_duration_seconds,
            )
            .is_none());
        assert!(queue.pending.is_empty());
        queue.remove("match");
        assert_eq!(ids(&queue), ["full", "invite"]);
    }

    #[test]
    fn popup_refresh_honors_global_switches_and_style_without_removing_inspection_previews() {
        let notifications = NotificationState {
            items: vec![notice("match", NotificationKind::MatchFound)],
        };
        for preferences in [
            NotificationPreferences {
                enabled: false,
                ..Default::default()
            },
            NotificationPreferences {
                desktop: false,
                ..Default::default()
            },
            NotificationPreferences {
                desktop_style: DesktopNotificationStyle::System,
                ..Default::default()
            },
        ] {
            let mut queue = PopupQueue::default();
            queue.enqueue(vec![card("match")], false).unwrap();
            queue
                .enqueue(vec![card("preview:inspection")], true)
                .unwrap();
            assert!(queue
                .refresh(
                    &popup_notification_ids(&notifications, &preferences),
                    preferences.toast_duration_seconds,
                )
                .is_some());
            assert_eq!(ids(&queue), ["preview:inspection"]);
            assert_eq!(queue.visible.held_preview_ids, ["preview:inspection"]);
            assert!(queue.pending.is_empty());
        }
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
    fn a_batch_is_on_screen_only_once_the_page_has_drawn_it() {
        let confirmed = |shown, painted| Confirmed { shown, painted };
        // Laid out and shown, but no frame: the transparent window shows nothing.
        assert!(!confirmed(4, 3).on_screen(4));
        assert!(!confirmed(3, 4).on_screen(4));
        assert!(confirmed(4, 4).on_screen(4));
        // A later batch vouches for an earlier one, never the other way round.
        assert!(confirmed(6, 6).on_screen(4));
        assert!(!confirmed(4, 4).on_screen(5));
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
            (-880, 1120, 880, 320)
        );
        assert_eq!(
            popup_bounds((0, 30), (1920, 1010), 1.0, ToastPosition::TopLeft, 160.0),
            (0, 30, 440, 160)
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
        assert!(allowed(LABEL, "notification_popup_painted", false));
        assert!(!allowed(LABEL, "notification_popup_next_activation", false));
        assert!(allowed("main-2", "snapshot", true));
        assert!(!allowed("unknown", "notification_popup_snapshot", false));
    }
}
