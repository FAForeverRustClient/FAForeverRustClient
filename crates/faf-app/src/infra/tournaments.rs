//! Tournaments: the FAF API's Challonge bridge.
//!
//! `GET /challonge/v1/tournaments.json` returns a JSON:API document whose
//! attributes mirror Challonge's own tournament object. Mirrors the Java
//! client's `TournamentService.getAllTournaments()`, including its page size.
//!
//! Parsing is deliberately forgiving. This is a proxy in front of a third
//! party: fields come and go, dates are optional by design, and a single
//! malformed record should cost the user that one row rather than the whole
//! list. Anything unreadable becomes an empty string, `None`, or `false`,
//! never an error: with one exception: a record without a usable id is
//! dropped, since selection and the detail pane are keyed on it.

use async_trait::async_trait;
use faf_domain::protocol::tournaments::to_plain_text;
use faf_domain::state::Tournament;
use serde_json::Value;

use crate::infra::env_or;
use crate::infra::jsonapi::{fetch_document, value_i32, value_string, JsonApiResource};
use crate::infra::session::TokenStore;
use crate::ports::TournamentsPort;

/// Matches the Java client's `getAllTournaments` page size. FAF has never run
/// anywhere near this many events at once, so one request is the whole list.
const PAGE_SIZE: u32 = 100;

#[derive(Debug, Clone)]
pub struct TournamentsConfig {
    pub api_base: String,
}

impl TournamentsConfig {
    pub fn faf() -> Self {
        Self {
            api_base: env_or("FAF_API_BASE", "https://api.faforever.com"),
        }
    }
}

pub struct TournamentsClient {
    config: TournamentsConfig,
    tokens: TokenStore,
    http: reqwest::Client,
}

impl TournamentsClient {
    pub fn new(config: TournamentsConfig, tokens: TokenStore) -> Self {
        Self {
            config,
            tokens,
            http: super::http::shared_http_client(),
        }
    }

    pub fn faf(tokens: TokenStore) -> Self {
        Self::new(TournamentsConfig::faf(), tokens)
    }
}

#[async_trait]
impl TournamentsPort for TournamentsClient {
    async fn list_tournaments(&self) -> Result<Vec<Tournament>, String> {
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;

        let mut url = url::Url::parse(&format!(
            "{}/challonge/v1/tournaments.json",
            self.config.api_base
        ))
        .map_err(|error| format!("invalid API base: {error}"))?;
        url.query_pairs_mut()
            .append_pair("page[size]", &PAGE_SIZE.to_string())
            .append_pair("page[number]", "1");

        let doc = fetch_document(&self.http, url, &token).await?;
        Ok(doc.data.iter().filter_map(parse_tournament).collect())
    }
}

