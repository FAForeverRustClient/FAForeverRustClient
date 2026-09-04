//! Co-op: missions, scenarios and the record board, from the FAF Data API.
//!
//! Three JSON:API collections, matching the Java client's `CoopService`:
//!
//! - `/data/coopMission`: every playable mission.
//! - `/data/coopScenario`: the campaigns grouping them.
//! - `/data/coopResult`: completions, filtered by mission and optionally by
//!   player count, sorted fastest first, with the participating players
//!   resolved through the game's player stats.
//!
//! Replaces the previous approach, which had no API call at all: the UI
//! filtered the *map vault* for names containing "coop", "campaign",
//! "operation" or "mission". That both missed missions whose names contain
//! none of those words and swept in ordinary maps that happen to.

use async_trait::async_trait;
use faf_domain::protocol::markup::to_plain_text;
use faf_domain::state::{
    CoopCategory, CoopFaction, CoopMission, CoopResult, CoopScenario, ANY_PLAYER_COUNT,
};
use serde_json::Value;

use crate::infra::env_or;
use crate::infra::jsonapi::{
    document_index, fetch_document_typed, rel_one, rel_targets, value_bool, value_i32,
    value_string, JsonApiResource,
};
use crate::infra::session::TokenStore;
use crate::ports::{CoopPort, RequestError};

/// Java uses 1000 for both missions and results; FAF has a few hundred
/// missions and a long tail of results, so one page covers both.
const PAGE_SIZE: u32 = 1000;

#[derive(Debug, Clone)]
pub struct CoopConfig {
    pub api_base: String,
}

impl CoopConfig {
    pub fn faf() -> Self {
        Self {
            api_base: env_or("FAF_API_BASE", "https://api.faforever.com"),
        }
    }
}

pub struct CoopClient {
    config: CoopConfig,
    tokens: TokenStore,
    http: reqwest::Client,
}

impl CoopClient {
    pub fn new(config: CoopConfig, tokens: TokenStore) -> Self {
        Self {
            config,
            tokens,
            http: super::http::shared_http_client(),
        }
    }

    pub fn faf(tokens: TokenStore) -> Self {
        Self::new(CoopConfig::faf(), tokens)
    }

    fn token(&self) -> Result<String, RequestError> {
        self.tokens.get().ok_or_else(|| {
            RequestError::unauthorized("Your FAF session has expired. Sign in again.")
        })
    }

    fn url(&self, resource: &str) -> Result<url::Url, RequestError> {
        url::Url::parse(&format!("{}/data/{resource}", self.config.api_base))
            .map_err(|error| RequestError::unexpected(format!("invalid API base: {error}")))
    }
}

#[async_trait]
impl CoopPort for CoopClient {
    async fn list_catalog(&self) -> Result<(Vec<CoopScenario>, Vec<CoopMission>), RequestError> {
        let token = self.token()?;

        let mut missions_url = self.url("coopMission")?;
        missions_url
            .query_pairs_mut()
            .append_pair("page[size]", &PAGE_SIZE.to_string())
            .append_pair("sort", "order,name");

        let mut scenarios_url = self.url("coopScenario")?;
        scenarios_url
            .query_pairs_mut()
            .append_pair("page[size]", &PAGE_SIZE.to_string())
            .append_pair("include", "maps")
            .append_pair("sort", "order");

        // Independent reads; a scenario list without missions is useless and
        // vice versa, so both must succeed.
        let (missions, scenarios) = tokio::join!(
            fetch_document_typed(&self.http, missions_url, &token),
            fetch_document_typed(&self.http, scenarios_url, &token),
        );
        let missions_doc = missions?;
        let scenarios_doc = scenarios?;

        let mut missions: Vec<CoopMission> =
            missions_doc.data.iter().filter_map(parse_mission).collect();
        let scenarios: Vec<CoopScenario> = scenarios_doc
            .data
            .iter()
            .filter_map(parse_scenario)
            .collect();

        // The mission→scenario link is only expressed one way in the API: a
        // scenario lists its maps. Invert it so a mission knows its campaign,
        // which is what the UI groups by.
        let mut owner = std::collections::HashMap::new();
        for scenario in &scenarios_doc.data {
            let Ok(scenario_id) = scenario.id.parse::<i32>() else {
                continue;
            };
            for (_, mission_id) in rel_targets(&scenario.relationships, "maps") {
                if let Ok(mission_id) = mission_id.parse::<i32>() {
                    owner.insert(mission_id, scenario_id);
                }
            }
        }
        // Missions included alongside the scenarios but absent from the
        // mission collection would otherwise be lost.
        let index = document_index(&scenarios_doc);
        for ((kind, id), resource) in index {
            if kind != "coopMission" {
                continue;
            }
            let Ok(id) = id.parse::<i32>() else { continue };
            if missions.iter().any(|mission| mission.id == id) {
                continue;
            }
            if let Some(mission) = parse_mission(resource) {
                missions.push(mission);
            }
        }
        for mission in &mut missions {
            mission.scenario_id = owner.get(&mission.id).copied();
        }

        Ok((scenarios, missions))
    }

