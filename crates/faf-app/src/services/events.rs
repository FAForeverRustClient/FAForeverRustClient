//! Community calendar orchestration.
//!
//! Three jobs:
//!
//! 1. **Load the catalogue**, and make sure the other two sources of the
//!    calendar are loaded too. Tournaments and the changelog index are owned by
//!    other services, so this one asks them rather than fetching either again:
//!    the calendar then shows a tournament the moment the Tournaments tab has
//!    ever been opened, and loads it itself when it has not. Same shape as the
//!    training hub asking the tutorials service for FAF's lessons.
//!
//! 2. **Hold the view.** Which of the three views is open, which day it is
//!    anchored on, and what it is filtered to. Pure command to event.
//!
//! 3. **Raise reminders.** A reminder is the one thing on this tab that has to
//!    happen while the player is looking at something else, so it is a ticker
//!    rather than a reaction to anything: see [`spawn`].

use std::sync::Arc;
use std::time::Duration;

use faf_domain::state::{
    ChangelogCommand, EventReminder, EventsCommand, EventsEvent, EventsPreferences,
    NotificationAction, NotificationKind, SettingsEvent, TourneyCommand,
};

use crate::runtime::{EventSink, ServiceCtx};
use crate::services;

pub async fn handle(cmd: EventsCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        EventsCommand::Load => load(ctx, out).await,
        EventsCommand::SetView { view } => out.emit(EventsEvent::ViewChanged { view }),
        EventsCommand::SetAnchor { day } => out.emit(EventsEvent::AnchorChanged { day }),
        EventsCommand::SetQuery { query } => out.emit(EventsEvent::QueryChanged { query }),
        EventsCommand::Select { occurrence_id } => {
            out.emit(EventsEvent::Selected { occurrence_id })
        }
        EventsCommand::Remind {
            occurrence_id,
            title,
            starts_at,
            lead_minutes,
        } => {
            let mut preferences = out.with_state(|state| state.settings.events.clone());
            preferences.set_reminder(EventReminder {
                occurrence_id,
                title,
                starts_at,
                lead_minutes,
                notified: false,
            });
            write(ctx, out, preferences).await;
        }
        EventsCommand::Forget { occurrence_id } => {
            let mut preferences = out.with_state(|state| state.settings.events.clone());
            preferences.clear_reminder(&occurrence_id);
            write(ctx, out, preferences).await;
        }
    }
}

/// Fetch the catalogue, and top up the two sources that are not ours.
async fn load(ctx: &ServiceCtx, out: &EventSink) {
    out.emit(EventsEvent::Loading);
    match ctx.ports.events.list_catalogue().await {
        Ok(catalogue) => out.emit(EventsEvent::Loaded { catalogue }),
        Err(reason) => out.emit(EventsEvent::LoadFailed { reason }),
    }

    // After the catalogue, not before: this is the tab's own content and the
    // other two are a bonus on top of it. Only when the slice is empty, because
    // the tab is re-entered constantly and a tournament list is a large read;
    // an already-loaded list may be minutes old, which for an event weeks away
    // is close enough to ask nobody again for.
    let (needs_tourneys, needs_releases) = out.with_state(|state| {
        (
            state.tourney.events.is_empty(),
            state.changelog.releases.is_empty(),
        )
    });
    if needs_tourneys {
        services::tourney::handle(TourneyCommand::Load, ctx, out).await;
    }
    if needs_releases {
        services::changelog::handle(ChangelogCommand::Load, ctx, out).await;
    }
}

/// Record changed reminders and write them to disk.
///
/// Through the reducer rather than straight to the port, so the switch on the
/// entry and the file always say the same thing.
async fn write(ctx: &ServiceCtx, out: &EventSink, preferences: EventsPreferences) {
    out.emit(SettingsEvent::EventsChanged {
        preferences: Box::new(preferences),
    });
    services::settings::persist(ctx, out).await;
}

/// How often the ticker looks at the reminder list.
///
/// A reminder is set in whole minutes, so half a minute is the coarsest tick
/// that cannot be visibly late. A tick reads a vector that is almost always
/// empty and does nothing else.
const TICK: Duration = Duration::from_secs(30);

/// Start the reminder ticker. Called once from the runtime loop; lives for the
/// process.
///
/// State-driven, like the Discord presence and the reconnect watchdog: "this
/// reminder is due and has not been raised" is a property of the current
/// snapshot, and rebuilding it from a stream of deltas would only add ways to
/// miss one. It is also the reason a raised reminder is written to disk: a
/// client restarted between the reminder and the event must not repeat it, and
/// one restarted before the reminder must still raise it.
pub fn spawn(ctx: Arc<ServiceCtx>, sink: EventSink) {
    tokio::spawn(async move { run(ctx, sink).await });
}