fn parse_tournament(resource: &JsonApiResource) -> Option<Tournament> {
    let attributes = &resource.attributes;
    // The JSON:API id is canonically a string; Challonge's own numeric id also
    // shows up as an attribute on some records, so fall back to it.
    let id = resource
        .id
        .parse::<i32>()
        .ok()
        .or_else(|| value_i32(attributes, "id"))?;

    Some(Tournament {
        id,
        name: value_string(attributes, "name"),
        // Reduced here rather than in the view: the state is what every
        // consumer sees, and markup that never enters it cannot be rendered
        // by mistake later.
        description: to_plain_text(&value_string(attributes, "description")),
        tournament_type: value_string(attributes, "tournamentType"),
        participant_count: value_i32(attributes, "participantCount").unwrap_or(0),
        created_at: value_timestamp(attributes, "createdAt"),
        starting_at: value_timestamp(attributes, "startingAt"),
        completed_at: value_timestamp(attributes, "completedAt"),
        challonge_url: value_string(attributes, "challongeUrl"),
        live_image_url: value_string(attributes, "liveImageUrl"),
        sign_up_url: value_string(attributes, "signUpUrl"),
        open_for_signup: attributes
            .get("openForSignup")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// An ISO-8601 timestamp as Unix seconds.
///
/// `None` for an absent, null, unparseable, or pre-1970 date. Challonge sends
/// offsets (`2026-08-01T18:00:00+02:00`) as well as `Z`, so this parses
/// RFC 3339 rather than assuming UTC: reading a `+02:00` event as UTC would
/// show it as running two hours before it starts.
fn value_timestamp(attributes: &Value, name: &str) -> Option<u32> {
    let raw = attributes.get(name)?.as_str()?;
    let parsed = chrono::DateTime::parse_from_rfc3339(raw).ok()?;
    u32::try_from(parsed.timestamp()).ok()
}

/// Inert tournaments client: used offline and in tests.
///
/// Returns a small representative list rather than nothing, so the view can be
/// worked on without an account: an empty list and a broken list look
/// identical on screen.
#[derive(Debug, Clone, Default)]
pub struct FakeTournaments;

#[async_trait]
impl TournamentsPort for FakeTournaments {
    async fn list_tournaments(&self) -> Result<Vec<Tournament>, String> {
        let now = chrono::Utc::now().timestamp();
        let at = |offset: i64| u32::try_from(now + offset).ok();
        Ok(vec![
            Tournament {
                id: 1,
                name: "Weekend Ladder Cup".into(),
                description: "Best of three, no mods. Sign up on Challonge.".into(),
                tournament_type: "single elimination".into(),
                participant_count: 24,
                created_at: at(-7 * 86_400),
                starting_at: at(2 * 86_400),
                completed_at: None,
                challonge_url: "https://challonge.com/example_cup".into(),
                live_image_url: String::new(),
                sign_up_url: "https://challonge.com/example_cup/signup".into(),
                open_for_signup: true,
            },
            Tournament {
                id: 2,
                name: "Setons Invitational".into(),
                description: "Invite only.".into(),
                tournament_type: "swiss".into(),
                participant_count: 16,
                created_at: at(-30 * 86_400),
                starting_at: at(-3_600),
                completed_at: None,
                challonge_url: "https://challonge.com/example_invitational".into(),
                live_image_url: String::new(),
                sign_up_url: String::new(),
                open_for_signup: false,
            },
            Tournament {
                id: 3,
                name: "Spring Open".into(),
                description: String::new(),
                tournament_type: "double elimination".into(),
                participant_count: 64,
                created_at: at(-90 * 86_400),
                starting_at: at(-60 * 86_400),
                completed_at: at(-59 * 86_400),
                challonge_url: "https://challonge.com/example_open".into(),
                live_image_url: String::new(),
                sign_up_url: String::new(),
                open_for_signup: false,
            },
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn resource(id: &str, attributes: Value) -> JsonApiResource {
        serde_json::from_value(json!({
            "type": "tournament",
            "id": id,
            "attributes": attributes,
        }))
        .expect("valid resource")
    }

    #[test]
    fn parses_a_full_record() {
        let parsed = parse_tournament(&resource(
            "42",
            json!({
                "name": "Weekend Cup",
                "description": "<p>Best of three</p>",
                "tournamentType": "swiss",
                "participantCount": 24,
                "createdAt": "2026-07-01T12:00:00Z",
                "startingAt": "2026-08-01T18:00:00Z",
                "completedAt": null,
                "challongeUrl": "https://challonge.com/weekend_cup",
                "liveImageUrl": "https://challonge.com/weekend_cup.png",
                "signUpUrl": "https://challonge.com/weekend_cup/signup",
                "openForSignup": true,
            }),
        ))
        .expect("a parseable tournament");

        assert_eq!(parsed.id, 42);
        assert_eq!(parsed.name, "Weekend Cup");
        assert_eq!(parsed.description, "Best of three", "markup is stripped");
        assert_eq!(parsed.participant_count, 24);
        // 20666 days from the epoch to 2026-08-01, plus 18 hours.
        assert_eq!(parsed.starting_at, Some(20_666 * 86_400 + 18 * 3_600));
        assert_eq!(parsed.completed_at, None);
        assert!(parsed.open_for_signup);
    }

    #[test]
    fn a_record_with_nothing_but_an_id_still_parses() {
        // A proxied third-party object; missing fields are normal, and losing
        // the row would hide a real tournament over a cosmetic gap.
        let parsed = parse_tournament(&resource("7", json!({}))).expect("still parseable");
        assert_eq!(parsed.id, 7);
        assert_eq!(parsed.name, "");
        assert_eq!(parsed.participant_count, 0);
        assert_eq!(parsed.created_at, None);
        assert!(!parsed.open_for_signup);
    }

    #[test]
    fn a_record_without_a_usable_id_is_dropped() {
        // Selection and the detail pane are keyed on the id; a row that cannot
        // be selected is worse than no row.
        assert!(parse_tournament(&resource("not-a-number", json!({}))).is_none());
    }

    #[test]
    fn a_numeric_id_attribute_stands_in_for_an_unusable_document_id() {
        let parsed = parse_tournament(&resource("not-a-number", json!({ "id": 91 })))
            .expect("the attribute rescues it");
        assert_eq!(parsed.id, 91);
    }

    #[test]
    fn offsets_are_honoured_rather_than_read_as_utc() {
        // 18:00+02:00 is 16:00Z. Treating the offset as UTC would show a
        // tournament as running for two hours before it starts.
        let with_offset = parse_tournament(&resource(
            "1",
            json!({ "startingAt": "2026-08-01T18:00:00+02:00" }),
        ))
        .unwrap();
        let as_utc = parse_tournament(&resource(
            "1",
            json!({ "startingAt": "2026-08-01T16:00:00Z" }),
        ))
        .unwrap();
        assert_eq!(with_offset.starting_at, as_utc.starting_at);
    }

    #[test]
    fn an_unparseable_date_is_absent_rather_than_wrong() {
        for raw in ["", "soon", "2026-08-01", "1785952800"] {
            let parsed = parse_tournament(&resource("1", json!({ "startingAt": raw }))).unwrap();
            assert_eq!(parsed.starting_at, None, "for {raw:?}");
        }
    }

    #[test]
    fn a_participant_count_sent_as_a_string_is_still_read() {
        let parsed = parse_tournament(&resource("1", json!({ "participantCount": "24" }))).unwrap();
        assert_eq!(parsed.participant_count, 24);
    }

    #[tokio::test]
    async fn the_fake_covers_every_status() {
        use faf_domain::state::TournamentStatus;
        let now = u32::try_from(chrono::Utc::now().timestamp()).unwrap();
        let list = FakeTournaments.list_tournaments().await.unwrap();

        let statuses: Vec<TournamentStatus> = list.iter().map(|t| t.status(now)).collect();
        assert!(statuses.contains(&TournamentStatus::OpenForRegistration));
        assert!(statuses.contains(&TournamentStatus::Running));
        assert!(statuses.contains(&TournamentStatus::Finished));
    }
}
