//! Events slice: the community calendar.
//!
//! The tab answers one question: what is happening in FAF, and when. Three
//! kinds of answer feed it, and only one of them is fetched here.
//!
//! 1. **Tournaments** are already in the client. `TourneyState` carries the
//!    event date, the signup window and the check-in window of every published
//!    event, so the calendar reads them out of state rather than asking anybody
//!    for them again.
//! 2. **Released patches** are already in the client too, as the dated entries
//!    of the changelog index.
//! 3. **Everything else** (CGN, meetups, a club's game night, a ladder pool
//!    rotation, a patch somebody knows the date of) has no service behind it at
//!    all. That is what this slice holds: a catalogue document, fetched from a
//!    Git repository exactly like the training catalogue, where adding an event
//!    is a commit rather than a client release.
//!
//! The merge of the three lives in the view, because that is the only consumer:
//! see `ui/src/features/events/calendarFeed.ts`. What lives here is the part
//! that needs IO (the catalogue) and the part that is application state (which
//! view is open, what it is filtered to, and which day it is anchored on).
//!
//! What is deliberately absent: telling other people you are coming. No FAF
//! service would carry it, and the events that do have signups are tournaments,
//! whose signup lives in the Tournaments tab and is linked from the entry. A
//! reminder is the part the client can honestly do alone, and it lives in
//! [`crate::state::settings::EventsPreferences`] because it has to survive a
//! restart to be worth anything.

use serde::{Deserialize, Serialize};
use specta::Type;

/// What sort of thing an entry is.
///
/// The list the issue asked for, plus the ladder pool rotation, which is the
/// one recurring date the client can state without being told: FAF rotates the
/// pool on the first of the month.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EventCategory {
    /// A game patch: released, or announced for a date.
    Patch,
    /// A tournament, whether it came from the tournament service or the
    /// catalogue.
    Tournament,
    /// A get-together, online or in person.
    Meetup,
    /// Community Game Night.
    Cgn,
    /// The ladder map pool rotating.
    LadderPool,
    #[default]
    Other,
}

impl EventCategory {
    /// Read leniently: a catalogue is edited by hand, and a category this build
    /// does not know is an entry that still belongs on the calendar.
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "patch" => Self::Patch,
            "tournament" => Self::Tournament,
            "meetup" => Self::Meetup,
            "cgn" => Self::Cgn,
            "ladderpool" | "ladder_pool" | "ladder-pool" => Self::LadderPool,
            _ => Self::Other,
        }
    }
}

/// Who is running it. Drawn as a tag, exactly as the issue asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EventOrigin {
    /// FAF itself: a patch, an FAF-run tournament, an announcement from the
    /// association.
    Official,
    /// Anybody else: a club, a Discord, a player.
    #[default]
    Community,
}

impl EventOrigin {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "official" => Self::Official,
            _ => Self::Community,
        }
    }
}

/// One button on an entry: join the Discord, read the rules, watch the stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EventLink {
    pub label: String,
    /// An `https` address. Checked by the boundary that reads the catalogue,
    /// never here: this type holds what was published, and the reader decides
    /// what it is willing to offer.
    pub url: String,
}

/// How an entry repeats.
///
/// Deliberately two rules and no more. Everything the thread named is one of
/// them: a weekly game night, and a monthly pool rotation. A general
/// recurrence language (RFC 5545) is a parser, an edge-case surface and a test
/// suite, in exchange for expressing dates nobody has asked to express.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum Recurrence {
    /// Every `interval` weeks, on the weekday the first occurrence falls on.
    /// An interval of 1 is weekly, 2 is fortnightly.
    #[serde(rename_all = "camelCase")]
    Weekly { interval: u8 },
    /// Once a month, on the day of the month the first occurrence falls on.
    Monthly,
}

/// One entry of the community catalogue.
///
/// Times are Unix seconds in UTC, and stay that way through the whole client.
/// The reader's own zone is applied when it is drawn, which is what the issue
/// asks for and is also the only thing a desktop client can get right: the
/// operating system already knows where the player is, and a timezone setting
/// is one more thing that can be wrong.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    /// Stable within the catalogue. Also part of the reminder key, so renaming
    /// one drops the reminders people set on it.
    pub id: String,
    pub title: String,
    /// One or two sentences. Plain text: the calendar renders no markup.
    pub summary: String,
    pub category: EventCategory,
    pub origin: EventOrigin,
    /// Who is putting it on, in their own words. Empty when nobody said.
    pub host: String,
    /// Unix seconds, UTC.
    pub starts_at: u32,
    /// Unix seconds, or 0 when the entry states no end.
    pub ends_at: u32,
    /// A day rather than a moment: drawn with no time and never converted.
    ///
    /// A patch release is the case that matters: "3837 was released on the
    /// 14th" is a date, and showing it as 02:00 in one player's zone and 21:00
    /// the previous day in another's would be worse than saying nothing.
    pub all_day: bool,
    pub links: Vec<EventLink>,
    /// How it repeats, or `None` for a one-off.
    pub recurrence: Option<Recurrence>,
    /// When repeating stops, in Unix seconds, or 0 for open-ended.
    pub recurs_until: u32,
}

