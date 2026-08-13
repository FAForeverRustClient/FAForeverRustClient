//! FAF Data API moderation-report submission.

use async_trait::async_trait;
use faf_domain::state::ModerationReportSummary;
use serde_json::json;

use crate::infra::env_or;
use crate::infra::jsonapi::{
    document_index, fetch_document, rel_many, rel_one, value_string, JsonApiDoc, JsonApiResource,
};
use crate::ports::{GameParticipation, ReportPlayerRequest, ReportingPort};

#[derive(Debug, Clone)]
pub struct ReportingConfig {
    pub api_base: String,
}

impl ReportingConfig {
    pub fn faf() -> Self {
        Self {
            api_base: env_or("FAF_API_BASE", "https://api.faforever.com"),
        }
    }
}

pub struct ReportingClient {
    config: ReportingConfig,
    tokens: crate::infra::session::TokenStore,
    http: reqwest::Client,
}

impl ReportingClient {
    pub fn new(config: ReportingConfig, tokens: crate::infra::session::TokenStore) -> Self {
        Self {
            config,
            tokens,
            http: super::http::shared_http_client(),
        }
    }

    pub fn faf(tokens: crate::infra::session::TokenStore) -> Self {
        Self::new(ReportingConfig::faf(), tokens)
    }
}

#[async_trait]
impl ReportingPort for ReportingClient {
    async fn submit(&self, request: ReportPlayerRequest) -> Result<(), String> {
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;
        let url = format!("{}/data/moderationReport", self.config.api_base);
        let document = moderation_report_document(&request);
        let response = self
            .http
            .post(&url)
            .bearer_auth(token)
            .header(reqwest::header::ACCEPT, "application/vnd.api+json")
            .header(reqwest::header::CONTENT_TYPE, "application/vnd.api+json")
            .json(&document)
            .send()
            .await
            .map_err(|error| format!("report request failed: {error}"))?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let body = response.text().await.unwrap_or_default();
        Err(format!(
            "moderation report returned {status}: {}",
            body.chars().take(240).collect::<String>()
        ))
    }

    async fn history(&self, reporter_id: i32) -> Result<Vec<ModerationReportSummary>, String> {
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;
        let mut url = url::Url::parse(&format!("{}/data/moderationReport", self.config.api_base))
            .map_err(|error| format!("invalid API base: {error}"))?;
        url.query_pairs_mut()
            .append_pair("filter", &format!("reporter.id=={reporter_id}"))
            .append_pair("sort", "-createTime")
            .append_pair("page[size]", "100")
            .append_pair("include", "reportedUsers,lastModerator,game");
        let document = fetch_document(&self.http, url, &token).await?;
        Ok(parse_history(&document))
    }

    async fn game_participation(
        &self,
        game_id: i32,
        player_id: i32,
    ) -> Result<GameParticipation, String> {
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;
        let mut url = url::Url::parse(&format!("{}/data/game", self.config.api_base))
            .map_err(|error| format!("invalid API base: {error}"))?;
        url.query_pairs_mut()
            .append_pair("filter", &format!("id=={game_id}"))
            .append_pair("page[size]", "1")
            .append_pair("include", "playerStats.player");
        let document = fetch_document(&self.http, url, &token).await?;
        Ok(participation_from_document(&document, player_id))
    }
}

fn participation_from_document(document: &JsonApiDoc, player_id: i32) -> GameParticipation {
    let Some(game) = document.data.first() else {
        return GameParticipation::GameNotFound;
    };
    let index = document_index(document);
    if rel_many(game, "playerStats").iter().any(|key| {
        index
            .get(key)
            .and_then(|stat| rel_one(stat, "player"))
            .is_some_and(|(_, id)| id.parse::<i32>().ok() == Some(player_id))
    }) {
        GameParticipation::PlayerPresent
    } else {
        GameParticipation::PlayerAbsent
    }
}

fn parse_history(document: &JsonApiDoc) -> Vec<ModerationReportSummary> {
    let index = document_index(document);
    document
        .data
        .iter()
        .filter_map(|resource| parse_history_entry(resource, &index))
        .collect()
}

fn parse_history_entry(
    resource: &JsonApiResource,
    index: &crate::infra::jsonapi::ResourceIndex<'_>,
) -> Option<ModerationReportSummary> {
    let player_name = |key: &(String, String)| {
        index
            .get(key)
            .map(|player| value_string(&player.attributes, "login"))
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| format!("Player {}", key.1))
    };
    let mut offenders: Vec<String> = rel_many(resource, "reportedUsers")
        .iter()
        .map(player_name)
        .collect();
    offenders.sort_by_key(|name| name.to_lowercase());
    Some(ModerationReportSummary {
        id: resource.id.parse().ok()?,
        create_time: value_string(&resource.attributes, "createTime"),
        offenders,
        game_id: rel_one(resource, "game").and_then(|(_, id)| id.parse().ok()),
        description: value_string(&resource.attributes, "reportDescription"),
        moderator: rel_one(resource, "lastModerator")
            .map(|key| player_name(&key))
            .unwrap_or_default(),
        moderator_notice: value_string(&resource.attributes, "moderatorNotice"),
        status: value_string(&resource.attributes, "reportStatus"),
    })
}

