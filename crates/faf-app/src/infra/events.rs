//! The community events catalogue: a JSON manifest, with the shipped seed as
//! the floor.
//!
//! There is no FAF endpoint for this, and the thread on the issue is clear
//! about why there will not be one soon: a club's game night lives in that
//! club's Discord, a CGN date is decided by a poll, and a patch date is
//! whatever somebody happens to know. What all of those have in common is that
//! a person knows the answer and no service does.
//!
//! So the shape is the training catalogue's, deliberately: a plain JSON
//! document in a Git repository, submissions as issues, and adding an event is
//! a commit rather than a client release. The two properties that matter are
//! the same two as well:
//!
//! 1. **The tab works with no manifest at all.** No URL configured, or the URL
//!    unreachable, and the seed below is used. The catalogue reports which of
//!    the two happened so the UI can say so.
//! 2. **A partial manifest is valid.** The document is read through the DTOs at
//!    the bottom of this file, where every field defaults, so a manifest that
//!    states only a title and a date loads, and one that gains a field this
//!    client does not know about still loads.
//!
//! The Discord bot the thread discusses (reading a guild's scheduled events and
//! forwarding them) is not this. When it exists it publishes into this same
//! document, which is why the document is the boundary rather than the bot.

use async_trait::async_trait;
use faf_domain::state::{
    CalendarEvent, EventCatalogue, EventCategory, EventLink, EventOrigin, EventsSource, Recurrence,
};
use serde::Deserialize;

use crate::infra::env_or;
use crate::ports::EventsPort;

/// The catalogue that ships with the client.
///
/// Parsed rather than written out in Rust so that it is the same document shape
/// a remote manifest uses, and so somebody can read it to learn the format.
const SEED: &str = include_str!("events_catalogue.json");

/// A manifest is a hand-edited document, not a data feed. Anything past this is
/// a wrong URL rather than a large calendar.
const MAX_MANIFEST_BYTES: usize = 1024 * 1024;

/// The published catalogue.
///
/// `main` rather than `HEAD`, for the reason the training catalogue documents:
/// `raw.githubusercontent.com` caches its resolution of `HEAD` separately from
/// the file, so a `HEAD` URL keeps serving a document from before the last
/// commit with no way to ask for a newer one.
const DEFAULT_MANIFEST: &str =
    "https://raw.githubusercontent.com/FAForeverRustClient/events/main/calendar.json";

/// Where "suggest an event" goes when the manifest does not say.
const DEFAULT_SUBMIT_URL: &str = "https://github.com/FAForeverRustClient/events/issues/new/choose";

#[derive(Debug, Clone)]
pub struct EventsConfig {
    /// Where the manifest lives. Empty means "use only what shipped", which is
    /// what a test or an offline session wants.
    pub manifest_url: String,
}

impl EventsConfig {
    pub fn faf() -> Self {
        Self {
            manifest_url: env_or("FAF_EVENTS_CATALOGUE_URL", DEFAULT_MANIFEST),
        }
    }
}

/// The manifest URL with a value on it that changes, so the request is not
/// answered from a cache.
///
/// Same reasoning as the training catalogue's: five minutes of `max-age` on
/// `raw.githubusercontent.com` is invisible and maddening in exactly the case
/// that matters, which here is somebody adding tonight's game night an hour
/// before it starts.
fn uncached(url: &str) -> String {
    if url.is_empty() {
        return String::new();
    }
    let separator = if url.contains('?') { '&' } else { '?' };
    format!("{url}{separator}t={}", crate::services::now_seconds())
}

pub struct EventsCatalogueClient {
    config: EventsConfig,
    http: reqwest::Client,
}

impl EventsCatalogueClient {
    pub fn new(config: EventsConfig) -> Self {
        Self {
            config,
            http: super::http::shared_http_client(),
        }
    }

    pub fn faf() -> Self {
        Self::new(EventsConfig::faf())
    }