/// Whether the catalogue on screen came off the network or out of the binary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EventsSource {
    /// Shipped with the client, because no manifest is configured or the
    /// configured one could not be read.
    #[default]
    Bundled,
    Remote,
}

/// The catalogue document, as the port hands it over.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EventCatalogue {
    pub events: Vec<CalendarEvent>,
    pub source: EventsSource,
    /// Where "suggest an event" goes: the catalogue repository's issue form.
    /// Empty hides the button rather than sending anybody to a guess.
    pub submit_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum EventsStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed {
        reason: String,
    },
}

/// Which way the calendar is drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CalendarView {
    /// A grid of the whole month. The issue asked for it first.
    #[default]
    Month,
    /// Seven days, with times.
    Week,
    /// Everything still to come, nearest first. Not in the issue, and the one
    /// most people will leave it on: a calendar grid answers "what is on the
    /// 14th", and this answers "what is next".
    Upcoming,
}

/// What the calendar is filtered to.
///
/// Filters live in state rather than in the component because the tab is
/// re-entered constantly, following a link into the Tournaments tab and back,
/// and losing the filter every time would make it useless.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EventsQuery {
    /// Free text, matched against the title and the host.
    pub text: String,
    pub category: Option<EventCategory>,
    pub origin: Option<EventOrigin>,
    /// Only entries this client has a reminder set on: the issue's "my events".
    pub only_reminders: bool,
}

