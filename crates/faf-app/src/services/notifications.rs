use std::sync::atomic::{AtomicU64, Ordering};

use faf_domain::state::{
    ClientNotification, NotificationAction, NotificationCommand, NotificationEvent,
    NotificationKind,
};

use crate::runtime::{EventSink, ServiceCtx};

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
    emit(out, kind, title, body, action);
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
    emit(out, kind, title, body, action);
}

fn emit(
    out: &EventSink,
    kind: NotificationKind,
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
        },
    });
}