async fn run(ctx: Arc<ServiceCtx>, sink: EventSink) {
    let mut ticker = tokio::time::interval(TICK);
    loop {
        ticker.tick().await;
        let now = services::now_seconds();
        let due = sink.with_state(|state| due_reminders(&state.settings.events, now));
        if due.is_empty() {
            continue;
        }
        for reminder in &due {
            services::notifications::add_required(
                &sink,
                NotificationKind::EventReminder,
                reminder.title.clone(),
                reminder_body(reminder, now),
                Some(NotificationAction::OpenEvent {
                    occurrence_id: reminder.occurrence_id.clone(),
                }),
            );
        }
        let mut preferences = sink.with_state(|state| state.settings.events.clone());
        for reminder in &due {
            if let Some(stored) = preferences
                .reminders
                .iter_mut()
                .find(|stored| stored.occurrence_id == reminder.occurrence_id)
            {
                stored.notified = true;
            }
        }
        write(&ctx, &sink, preferences.pruned(now)).await;
    }
}

/// The reminders that are due now and have not been raised.
///
/// A reminder whose event has already started is still raised, once: the client
/// may have been closed when it came due, and "it starts now" is more useful
/// than silence. One whose event is more than an hour gone is not, because at
/// that point the notification would be about something that is over.
fn due_reminders(preferences: &EventsPreferences, now: u32) -> Vec<EventReminder> {
    const TOO_LATE: u32 = 60 * 60;
    preferences
        .reminders
        .iter()
        .filter(|reminder| {
            !reminder.notified
                && reminder.due_at() <= now
                && reminder.starts_at.saturating_add(TOO_LATE) > now
        })
        .cloned()
        .collect()
}

/// What the notification says under the title.
fn reminder_body(reminder: &EventReminder, now: u32) -> String {
    let remaining = reminder.starts_at.saturating_sub(now);
    if remaining == 0 {
        return "Starting now.".to_string();
    }
    let minutes = remaining / 60;
    if minutes < 60 {
        let minutes = minutes.max(1);
        return format!(
            "Starts in {minutes} minute{}.",
            if minutes == 1 { "" } else { "s" }
        );
    }
    let hours = minutes / 60;
    if hours < 48 {
        return format!(
            "Starts in {hours} hour{}.",
            if hours == 1 { "" } else { "s" }
        );
    }
    let days = hours / 24;
    format!("Starts in {days} day{}.", if days == 1 { "" } else { "s" })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reminder(occurrence_id: &str, starts_at: u32, lead_minutes: u32) -> EventReminder {
        EventReminder {
            occurrence_id: occurrence_id.into(),
            title: "Dojo 1v1 Night".into(),
            starts_at,
            lead_minutes,
            notified: false,
        }
    }

    #[test]
    fn a_reminder_comes_due_at_its_lead_time() {
        let preferences = EventsPreferences {
            reminders: vec![reminder("a", 10_000, 60)],
            ..EventsPreferences::default()
        };
        assert!(due_reminders(&preferences, 6_300).is_empty(), "too early");
        assert_eq!(due_reminders(&preferences, 6_400).len(), 1, "on the minute");
        assert_eq!(due_reminders(&preferences, 9_999).len(), 1, "still due");
    }

    #[test]
    fn a_reminder_already_raised_is_not_raised_again() {
        let preferences = EventsPreferences {
            reminders: vec![EventReminder {
                notified: true,
                ..reminder("a", 10_000, 60)
            }],
            ..EventsPreferences::default()
        };
        assert!(due_reminders(&preferences, 9_000).is_empty());
    }

    #[test]
    fn a_reminder_for_something_long_over_is_dropped_rather_than_raised() {
        // The client was closed through the whole window. Telling somebody
        // about a game night that finished yesterday is worse than nothing.
        let preferences = EventsPreferences {
            reminders: vec![reminder("a", 10_000, 60)],
            ..EventsPreferences::default()
        };
        assert_eq!(due_reminders(&preferences, 13_000).len(), 1, "just missed");
        assert!(due_reminders(&preferences, 20_000).is_empty(), "long gone");
    }

    #[test]
    fn the_body_says_how_long_is_left() {
        let one = reminder("a", 10_000, 60);
        assert_eq!(reminder_body(&one, 10_000), "Starting now.");
        assert_eq!(reminder_body(&one, 9_940), "Starts in 1 minute.");
        assert_eq!(reminder_body(&one, 8_200), "Starts in 30 minutes.");
        assert_eq!(reminder_body(&one, 3_000), "Starts in 1 hour.");
        let far = reminder("b", 1_000_000, 10_080);
        assert_eq!(reminder_body(&far, 400_000), "Starts in 6 days.");
    }
}