impl EventsQuery {
    pub fn is_empty(&self) -> bool {
        *self == EventsQuery::default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EventsState {
    pub catalogue: Vec<CalendarEvent>,
    pub source: EventsSource,
    pub submit_url: String,
    pub status: EventsStatus,
    pub view: CalendarView,
    /// The day the view is drawn around, as ISO `YYYY-MM-DD` in the reader's
    /// own zone.
    ///
    /// A string rather than a timestamp because that is what it means: "the
    /// month containing the 3rd of March" is a calendar fact, not an instant,
    /// and turning it into one would make which month is shown depend on the
    /// hour. Empty means today, resolved when it is drawn, so a client left
    /// open overnight opens on the right month in the morning.
    pub anchor: String,
    pub query: EventsQuery,
    /// The entry whose detail panel is open, by occurrence key.
    pub selected: Option<String>,
}

impl Default for EventsState {
    fn default() -> Self {
        Self {
            catalogue: Vec::new(),
            source: EventsSource::Bundled,
            submit_url: String::new(),
            status: EventsStatus::Idle,
            view: CalendarView::Month,
            anchor: String::new(),
            query: EventsQuery::default(),
            selected: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum EventsEvent {
    Loading,
    Loaded {
        catalogue: EventCatalogue,
    },
    LoadFailed {
        reason: String,
    },
    ViewChanged {
        view: CalendarView,
    },
    /// ISO `YYYY-MM-DD`, or empty for "back to today".
    AnchorChanged {
        day: String,
    },
    QueryChanged {
        query: EventsQuery,
    },
    #[serde(rename_all = "camelCase")]
    Selected {
        occurrence_id: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum EventsCommand {
    /// Fetch the catalogue. Sent on every visit to the tab: an event added an
    /// hour ago should not need a restart.
    Load,
    SetView {
        view: CalendarView,
    },
    SetAnchor {
        day: String,
    },
    SetQuery {
        query: EventsQuery,
    },
    #[serde(rename_all = "camelCase")]
    Select {
        occurrence_id: Option<String>,
    },
    /// Ask to be reminded about one occurrence, or change its lead time.
    ///
    /// The whole reminder is carried in the command rather than looked up,
    /// because the occurrence it names may not be in this slice at all: a
    /// tournament comes from `TourneyState` and a patch from the changelog. The
    /// ticker only needs to know what to say and when.
    #[serde(rename_all = "camelCase")]
    Remind {
        occurrence_id: String,
        title: String,
        starts_at: u32,
        lead_minutes: u32,
    },
    /// Stop reminding about one occurrence.
    #[serde(rename_all = "camelCase")]
    Forget {
        occurrence_id: String,
    },
}

pub fn reduce(state: &mut EventsState, event: &EventsEvent) {
    match event {
        EventsEvent::Loading => state.status = EventsStatus::Loading,
        EventsEvent::Loaded { catalogue } => {
            state.catalogue = catalogue.events.clone();
            state.source = catalogue.source;
            state.submit_url = catalogue.submit_url.clone();
            state.status = EventsStatus::Ready;
        }
        EventsEvent::LoadFailed { reason } => {
            state.status = EventsStatus::Failed {
                reason: reason.clone(),
            }
        }
        EventsEvent::ViewChanged { view } => state.view = *view,
        EventsEvent::AnchorChanged { day } => state.anchor = day.clone(),
        EventsEvent::QueryChanged { query } => state.query = query.clone(),
        EventsEvent::Selected { occurrence_id } => state.selected = occurrence_id.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: &str) -> CalendarEvent {
        CalendarEvent {
            id: id.into(),
            title: "Dojo 1v1 Night".into(),
            starts_at: 1_770_000_000,
            ..CalendarEvent::default()
        }
    }

    #[test]
    fn a_loaded_catalogue_replaces_the_previous_one() {
        // Replaces rather than merges: an event that was cancelled is removed
        // from the document, and a merge would keep showing it forever.
        let mut state = EventsState {
            catalogue: vec![event("old")],
            ..EventsState::default()
        };
        reduce(
            &mut state,
            &EventsEvent::Loaded {
                catalogue: EventCatalogue {
                    events: vec![event("new")],
                    source: EventsSource::Remote,
                    submit_url: "https://example.invalid/new".into(),
                },
            },
        );
        assert_eq!(
            state
                .catalogue
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            ["new"]
        );
        assert_eq!(state.source, EventsSource::Remote);
        assert_eq!(state.status, EventsStatus::Ready);
    }

    #[test]
    fn a_failed_load_keeps_what_was_already_shown() {
        // A calendar that emptied itself on a dropped connection would be worse
        // than a stale one, and the reason is on screen either way.
        let mut state = EventsState {
            catalogue: vec![event("dojo")],
            status: EventsStatus::Ready,
            ..EventsState::default()
        };
        reduce(
            &mut state,
            &EventsEvent::LoadFailed {
                reason: "offline".into(),
            },
        );
        assert_eq!(state.catalogue.len(), 1);
        assert_eq!(
            state.status,
            EventsStatus::Failed {
                reason: "offline".into()
            }
        );
    }

    #[test]
    fn the_view_the_anchor_and_the_filters_are_remembered() {
        let mut state = EventsState::default();
        reduce(
            &mut state,
            &EventsEvent::ViewChanged {
                view: CalendarView::Week,
            },
        );
        reduce(
            &mut state,
            &EventsEvent::AnchorChanged {
                day: "2026-03-01".into(),
            },
        );
        reduce(
            &mut state,
            &EventsEvent::QueryChanged {
                query: EventsQuery {
                    text: "dojo".into(),
                    category: Some(EventCategory::Meetup),
                    origin: Some(EventOrigin::Community),
                    only_reminders: true,
                },
            },
        );
        assert_eq!(state.view, CalendarView::Week);
        assert_eq!(state.anchor, "2026-03-01");
        assert!(!state.query.is_empty());
        assert_eq!(state.query.category, Some(EventCategory::Meetup));
    }

    #[test]
    fn an_empty_anchor_means_today() {
        // The default, and what "Today" resets to. Holding a resolved date
        // instead would pin a client left open overnight to yesterday.
        let mut state = EventsState {
            anchor: "2026-03-01".into(),
            ..EventsState::default()
        };
        reduce(
            &mut state,
            &EventsEvent::AnchorChanged { day: String::new() },
        );
        assert!(state.anchor.is_empty());
    }

    #[test]
    fn categories_and_origins_are_read_leniently() {
        // A hand-edited document is allowed a spelling this build has not heard
        // of; it lands on the calendar as Other rather than failing the parse.
        assert_eq!(EventCategory::from_wire("CGN"), EventCategory::Cgn);
        assert_eq!(
            EventCategory::from_wire("ladder_pool"),
            EventCategory::LadderPool
        );
        assert_eq!(EventCategory::from_wire("lan party"), EventCategory::Other);
        assert_eq!(EventOrigin::from_wire("Official"), EventOrigin::Official);
        assert_eq!(EventOrigin::from_wire("dojo"), EventOrigin::Community);
    }
}
