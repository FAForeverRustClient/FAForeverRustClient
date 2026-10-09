use std::sync::atomic::{AtomicU64, Ordering};

use faf_domain::state::{
    ClientNotification, NotificationAction, NotificationCommand, NotificationEvent,
    NotificationKind, NotificationText,
};

use crate::runtime::{EventSink, ServiceCtx};

/// Short for the call sites: `notifications::Text::new("notifications.msg.x")`.
pub use faf_domain::state::NotificationText as Text;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub async fn handle(cmd: NotificationCommand, _ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        NotificationCommand::MarkRead { id } => out.emit(NotificationEvent::Read { id }),
        NotificationCommand::Dismiss { id } => out.emit(NotificationEvent::Dismissed { id }),
        NotificationCommand::Clear => out.emit(NotificationEvent::Cleared),
    }
}

pub fn add(
    out: &EventSink,
    kind: NotificationKind,
    title: impl Into<String>,
    body: impl Into<String>,
    action: Option<NotificationAction>,
) {
    if !out.with_state(|state| state.settings.notifications.enabled) {
        return;
    }
    emit(out, kind, None, title, body, action);
}

/// `add` with the catalog entry the UI translates it from (#458). `title`
/// and `body` are the same text in English.
pub fn add_text(
    out: &EventSink,
    kind: NotificationKind,
    text: NotificationText,
    title: impl Into<String>,
    body: impl Into<String>,
    action: Option<NotificationAction>,
) {
    if !out.with_state(|state| state.settings.notifications.enabled) {
        return;
    }
    emit(out, kind, Some(text), title, body, action);
}

/// A failure whose body is a reason the client itself produced: an OS error,
/// the HTTP client's English, a tool's complaint. Never the server's own
/// words, such as a kick or a ban.
///
/// The reason travels as the entry's `reason` parameter as well as the
/// English body. That parameter is what tells the UI the body is a failure
/// reason it may word plainly, keeping the original on hover; a body without
/// it is shown as sent. See `notificationText.ts`.
pub fn add_failure(
    out: &EventSink,
    text: NotificationText,
    title: impl Into<String>,
    reason: impl Into<String>,
) {
    let reason = reason.into();
    add_text(
        out,
        NotificationKind::Error,
        text.with("reason", &reason),
        title,
        reason,
        None,
    );
}

/// [`add_failure`] for a failure that must be read whatever the alert
/// settings say: a game, a replay or a search that did not start. Marked the
/// same way, so the UI words the reason plainly here too, and with the action
/// that leads back to what failed.
pub fn add_required_failure(
    out: &EventSink,
    text: NotificationText,
    title: impl Into<String>,
    reason: impl Into<String>,
    action: Option<NotificationAction>,
) {
    let reason = reason.into();
    add_required_text(
        out,
        NotificationKind::Error,
        text.with("reason", &reason),
        title,
        reason,
        action,
    );
}

/// Retain an operational message even when optional event alerts are disabled.
/// Server rejections and forced game termination must never disappear because
/// the user turned off match and chat notifications.
pub fn add_required(
    out: &EventSink,
    kind: NotificationKind,
    title: impl Into<String>,
    body: impl Into<String>,
    action: Option<NotificationAction>,
) {
    emit(out, kind, None, title, body, action);
}

/// `add_required` with the catalog entry the UI translates it from (#458).
pub fn add_required_text(
    out: &EventSink,
    kind: NotificationKind,
    text: NotificationText,
    title: impl Into<String>,
    body: impl Into<String>,
    action: Option<NotificationAction>,
) {
    emit(out, kind, Some(text), title, body, action);
}

fn emit(
    out: &EventSink,
    kind: NotificationKind,
    text: Option<NotificationText>,
    title: impl Into<String>,
    body: impl Into<String>,
    action: Option<NotificationAction>,
) {
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let created_at = chrono::Utc::now().to_rfc3339();
    out.emit(NotificationEvent::Added {
        notification: ClientNotification {
            id: format!("{created_at}-{sequence}"),
            kind,
            title: title.into(),
            body: body.into(),
            created_at,
            read: false,
            action,
            text,
        },
    });
}