    async fn list_leaderboard(
        &self,
        mission_id: i32,
        player_count: i32,
    ) -> Result<Vec<CoopResult>, RequestError> {
        let token = self.token()?;

        // Mirrors Java's `qBuilder().intNum("mission").eq(id)`, plus the
        // player-count clause only when one was asked for.
        let filter = if player_count > ANY_PLAYER_COUNT {
            format!("mission=={mission_id};playerCount=={player_count}")
        } else {
            format!("mission=={mission_id}")
        };

        let mut url = self.url("coopResult")?;
        url.query_pairs_mut()
            .append_pair("filter", &filter)
            .append_pair("sort", "duration")
            .append_pair("page[size]", &PAGE_SIZE.to_string())
            // The team's logins live two hops away, through the game.
            .append_pair("include", "game,game.playerStats,game.playerStats.player");

        let doc = fetch_document_typed(&self.http, url, &token).await?;
        let index = document_index(&doc);

        Ok(doc
            .data
            .iter()
            .filter_map(|resource| parse_result(resource, &index))
            .collect())
    }
}

fn parse_mission(resource: &JsonApiResource) -> Option<CoopMission> {
    let id = resource.id.parse::<i32>().ok()?;
    let attributes = &resource.attributes;
    Some(CoopMission {
        id,
        name: value_string(attributes, "name"),
        // Mission briefings are stored as HTML.
        description: to_plain_text(&value_string(attributes, "description")),
        version: value_i32(attributes, "version").unwrap_or(0),
        download_url: value_string(attributes, "downloadUrl"),
        thumbnail_url_small: value_string(attributes, "thumbnailUrlSmall"),
        thumbnail_url_large: value_string(attributes, "thumbnailUrlLarge"),
        // The API has used both spellings; the folder is what a host request
        // names, so falling back matters more than picking a winner.
        map_folder_name: {
            let folder = value_string(attributes, "mapFolderName");
            if folder.is_empty() {
                value_string(attributes, "folderName")
            } else {
                folder
            }
        },
        scenario_id: None, // filled in by the caller from the scenario links
        // The campaign position, which is what the mission list is sorted by.
        order: value_i32(attributes, "order").unwrap_or(0),
    })
}

fn parse_scenario(resource: &JsonApiResource) -> Option<CoopScenario> {
    let id = resource.id.parse::<i32>().ok()?;
    let attributes = &resource.attributes;
    Some(CoopScenario {
        id,
        name: value_string(attributes, "name"),
        description: to_plain_text(&value_string(attributes, "description")),
        order: value_i32(attributes, "order").unwrap_or(0),
        faction: CoopFaction::parse(&value_string(attributes, "faction")),
        category: CoopCategory::parse(&value_string(attributes, "type")),
    })
}