fn moderation_report_document(request: &ReportPlayerRequest) -> serde_json::Value {
    let mut relationships = json!({
        "reporter": { "data": { "type": "player", "id": request.reporter_id.to_string() } },
        "reportedUsers": { "data": [{ "type": "player", "id": request.reported_player_id.to_string() }] }
    });
    if let Some(game_id) = request.game_id {
        relationships["game"] = json!({ "data": { "type": "game", "id": game_id.to_string() } });
    }
    json!({
        "data": {
            "type": "moderationReport",
            "attributes": {
                "reportDescription": request.description,
                "gameIncidentTimeCode": request.incident_time,
            },
            "relationships": relationships,
        }
    })
}

#[derive(Debug, Default)]
pub struct FakeReporting;

#[async_trait]
impl ReportingPort for FakeReporting {
    async fn submit(&self, _request: ReportPlayerRequest) -> Result<(), String> {
        Ok(())
    }

    async fn history(&self, _reporter_id: i32) -> Result<Vec<ModerationReportSummary>, String> {
        Ok(Vec::new())
    }

    async fn game_participation(
        &self,
        _game_id: i32,
        _player_id: i32,
    ) -> Result<GameParticipation, String> {
        Ok(GameParticipation::PlayerPresent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_document_matches_the_faf_json_api_contract() {
        let document = moderation_report_document(&ReportPlayerRequest {
            reporter_id: 7,
            reported_player_id: 12,
            description: "Intentional team killing".into(),
            game_id: Some(99),
            incident_time: "18:30".into(),
        });

        assert_eq!(document["data"]["type"], "moderationReport");
        assert_eq!(
            document["data"]["attributes"]["reportDescription"],
            "Intentional team killing"
        );
        assert_eq!(
            document["data"]["relationships"]["reporter"]["data"]["id"],
            "7"
        );
        assert_eq!(
            document["data"]["relationships"]["reportedUsers"]["data"][0]["id"],
            "12"
        );
        assert_eq!(
            document["data"]["relationships"]["game"]["data"]["id"],
            "99"
        );
    }

    #[test]
    fn report_document_omits_the_game_relationship_when_not_supplied() {
        let document = moderation_report_document(&ReportPlayerRequest {
            reporter_id: 7,
            reported_player_id: 12,
            description: "Repeated abusive chat messages".into(),
            game_id: None,
            incident_time: String::new(),
        });

        assert!(document["data"]["relationships"].get("game").is_none());
    }

    #[test]
    fn history_preserves_moderation_details_and_relationship_names() {
        let document: JsonApiDoc = serde_json::from_value(json!({
            "data": [{
                "type": "moderationReport", "id": "42",
                "attributes": {
                    "createTime": "2026-08-10T18:30:00Z",
                    "reportDescription": "Intentional team killing",
                    "reportStatus": "PROCESSING",
                    "moderatorNotice": "Replay requested"
                },
                "relationships": {
                    "reportedUsers": { "data": [{ "type": "player", "id": "12" }] },
                    "lastModerator": { "data": { "type": "player", "id": "9" } },
                    "game": { "data": { "type": "game", "id": "99" } }
                }
            }],
            "included": [
                { "type": "player", "id": "12", "attributes": { "login": "Offender" } },
                { "type": "player", "id": "9", "attributes": { "login": "Moderator" } }
            ]
        }))
        .unwrap();

        let reports = parse_history(&document);
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].id, 42);
        assert_eq!(reports[0].offenders, ["Offender"]);
        assert_eq!(reports[0].game_id, Some(99));
        assert_eq!(reports[0].moderator, "Moderator");
        assert_eq!(reports[0].moderator_notice, "Replay requested");
    }

    #[test]
    fn game_validation_distinguishes_missing_games_players_and_participants() {
        let missing: JsonApiDoc = serde_json::from_value(json!({ "data": [] })).unwrap();
        assert_eq!(
            participation_from_document(&missing, 12),
            GameParticipation::GameNotFound
        );

        let game: JsonApiDoc = serde_json::from_value(json!({
            "data": [{
                "type": "game", "id": "99", "attributes": {},
                "relationships": { "playerStats": { "data": [
                    { "type": "gamePlayerStats", "id": "501" }
                ] } }
            }],
            "included": [{
                "type": "gamePlayerStats", "id": "501", "attributes": {},
                "relationships": { "player": { "data": { "type": "player", "id": "12" } } }
            }]
        }))
        .unwrap();
        assert_eq!(
            participation_from_document(&game, 12),
            GameParticipation::PlayerPresent
        );
        assert_eq!(
            participation_from_document(&game, 13),
            GameParticipation::PlayerAbsent
        );
    }
}
