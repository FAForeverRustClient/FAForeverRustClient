//! The events calendar: which day a week starts on, and the reminders the
//! client has promised to raise.

use super::*;

/// Which day a calendar week starts on.
///
/// A preference rather than a locale lookup because the issue asked for one,
/// and because the answer is not always the locale's: FAF's own weekend events
/// are talked about in a Monday-first week regardless of where the player is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum WeekStart {
    #[default]
    Monday,
    Sunday,
}

/// How long a reminder is kept after its event, in seconds (a week).
///
/// Long enough that a reminder is still in the list while somebody wonders
/// whether it fired, short enough that the settings file does not accumulate
/// every event this client ever saw.
const REMINDER_RETENTION: u32 = 7 * 24 * 60 * 60;

/// One reminder this client will raise, and has to survive a restart.
///
/// It carries the title and the start rather than an id to look up, because the
/// occurrence it names is not always in the events slice: a tournament comes
/// from the tournament service and a released patch from the changelog. The
/// ticker needs what to say and when, and nothing else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EventReminder {
    /// The occurrence key: `catalogue:<id>@<unix start>`, `tourney:<id>` or
    /// `patch:<id>`, as `ui/src/features/events/calendarFeed.ts` builds them.
    ///
    /// One reminder per *occurrence* rather than per event, so a weekly game
    /// night can be watched for one week only. The start rather than the date
    /// is in the key so that it does not depend on the reader's time zone.
    pub occurrence_id: String,
    pub title: String,
    /// Unix seconds the occurrence starts at.
    pub starts_at: u32,
    /// How far ahead to raise it, in minutes.
    pub lead_minutes: u32,
    /// Whether it has already been raised.
    ///
    /// Persisted, so a client that is restarted between the reminder and the
    /// event does not repeat it, and one restarted before the reminder still
    /// raises it.
    #[serde(default)]
    pub notified: bool,
}

impl EventReminder {
    /// The moment this reminder is due, in Unix seconds.
    pub fn due_at(&self) -> u32 {
        self.starts_at
            .saturating_sub(self.lead_minutes.saturating_mul(60))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EventsPreferences {
    pub week_start: WeekStart,
    pub reminders: Vec<EventReminder>,
}

impl EventsPreferences {
    /// Add a reminder, or change the lead time of one already set.
    ///
    /// Changing the lead time clears `notified`: somebody who moves a reminder
    /// from a day to a week ahead is asking to be told, and the earlier moment
    /// has usually not passed yet.
    pub fn set_reminder(&mut self, reminder: EventReminder) {
        match self
            .reminders
            .iter_mut()
            .find(|existing| existing.occurrence_id == reminder.occurrence_id)
        {
            Some(existing) => {
                let same_lead = existing.lead_minutes == reminder.lead_minutes;
                *existing = EventReminder {
                    notified: same_lead && existing.notified,
                    ..reminder
                };
            }
            None => self.reminders.push(reminder),
        }
    }

    pub fn clear_reminder(&mut self, occurrence_id: &str) {
        self.reminders
            .retain(|reminder| reminder.occurrence_id != occurrence_id);
    }

    pub fn reminder(&self, occurrence_id: &str) -> Option<&EventReminder> {
        self.reminders
            .iter()
            .find(|reminder| reminder.occurrence_id == occurrence_id)
    }

    /// Drop reminders for occurrences that are well past, and any duplicate.
    ///
    /// `now` rather than a call to the clock, because this type is in the
    /// domain and the domain does not read the wall clock. Zero leaves
    /// everything in place, which is what a test that does not care wants.
    pub fn pruned(mut self, now: u32) -> Self {
        let mut seen: Vec<String> = Vec::new();
        self.reminders.retain(|reminder| {
            let stale = now > 0 && reminder.starts_at.saturating_add(REMINDER_RETENTION) < now;
            let duplicate = seen.contains(&reminder.occurrence_id);
            seen.push(reminder.occurrence_id.clone());
            !stale && !duplicate
        });
        self
    }
}

preference_patch! {
    /// A change to [`EventsPreferences`]. The settings tab only ever names the
    /// week start; the reminder list belongs to the Events tab's own commands.
    EventsPreferencesPatch for EventsPreferences {
        week_start: WeekStart,
        reminders: Vec<EventReminder>,
    }
}