fn parse_result(
    resource: &JsonApiResource,
    index: &crate::infra::jsonapi::ResourceIndex<'_>,
) -> Option<CoopResult> {
    let id = resource.id.parse::<i32>().ok()?;
    let attributes = &resource.attributes;

    let game = rel_one(resource, "game").and_then(|key| index.get(&key).copied());
    let players = game
        .map(|game| player_logins(game, index))
        .unwrap_or_default();
    let replay_id = game.and_then(|game| game.id.parse::<i32>().ok());
    let played_at = game
        .map(|game| value_string(&game.attributes, "startTime"))
        .and_then(|raw| parse_timestamp(&raw));

    Some(CoopResult {
        id,
        ranking: 0, // assigned by `rank_results`
        secondary_objectives: value_bool(attributes, "secondaryObjectives"),
        duration_seconds: parse_duration(attributes.get("duration"))?,
        player_count: value_i32(attributes, "playerCount").unwrap_or(players.len() as i32),
        players,
        replay_id,
        played_at,
    })
}

/// The team's logins, resolved game → playerStats → player.
fn player_logins(
    game: &JsonApiResource,
    index: &crate::infra::jsonapi::ResourceIndex<'_>,
) -> Vec<String> {
    let mut logins: Vec<String> = rel_targets(&game.relationships, "playerStats")
        .into_iter()
        .filter_map(|key| index.get(&key).copied())
        .filter_map(|stats| rel_one(stats, "player"))
        .filter_map(|key| index.get(&key).copied())
        .map(|player| value_string(&player.attributes, "login"))
        .filter(|login| !login.is_empty())
        .collect();
    logins.sort();
    logins.dedup();
    logins
}

/// A completion time in seconds.
///
/// The API types this as a duration, which arrives either as a number of
/// seconds or as an ISO-8601 string (`PT26M17S`). Accept both: a board that
/// silently shows every run as 0:00 is worse than no board.
fn parse_duration(value: Option<&Value>) -> Option<u32> {
    let value = value?;
    if let Some(seconds) = value.as_f64() {
        return (seconds >= 0.0).then_some(seconds.round() as u32);
    }
    let raw = value.as_str()?;
    if let Ok(seconds) = raw.trim().parse::<f64>() {
        return (seconds >= 0.0).then_some(seconds.round() as u32);
    }
    parse_iso_duration(raw)
}

/// `PT1H26M17.5S` → seconds. Only the time component: a mission is not days
/// long, and the API has never sent a date part.
fn parse_iso_duration(raw: &str) -> Option<u32> {
    let rest = raw.trim().strip_prefix("PT")?;
    let mut total = 0f64;
    let mut number = String::new();
    for character in rest.chars() {
        match character {
            '0'..='9' | '.' => number.push(character),
            'H' | 'M' | 'S' => {
                let parsed: f64 = number.parse().ok()?;
                number.clear();
                total += match character {
                    'H' => parsed * 3600.0,
                    'M' => parsed * 60.0,
                    _ => parsed,
                };
            }
            _ => return None,
        }
    }
    // Trailing digits with no unit are malformed.
    number.is_empty().then(|| total.round() as u32)
}

fn parse_timestamp(raw: &str) -> Option<u32> {
    let parsed = chrono::DateTime::parse_from_rfc3339(raw).ok()?;
    u32::try_from(parsed.timestamp()).ok()
}

/// Inert co-op client: used offline and in tests. Serves a small
/// representative catalog so the panel can be worked on without an account.
#[derive(Debug, Clone, Default)]
pub struct FakeCoop;