    async fn fetch(&self) -> Result<EventCatalogue, String> {
        let response = self
            .http
            .get(uncached(&self.config.manifest_url))
            .send()
            .await
            .map_err(|error| format!("could not reach the events catalogue: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("the events catalogue responded with {status}"));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("could not read the events catalogue: {error}"))?;
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err("the events catalogue document was unexpectedly large".into());
        }
        let mut catalogue = parse_manifest(&bytes)?;
        catalogue.source = EventsSource::Remote;
        if catalogue.submit_url.is_empty() {
            catalogue.submit_url = DEFAULT_SUBMIT_URL.into();
        }
        Ok(catalogue)
    }
}

#[async_trait]
impl EventsPort for EventsCatalogueClient {
    async fn list_catalogue(&self) -> Result<EventCatalogue, String> {
        if self.config.manifest_url.trim().is_empty() {
            return Ok(seed_catalogue());
        }
        match self.fetch().await {
            Ok(catalogue) => Ok(catalogue),
            Err(reason) => {
                // Not an error the player sees. The tab still has the
                // tournaments and the patch history, which come from state, and
                // `source` already tells the UI that the community half is the
                // shipped one.
                tracing::warn!(%reason, "falling back to the bundled events catalogue");
                Ok(seed_catalogue())
            }
        }
    }
}

/// The catalogue a test or an offline session gets: the shipped one, unchanged.
pub struct FakeEvents;

#[async_trait]
impl EventsPort for FakeEvents {
    async fn list_catalogue(&self) -> Result<EventCatalogue, String> {
        Ok(seed_catalogue())
    }
}

/// The seed, parsed. A broken seed is a packaging bug, so it fails loudly in
/// tests and degrades to an empty catalogue at runtime rather than panicking in
/// somebody's client.
///
/// It never carries a submission address, and that is the fix for a real fault:
/// the button opened a 404. The seed is what is shown when the published
/// catalogue could not be read, which is the one state in which an address
/// *inside* that catalogue's repository is least likely to answer, whether
/// because the machine is offline or because the repository is not there yet.
/// A catalogue that came off the network has proved the opposite, so that is
/// the only one whose submission link is offered.
pub fn seed_catalogue() -> EventCatalogue {
    match parse_manifest(SEED.as_bytes()) {
        Ok(mut catalogue) => {
            catalogue.source = EventsSource::Bundled;
            catalogue.submit_url = String::new();
            catalogue
        }
        Err(reason) => {
            tracing::error!(%reason, "the bundled events catalogue does not parse");
            EventCatalogue::default()
        }
    }
}

fn parse_manifest(bytes: &[u8]) -> Result<EventCatalogue, String> {
    let document: ManifestDoc = serde_json::from_slice(bytes)
        .map_err(|error| format!("the events catalogue is not valid JSON: {error}"))?;
    Ok(document.into_catalogue())
}

/// Accept an ordinary `https` address and nothing else.
///
/// The manifest is remote content, and every address in it becomes a button.
/// Checked here rather than in the view because this is the boundary the
/// document crosses: a link that does not survive this is dropped, and the
/// entry keeps the rest of its buttons.
fn safe_url(raw: &str) -> Option<String> {
    let url = raw.trim();
    if !url.starts_with("https://") || url.len() < 12 || url.contains(char::is_whitespace) {
        return None;
    }
    Some(url.to_string())
}

// -- the manifest document -------------------------------------------------
//
// A separate shape from the domain's, for the reason the training manifest
// documents: everything here is optional and unknown keys are ignored, and
// putting `#[serde(default)]` on the domain type would make every field of
// `CalendarEvent` optional in the generated TypeScript.

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ManifestDoc {
    events: Vec<EventDoc>,
    submit_url: String,
}

impl ManifestDoc {
    fn into_catalogue(self) -> EventCatalogue {
        EventCatalogue {
            events: self
                .events
                .into_iter()
                .filter_map(EventDoc::into_event)
                .collect(),
            source: EventsSource::Bundled,
            submit_url: self.submit_url.trim().to_string(),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct EventDoc {
    id: String,
    title: String,
    summary: String,
    /// The category, read leniently: an unknown one lands as `other`.
    category: String,
    origin: String,
    host: String,
    /// RFC 3339, or a bare `YYYY-MM-DD` for an all-day entry.
    starts_at: String,
    ends_at: String,
    /// Absent is inferred from the start: a bare date is a day, a full
    /// timestamp is a moment. Stated explicitly it wins.
    all_day: Option<bool>,
    links: Vec<LinkDoc>,
    recurrence: Option<RecurrenceDoc>,
    recurs_until: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LinkDoc {
    label: String,
    url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RecurrenceDoc {
    Weekly {
        /// Weeks between occurrences. Absent, zero and one all mean weekly.
        #[serde(default)]
        interval: u8,
    },
    Monthly,
}

impl EventDoc {
    /// An entry needs a title, a date this client can read, and an id to key it
    /// by. Anything else is filled in.
    fn into_event(self) -> Option<CalendarEvent> {
        let title = self.title.trim().to_string();
        if title.is_empty() {
            return None;
        }
        let (starts_at, start_is_day) = parse_moment(&self.starts_at)?;
        let id = if self.id.trim().is_empty() {
            // A title and a date identify an entry well enough to be keyed by,
            // and an entry without an id is a hand-edited document's most
            // likely omission. Reminders are set against this, so it has to be
            // derived rather than random: a generated id would move on every
            // load and silently drop the reminder.
            format!("{}-{starts_at}", slug(&title))
        } else {
            self.id.trim().to_string()
        };
        let all_day = self.all_day.unwrap_or(start_is_day);
        Some(CalendarEvent {
            id,
            title,
            summary: self.summary.trim().to_string(),
            category: EventCategory::from_wire(&self.category),
            origin: EventOrigin::from_wire(&self.origin),
            host: self.host.trim().to_string(),
            starts_at,
            ends_at: parse_moment(&self.ends_at).map(|(at, _)| at).unwrap_or(0),
            all_day,
            links: self
                .links
                .into_iter()
                .filter_map(|link| {
                    let label = link.label.trim().to_string();
                    let url = safe_url(&link.url)?;
                    Some(EventLink {
                        label: if label.is_empty() {
                            "Open".to_string()
                        } else {
                            label
                        },
                        url,
                    })
                })
                .collect(),
            recurrence: self.recurrence.map(|rule| match rule {
                RecurrenceDoc::Weekly { interval } => Recurrence::Weekly {
                    interval: interval.max(1),
                },
                RecurrenceDoc::Monthly => Recurrence::Monthly,
            }),
            recurs_until: parse_moment(&self.recurs_until)
                .map(|(at, _)| at)
                .unwrap_or(0),
        })
    }
}

/// A URL-safe form of a title, for an entry that did not give an id.
fn slug(title: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for character in title.chars() {
        if character.is_ascii_alphanumeric() {
            out.push(character.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    out.trim_end_matches('-').to_string()
}

/// Read `YYYY-MM-DD` or a full RFC 3339 timestamp into Unix seconds.
///
/// Returns whether the value was a bare date, which is how an entry that did
/// not say gets its all-day flag: "the patch landed on the 14th" is a day, and
/// converting it into 00:00 UTC and then into the reader's zone is how a date
/// becomes the wrong day for half of Europe.
fn parse_moment(raw: &str) -> Option<(u32, bool)> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        let at = date.and_hms_opt(0, 0, 0)?.and_utc().timestamp();
        return Some((u32::try_from(at).ok()?, true));
    }
    let at = chrono::DateTime::parse_from_rfc3339(value)
        .ok()?
        .timestamp();
    Some((u32::try_from(at).ok()?, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_catalogue_parses() {
        // A packaging test: the seed is `include_str!`d, so a typo in it is a
        // silently empty calendar rather than a build failure.
        let catalogue = parse_manifest(SEED.as_bytes()).expect("the shipped catalogue parses");
        assert!(
            !catalogue.events.is_empty(),
            "the shipped catalogue states at least the pool rotation"
        );
        assert!(catalogue
            .events
            .iter()
            .all(|event| !event.id.is_empty() && event.starts_at > 0));
    }

    #[test]
    fn the_bundled_catalogue_offers_no_submission_link() {
        // It is shown when the published document could not be read, and a
        // button into that document's repository is exactly what cannot be
        // relied on in that state. The UI hides the button on an empty value.
        assert!(seed_catalogue().submit_url.is_empty());
    }

    #[test]
    fn a_bare_date_is_an_all_day_entry() {
        let doc = r#"{"events":[{"title":"Patch 3837","startsAt":"2026-03-14"}]}"#;
        let catalogue = parse_manifest(doc.as_bytes()).expect("valid");
        let event = &catalogue.events[0];
        assert!(event.all_day);
        assert_eq!(event.starts_at, 1_773_446_400);
        assert_eq!(event.id, "patch-3837-1773446400");
    }

    #[test]
    fn a_timestamp_is_a_moment_in_the_readers_own_zone() {
        let doc =
            r#"{"events":[{"id":"dojo","title":"1v1 Night","startsAt":"2026-03-14T19:00:00Z"}]}"#;
        let event = &parse_manifest(doc.as_bytes()).expect("valid").events[0];
        assert!(!event.all_day);
        assert_eq!(event.starts_at, 1_773_514_800);
    }

    #[test]
    fn an_entry_without_a_title_or_a_readable_date_is_dropped() {
        // Rather than sinking the document: one malformed entry in a
        // hand-edited file must not empty the calendar.
        let doc = r#"{"events":[
            {"title":"","startsAt":"2026-03-14"},
            {"title":"No date"},
            {"title":"Nonsense date","startsAt":"next tuesday"},
            {"title":"Good","startsAt":"2026-03-14"}
        ]}"#;
        let catalogue = parse_manifest(doc.as_bytes()).expect("valid");
        assert_eq!(
            catalogue
                .events
                .iter()
                .map(|event| event.title.as_str())
                .collect::<Vec<_>>(),
            ["Good"]
        );
    }

    #[test]
    fn a_link_that_is_not_plain_https_is_dropped_and_the_entry_kept() {
        let doc = r#"{"events":[{"id":"e","title":"E","startsAt":"2026-03-14","links":[
            {"label":"Discord","url":"https://discord.gg/example"},
            {"label":"Script","url":"javascript:alert(1)"},
            {"label":"Plain","url":"http://example.invalid"},
            {"url":"https://example.invalid/unlabelled"}
        ]}]}"#;
        let event = &parse_manifest(doc.as_bytes()).expect("valid").events[0];
        assert_eq!(
            event
                .links
                .iter()
                .map(|link| link.label.as_str())
                .collect::<Vec<_>>(),
            ["Discord", "Open"]
        );
    }

    #[test]
    fn a_weekly_rule_without_an_interval_is_weekly() {
        let doc = r#"{"events":[{"id":"e","title":"E","startsAt":"2026-03-14T19:00:00Z",
            "recurrence":{"weekly":{}},"recursUntil":"2026-12-31"}]}"#;
        let event = &parse_manifest(doc.as_bytes()).expect("valid").events[0];
        assert_eq!(event.recurrence, Some(Recurrence::Weekly { interval: 1 }));
        assert!(event.recurs_until > event.starts_at);
    }

    #[test]
    fn an_unknown_field_does_not_sink_the_document() {
        let doc = r#"{"events":[{"id":"e","title":"E","startsAt":"2026-03-14","mood":"great"}],
            "somethingNewer":true}"#;
        assert_eq!(
            parse_manifest(doc.as_bytes()).expect("valid").events.len(),
            1
        );
    }
}