#[async_trait]
impl CoopPort for FakeCoop {
    async fn list_catalog(&self) -> Result<(Vec<CoopScenario>, Vec<CoopMission>), RequestError> {
        let scenario = |id: i32, name: &str, faction: CoopFaction| CoopScenario {
            id,
            name: name.into(),
            description: String::new(),
            order: id,
            faction,
            category: CoopCategory::Scfa,
        };
        let mission = |id: i32, scenario_id: i32, name: &str| CoopMission {
            id,
            name: name.into(),
            description: "Secure the area and hold until reinforcements arrive.".into(),
            version: 1,
            download_url: String::new(),
            thumbnail_url_small: String::new(),
            thumbnail_url_large: String::new(),
            map_folder_name: format!("scmp_coop_{id}"),
            scenario_id: Some(scenario_id),
            order: id,
        };
        Ok((
            vec![
                scenario(1, "Operation Ivory Sun", CoopFaction::Uef),
                scenario(2, "Prothyon 16", CoopFaction::Cybran),
            ],
            vec![
                mission(1, 1, "Ivory Sun 1"),
                mission(2, 1, "Ivory Sun 2"),
                mission(3, 2, "Prothyon 16"),
            ],
        ))
    }

    async fn list_leaderboard(
        &self,
        _mission_id: i32,
        _player_count: i32,
    ) -> Result<Vec<CoopResult>, RequestError> {
        Ok(vec![
            CoopResult {
                id: 1,
                ranking: 0,
                secondary_objectives: true,
                duration_seconds: 1_412,
                player_count: 2,
                players: vec!["Ada".into(), "Bob".into()],
                replay_id: Some(9001),
                played_at: None,
            },
            CoopResult {
                id: 2,
                ranking: 0,
                secondary_objectives: false,
                duration_seconds: 1_988,
                player_count: 1,
                players: vec!["Cid".into()],
                replay_id: None,
                played_at: None,
            },
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn resource(kind: &str, id: &str, attributes: Value, relationships: Value) -> JsonApiResource {
        serde_json::from_value(json!({
            "type": kind,
            "id": id,
            "attributes": attributes,
            "relationships": relationships,
        }))
        .expect("valid resource")
    }

    #[test]
    fn a_mission_parses_with_either_folder_spelling() {
        let with_map = parse_mission(&resource(
            "coopMission",
            "7",
            json!({ "name": "Ivory Sun 1", "mapFolderName": "scmp_coop_007" }),
            json!({}),
        ))
        .unwrap();
        assert_eq!(with_map.map_folder_name, "scmp_coop_007");

        let with_plain = parse_mission(&resource(
            "coopMission",
            "7",
            json!({ "folderName": "scmp_coop_007" }),
            json!({}),
        ))
        .unwrap();
        assert_eq!(with_plain.map_folder_name, "scmp_coop_007");
    }

    #[test]
    fn a_mission_briefing_is_reduced_to_text() {
        let mission = parse_mission(&resource(
            "coopMission",
            "7",
            json!({ "description": "<p>Hold the line.</p><script>alert(1)</script>" }),
            json!({}),
        ))
        .unwrap();
        assert_eq!(mission.description, "Hold the line.");
    }

    #[test]
    fn a_scenario_parses_its_faction_and_category() {
        let scenario = parse_scenario(&resource(
            "coopScenario",
            "3",
            json!({ "name": "Prothyon 16", "faction": "cybran", "type": "SCFA", "order": 2 }),
            json!({}),
        ))
        .unwrap();
        assert_eq!(scenario.faction, CoopFaction::Cybran);
        assert_eq!(scenario.category, CoopCategory::Scfa);
        assert_eq!(scenario.order, 2);
    }

    #[test]
    fn durations_are_read_from_seconds_or_iso_8601() {
        assert_eq!(parse_duration(Some(&json!(1412))), Some(1412));
        assert_eq!(parse_duration(Some(&json!(1412.6))), Some(1413));
        assert_eq!(parse_duration(Some(&json!("1412"))), Some(1412));
        assert_eq!(parse_duration(Some(&json!("PT23M32S"))), Some(1412));
        assert_eq!(parse_duration(Some(&json!("PT1H26M17S"))), Some(5177));
        assert_eq!(parse_duration(Some(&json!("PT26M17.5S"))), Some(1578));
    }

    #[test]
    fn a_malformed_duration_drops_the_row_rather_than_showing_zero() {
        // A run listed at 0:00 would take the top of the record board.
        for raw in [
            json!("soon"),
            json!("P1D"),
            json!("PT5"),
            json!(null),
            json!(-5),
        ] {
            assert_eq!(parse_duration(Some(&raw)), None, "for {raw}");
        }
        assert_eq!(parse_duration(None), None);
    }

    #[test]
    fn a_result_resolves_its_team_through_the_game() {
        let doc: crate::infra::jsonapi::JsonApiDoc = serde_json::from_value(json!({
            "data": [{
                "type": "coopResult",
                "id": "1",
                "attributes": { "duration": 1412, "playerCount": 2, "secondaryObjectives": true },
                "relationships": { "game": { "data": { "type": "game", "id": "9001" } } },
            }],
            "included": [
                {
                    "type": "game",
                    "id": "9001",
                    "attributes": { "startTime": "2026-01-01T12:00:00Z" },
                    "relationships": { "playerStats": { "data": [
                        { "type": "gamePlayerStats", "id": "11" },
                        { "type": "gamePlayerStats", "id": "12" }
                    ] } },
                },
                {
                    "type": "gamePlayerStats", "id": "11", "attributes": {},
                    "relationships": { "player": { "data": { "type": "player", "id": "21" } } },
                },
                {
                    "type": "gamePlayerStats", "id": "12", "attributes": {},
                    "relationships": { "player": { "data": { "type": "player", "id": "22" } } },
                },
                { "type": "player", "id": "21", "attributes": { "login": "Bob" }, "relationships": {} },
                { "type": "player", "id": "22", "attributes": { "login": "Ada" }, "relationships": {} },
            ],
        }))
        .unwrap();

        let index = document_index(&doc);
        let parsed = parse_result(&doc.data[0], &index).expect("a parseable result");

        assert_eq!(parsed.players, vec!["Ada", "Bob"], "sorted and deduped");
        assert_eq!(parsed.duration_seconds, 1412);
        assert_eq!(parsed.player_count, 2);
        assert!(parsed.secondary_objectives);
        assert_eq!(parsed.replay_id, Some(9001));
        assert_eq!(parsed.played_at, Some(1_767_268_800));
    }

    #[test]
    fn a_result_without_a_game_still_lists_its_time() {
        // The board is about the time; a missing game costs the team names and
        // the replay link, not the row.
        let doc: crate::infra::jsonapi::JsonApiDoc = serde_json::from_value(json!({
            "data": [{
                "type": "coopResult",
                "id": "1",
                "attributes": { "duration": 900, "playerCount": 3 },
                "relationships": {},
            }],
            "included": [],
        }))
        .unwrap();
        let index = document_index(&doc);
        let parsed = parse_result(&doc.data[0], &index).unwrap();
        assert_eq!(parsed.duration_seconds, 900);
        assert_eq!(parsed.player_count, 3);
        assert!(parsed.players.is_empty());
        assert_eq!(parsed.replay_id, None);
    }

    #[tokio::test]
    async fn the_fake_serves_a_catalog_that_groups() {
        let (scenarios, missions) = FakeCoop.list_catalog().await.unwrap();
        assert_eq!(scenarios.len(), 2);
        assert_eq!(
            faf_domain::state::missions_of(&missions, 1).len(),
            2,
            "the first campaign has two missions"
        );
    }

    #[tokio::test]
    async fn a_missing_token_is_an_authentication_failure_without_network_io() {
        let client = CoopClient::new(
            CoopConfig {
                api_base: "http://127.0.0.1:1".into(),
            },
            TokenStore::new(),
        );
        let error = client
            .list_catalog()
            .await
            .expect_err("an anonymous catalog request must be refused");
        assert_eq!(
            error.kind(),
            faf_domain::state::RequestFailureKind::Unauthorized
        );
    }
}
