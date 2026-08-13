//! Real leaderboard client — two parallel FAF ranking systems (see the
//! domain module docs for why): ladder-bracket league/season/division
//! rankings (mirrors the Java client's `LeaderboardService`), and the flat
//! global rating list (mirrors the Python client's `LeaderboardWidget` /
//! `LeaderboardRatingApiConnector`).
//!
//! ## Ladder brackets — [`LeaderboardClient::list_entries`]
//! Four sequential requests (same "resolve an id, then fetch the thing
//! that needs it" shape as `infra::game_updater`'s mod-id lookup -> file-
//! list fetch):
//!
//! 1. `GET {api_base}/data/leagueSeason`, filtered to the given league and
//!    to seasons whose `startDate`/`endDate` bracket "now", `include=
//!    leaderboard` — the active season, and which flat rating-leaderboard
//!    resource its game mode's ratings live under (the `leagueSeason.
//!    leaderboard` relationship, mirroring `LeaderboardService.java`'s own
//!    `leagueSeason.leaderboard.technicalName` filter path — note its JSON:
//!    API resource `type` is actually `leagueLeaderboard`, confirmed
//!    against the real API, not the naively-guessable `leaderboard`; the
//!    parsing code resolves this dynamically rather than hardcoding it).
//!    No active season is not an error; the league just isn't running
//!    right now, so rankings are empty.
//! 2. `GET {api_base}/data/leagueSeasonScore`, filtered to that season,
//!    `include=leagueSeasonDivisionSubdivision.leagueSeasonDivision` for
//!    the division/subdivision (Bronze III, Gold I, …) each score sits in.
//!    **No `player` relationship exists on this resource** (confirmed
//!    against the real API — `include=player` 400s with "does not contain
//!    the field player") — the player is a plain `loginId` attribute
//!    instead, and games played is `gameCount`, not `gamesPlayed`
//!    (`LeaderboardMapper.java`: `@Mapping(target = "gamesPlayed", source =
//!    "source.gameCount")`). `rank` isn't an API field either — it's the
//!    position after sorting by `score` descending (the request's own
//!    `sort` param is trusted for locality but not correctness; re-sorted
//!    defensively before assigning ranks).
//! 3. `GET {api_base}/data/player?filter=id=in=(...)` — batch-resolve the
//!    distinct `loginId`s into login names (mirrors Java's
//!    `playerService.getPlayersByIds`).
//! 4. `GET {api_base}/data/leaderboardRating?filter=leaderboard.id==..;
//!    player.id=in=(...)`, `include=player` — batch-resolve each player's
//!    underlying rating for this game mode (a ladder score alone doesn't
//!    say how strong the player actually is at the game — the reference
//!    clients show both).
//!
//! Division/subdivision names come from `nameKey` attributes, which are
//! this client's usual "no i18n table, show as-is" pragmatic choice (same
//! as league technical names and mod names elsewhere) — displayed as-is
//! rather than resolved through a translation bundle.
//!
//! ## Global rating — [`LeaderboardClient::list_global`]
//! One request: `GET {api_base}/data/leaderboardRating?filter=
//! leaderboard.technicalName=="global";updateTime=ge="{1 month ago}"`,
//! `sort=-rating`, `include=player` — mirrors
//! `LeaderboardWidget.prepareFilters()`'s default "only active" filter
//! (players who haven't played in the last month are dropped, not just
//! sorted last, matching the Python client exactly).

use std::collections::HashMap;

use async_trait::async_trait;
use faf_domain::state::{LeaderboardEntry, League};
use serde::Deserialize;
use serde_json::Value;

use crate::infra::env_or;
use crate::ports::LeaderboardPort;

#[derive(Debug, Clone)]
pub struct LeaderboardConfig {
    /// FAF Data API base — same host as the map/replay vaults.
    pub api_base: String,
}

impl LeaderboardConfig {
    pub fn faf() -> Self {
        Self {
            api_base: env_or("FAF_API_BASE", "https://api.faforever.com"),
        }
    }
}

pub struct LeaderboardClient {
    config: LeaderboardConfig,
    tokens: crate::infra::session::TokenStore,
    http: reqwest::Client,
}

impl LeaderboardClient {
    pub fn new(config: LeaderboardConfig, tokens: crate::infra::session::TokenStore) -> Self {
        Self {
            config,
            tokens,
            http: reqwest::Client::new(),
        }
    }

    pub fn faf(tokens: crate::infra::session::TokenStore) -> Self {
        Self::new(LeaderboardConfig::faf(), tokens)
    }

    async fn get_json(&self, url: url::Url, token: &str) -> Result<JsonApiDoc, String> {
        let resp = self
            .http
            .get(url.clone())
            .bearer_auth(token)
            .header(reqwest::header::ACCEPT, "application/vnd.api+json")
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
        if !status.is_success() {
            return Err(format!(
                "{} returned {status}: {}",
                url.path(),
                body.chars().take(200).collect::<String>()
            ));
        }
        serde_json::from_str(&body).map_err(|e| format!("invalid JSON: {e}"))
    }

    /// The currently active season's id and its underlying flat leaderboard
    /// id, or `None` if the league has no season running right now.
    async fn active_season(
        &self,
        league_id: i32,
        token: &str,
    ) -> Result<Option<(String, String)>, String> {
        // `Z`-suffixed, not `+00:00`-offset — matches the Java/Python
        // clients' own UTC timestamp serialization (`OffsetDateTime`/Qt
        // `ISODate`), which the API's RSQL date parser is written against.
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let mut url = url::Url::parse(&format!("{}/data/leagueSeason", self.config.api_base))
            .map_err(|e| format!("invalid API base: {e}"))?;
        url.query_pairs_mut()
            .append_pair(
                "filter",
                // Parenthesized, mirroring the Python client's own
                // `"({})".format(";".join(filters))` filter-combining
                // convention for the API's RSQL parser.
                &format!("(league.id=={league_id};startDate=le=\"{now}\";endDate=ge=\"{now}\")"),
            )
            .append_pair("include", "leaderboard");

        let doc = self.get_json(url, token).await?;
        let index = resource_index(&doc.included);
        Ok(doc.data.first().and_then(|season| {
            // The relationship's own `type` (confirmed against the real API
            // to be `leagueLeaderboard`, not the `leaderboard` we might
            // naively guess) — resolved dynamically rather than hardcoded,
            // so this keeps working if that ever changes.
            let (rel_kind, leaderboard_id) = rel_target(&season.relationships, "leaderboard")?;
            // Confirm the resource actually came back in `included` (defends
            // against a dangling relationship) without needing its fields.
            index.get(&(rel_kind, leaderboard_id.clone()))?;
            Some((season.id.clone(), leaderboard_id))
        }))
    }

    /// Batch-resolve login ids to display names. Empty input short-circuits
    /// to an empty map without a request.
    async fn resolve_player_names(
        &self,
        login_ids: &[i32],
        token: &str,
    ) -> Result<HashMap<i32, String>, String> {
        if login_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let ids_csv = login_ids
            .iter()
            .map(i32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let mut url = url::Url::parse(&format!("{}/data/player", self.config.api_base))
            .map_err(|e| format!("invalid API base: {e}"))?;
        url.query_pairs_mut()
            .append_pair("filter", &format!("id=in=({ids_csv})"))
            .append_pair("page[size]", &login_ids.len().to_string());

        let doc = self.get_json(url, token).await?;
        Ok(doc
            .data
            .iter()
            .filter_map(|r| {
                let id: i32 = r.id.parse().ok()?;
                let login = r.attributes.get("login").and_then(Value::as_str)?.to_string();
                Some((id, login))
            })
            .collect())
    }

    /// Batch-resolve each player's rating on `leaderboard_id`. Missing
    /// entries (a player who's never played that game mode) are simply
    /// absent from the returned map — callers treat that as `None`.
    async fn resolve_ratings(
        &self,
        leaderboard_id: &str,
        player_ids: &[i32],
        token: &str,
    ) -> Result<HashMap<i32, i32>, String> {
        if player_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let ids_csv = player_ids
            .iter()
            .map(i32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let mut url = url::Url::parse(&format!("{}/data/leaderboardRating", self.config.api_base))
            .map_err(|e| format!("invalid API base: {e}"))?;
        url.query_pairs_mut()
            .append_pair(
                "filter",
                &format!("leaderboard.id=={leaderboard_id};player.id=in=({ids_csv})"),
            )
            .append_pair("include", "player")
            .append_pair("page[size]", &player_ids.len().to_string());

        let doc = self.get_json(url, token).await?;
        let index = resource_index(&doc.included);
        Ok(doc
            .data
            .iter()
            .filter_map(|r| {
                let (_, player_id) = rel_target(&r.relationships, "player")?;
                index.get(&("player".to_string(), player_id.clone()))?; // sanity check
                let id: i32 = player_id.parse().ok()?;
                let rating = r.attributes.get("rating").and_then(Value::as_f64)?;
                Some((id, rating.round() as i32))
            })
            .collect())
    }
}

#[async_trait]
impl LeaderboardPort for LeaderboardClient {
    async fn list_leagues(&self) -> Result<Vec<League>, String> {
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;

        let mut url = url::Url::parse(&format!("{}/data/league", self.config.api_base))
            .map_err(|e| format!("invalid API base: {e}"))?;
        url.query_pairs_mut().append_pair("filter", "enabled==true");

        let doc = self.get_json(url, &token).await?;
        Ok(parse_leagues(&doc))
    }

    async fn list_entries(&self, league_id: i32) -> Result<Vec<LeaderboardEntry>, String> {
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;

        let Some((season_id, leaderboard_id)) = self.active_season(league_id, &token).await?
        else {
            return Ok(Vec::new());
        };

        let mut url = url::Url::parse(&format!("{}/data/leagueSeasonScore", self.config.api_base))
            .map_err(|e| format!("invalid API base: {e}"))?;
        url.query_pairs_mut()
            .append_pair("filter", &format!("(leagueSeason.id=={season_id};score=ge=0)"))
            .append_pair("sort", "-score")
            .append_pair("page[size]", "1000")
            .append_pair("include", "leagueSeasonDivisionSubdivision.leagueSeasonDivision");

        let doc = self.get_json(url, &token).await?;
        let raw = parse_raw_entries(&doc);

        let login_ids: Vec<i32> = raw.iter().map(|r| r.login_id).collect();
        let names = self.resolve_player_names(&login_ids, &token).await?;
        let ratings = self
            .resolve_ratings(&leaderboard_id, &login_ids, &token)
            .await?;

        Ok(build_entries(raw, &names, &ratings))
    }

    async fn list_global(&self) -> Result<Vec<LeaderboardEntry>, String> {
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;

        let one_month_ago = (chrono::Utc::now() - chrono::Duration::days(30)).to_rfc3339();
        let mut url = url::Url::parse(&format!("{}/data/leaderboardRating", self.config.api_base))
            .map_err(|e| format!("invalid API base: {e}"))?;
        url.query_pairs_mut()
            .append_pair(
                "filter",
                &format!("leaderboard.technicalName==\"global\";updateTime=ge=\"{one_month_ago}\""),
            )
            .append_pair("sort", "-rating")
            .append_pair("page[size]", "1000")
            .append_pair("include", "player");

        let doc = self.get_json(url, &token).await?;
        Ok(parse_global_entries(&doc))
    }
}

/// A JSON:API document: the top-level resources plus everything the
/// `include` query param pulled in (mirrors `infra::replay::JsonApiDoc`).
#[derive(Debug, Default, Deserialize)]
struct JsonApiDoc {
    #[serde(default)]
    data: Vec<JsonApiResource>,
    #[serde(default)]
    included: Vec<JsonApiResource>,
}

#[derive(Debug, Clone, Deserialize)]
struct JsonApiResource {
    #[serde(rename = "type")]
    kind: String,
    id: String,
    #[serde(default)]
    attributes: Value,
    #[serde(default)]
    relationships: Value,
}

fn resource_index(included: &[JsonApiResource]) -> HashMap<(String, String), &JsonApiResource> {
    included
        .iter()
        .map(|r| ((r.kind.clone(), r.id.clone()), r))
        .collect()
}

fn rel_target(relationships: &Value, name: &str) -> Option<(String, String)> {
    let data = relationships.get(name)?.get("data")?;
    Some((
        data.get("type")?.as_str()?.to_string(),
        data.get("id")?.as_str()?.to_string(),
    ))
}

fn parse_leagues(doc: &JsonApiDoc) -> Vec<League> {
    doc.data
        .iter()
        .filter_map(|r| {
            let id: i32 = r.id.parse().ok()?;
            let technical_name = r
                .attributes
                .get("technicalName")
                .and_then(Value::as_str)?
                .to_string();
            Some(League { id, technical_name })
        })
        .collect()
}

/// `leagueSeasonScore.relationships.leagueSeasonDivisionSubdivision ->
/// attributes.nameKey`/`subdivisionIndex`, plus one more hop to
/// `.relationships.leagueSeasonDivision -> attributes.nameKey`/
/// `divisionIndex` for the parent division. Display name combined as
/// `"{Division} {Subdivision}"`; the order is `divisionIndex * 1000 +
/// subdivisionIndex` (a division has at most a handful of subdivisions, so
/// 1000 is a very safe multiplier) — higher is a higher-tier division,
/// matching `LeaderboardService.java`'s own sort
/// (`addSortingRule(".divisionIndex", false)`, i.e. descending = highest
/// first). `None` if either hop can't be resolved (e.g. a placement-game
/// score with no division assigned yet).
fn resolve_division(
    relationships: &Value,
    index: &HashMap<(String, String), &JsonApiResource>,
) -> Option<(String, i32)> {
    let subdivision = rel_target(relationships, "leagueSeasonDivisionSubdivision")
        .and_then(|k| index.get(&k))?;
    let subdivision_name = subdivision.attributes.get("nameKey").and_then(Value::as_str)?;
    let subdivision_index = subdivision
        .attributes
        .get("subdivisionIndex")
        .and_then(Value::as_i64)
        .unwrap_or(0);

    let division = rel_target(&subdivision.relationships, "leagueSeasonDivision")
        .and_then(|k| index.get(&k));
    let division_name = division.and_then(|d| d.attributes.get("nameKey")).and_then(Value::as_str);
    let division_index = division
        .and_then(|d| d.attributes.get("divisionIndex"))
        .and_then(Value::as_i64)
        .unwrap_or(0);

    let name = match division_name {
        Some(division_name) => format!("{division_name} {subdivision_name}"),
        None => subdivision_name.to_string(),
    };
    Some((name, (division_index * 1000 + subdivision_index) as i32))
}

/// A `leagueSeasonScore` row before its `loginId` has been resolved to a
/// display name and rating.
struct RawEntry {
    login_id: i32,
    score: i32,
    games_played: i32,
    division: Option<String>,
    division_order: Option<i32>,
}

fn parse_raw_entries(doc: &JsonApiDoc) -> Vec<RawEntry> {
    let index = resource_index(&doc.included);
    doc.data
        .iter()
        .map(|r| {
            let (division, division_order) = match resolve_division(&r.relationships, &index) {
                Some((name, order)) => (Some(name), Some(order)),
                None => (None, None),
            };
            RawEntry {
                login_id: r
                    .attributes
                    .get("loginId")
                    .and_then(Value::as_i64)
                    .unwrap_or(0) as i32,
                score: r.attributes.get("score").and_then(Value::as_i64).unwrap_or(0) as i32,
                // Not a typo — the API's field is `gameCount`, not
                // `gamesPlayed` (see the module docs).
                games_played: r
                    .attributes
                    .get("gameCount")
                    .and_then(Value::as_i64)
                    .unwrap_or(0) as i32,
                division,
                division_order,
            }
        })
        .collect()
}

fn build_entries(
    raw: Vec<RawEntry>,
    names: &HashMap<i32, String>,
    ratings: &HashMap<i32, i32>,
) -> Vec<LeaderboardEntry> {
    let mut entries: Vec<LeaderboardEntry> = raw
        .into_iter()
        .map(|r| LeaderboardEntry {
            rank: 0, // assigned below, after sorting
            player_name: names.get(&r.login_id).cloned().unwrap_or_else(|| "unknown".to_string()),
            score: Some(r.score),
            rating: ratings.get(&r.login_id).copied(),
            games_played: r.games_played,
            division: r.division,
            division_order: r.division_order,
        })
        .collect();

    // Trust the request's `sort=-score` for locality but not correctness —
    // re-sort defensively before assigning ranks.
    entries.sort_by_key(|e| std::cmp::Reverse(e.score));
    for (i, entry) in entries.iter_mut().enumerate() {
        entry.rank = i as i32 + 1;
    }
    entries
}

fn parse_global_entries(doc: &JsonApiDoc) -> Vec<LeaderboardEntry> {
    let index = resource_index(&doc.included);
    let mut entries: Vec<LeaderboardEntry> = doc
        .data
        .iter()
        .map(|r| {
            let player_name = rel_target(&r.relationships, "player")
                .and_then(|k| index.get(&k))
                .and_then(|p| p.attributes.get("login"))
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let rating = r
                .attributes
                .get("rating")
                .and_then(Value::as_f64)
                .map(|v| v.round() as i32);
            let games_played = r
                .attributes
                .get("totalGames")
                .and_then(Value::as_i64)
                .unwrap_or(0) as i32;
            LeaderboardEntry {
                rank: 0, // assigned below, after sorting
                player_name,
                score: None,
                rating,
                games_played,
                division: None,
                division_order: None,
            }
        })
        .collect();

    entries.sort_by_key(|e| std::cmp::Reverse(e.rating.unwrap_or(i32::MIN)));
    for (i, entry) in entries.iter_mut().enumerate() {
        entry.rank = i as i32 + 1;
    }
    entries
}

/// Inert leaderboard client — used offline and in tests (mirrors
/// [`crate::infra::FakeMaps`]).
#[derive(Debug, Clone, Default)]
pub struct FakeLeaderboard;

#[async_trait]
impl LeaderboardPort for FakeLeaderboard {
    async fn list_leagues(&self) -> Result<Vec<League>, String> {
        Err("leaderboard is disabled (FAF_REAL_LAUNCH not set)".to_string())
    }

    async fn list_entries(&self, _league_id: i32) -> Result<Vec<LeaderboardEntry>, String> {
        Err("leaderboard is disabled (FAF_REAL_LAUNCH not set)".to_string())
    }

    async fn list_global(&self) -> Result<Vec<LeaderboardEntry>, String> {
        Err("leaderboard is disabled (FAF_REAL_LAUNCH not set)".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_leagues_from_flat_attributes() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [
                { "type": "league", "id": "1", "attributes": { "technicalName": "ladder1v1", "enabled": true } },
                { "type": "league", "id": "2", "attributes": { "technicalName": "ladder2v2", "enabled": true } },
            ],
        }))
        .unwrap();

        let leagues = parse_leagues(&doc);
        assert_eq!(leagues.len(), 2);
        assert_eq!(leagues[0].id, 1);
        assert_eq!(leagues[0].technical_name, "ladder1v1");
        assert_eq!(leagues[1].technical_name, "ladder2v2");
    }

    #[test]
    fn parses_raw_entries_from_login_id_and_game_count_attributes() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [
                {
                    "type": "leagueSeasonScore",
                    "id": "1",
                    "attributes": { "loginId": 500, "score": 1200, "gameCount": 10 },
                    "relationships": {
                        "leagueSeasonDivisionSubdivision": { "data": { "type": "leagueSeasonDivisionSubdivision", "id": "9" } },
                    },
                },
                {
                    "type": "leagueSeasonScore",
                    "id": "2",
                    "attributes": { "loginId": 501, "score": 1500, "gameCount": 20 },
                    "relationships": {},
                },
            ],
            "included": [
                {
                    "type": "leagueSeasonDivisionSubdivision",
                    "id": "9",
                    "attributes": { "nameKey": "III", "subdivisionIndex": 3 },
                    "relationships": {
                        "leagueSeasonDivision": { "data": { "type": "leagueSeasonDivision", "id": "3" } },
                    },
                },
                {
                    "type": "leagueSeasonDivision",
                    "id": "3",
                    "attributes": { "nameKey": "Bronze", "divisionIndex": 1 },
                },
            ],
        }))
        .unwrap();

        let raw = parse_raw_entries(&doc);
        assert_eq!(raw.len(), 2);
        assert_eq!(raw[0].login_id, 500);
        assert_eq!(raw[0].score, 1200);
        assert_eq!(raw[0].division.as_deref(), Some("Bronze III"));
        assert_eq!(raw[0].division_order, Some(1003));
        assert_eq!(raw[1].login_id, 501);
        assert_eq!(raw[1].games_played, 20);
        assert_eq!(raw[1].division, None);
        assert_eq!(raw[1].division_order, None);
    }

    #[test]
    fn build_entries_resolves_names_ratings_and_assigns_rank_by_score() {
        let raw = vec![
            RawEntry { login_id: 500, score: 1200, games_played: 10, division: Some("Bronze III".into()), division_order: Some(1003) },
            RawEntry { login_id: 501, score: 1500, games_played: 20, division: None, division_order: None },
            RawEntry { login_id: 502, score: 900, games_played: 5, division: None, division_order: None },
        ];
        let names = HashMap::from([
            (500, "Seraphim-Noob".to_string()),
            (501, "Nomander".to_string()),
            // 502 deliberately missing — falls back to "unknown".
        ]);
        let ratings = HashMap::from([(500, 1150), (501, 1400)]); // 502: never played this mode

        let entries = build_entries(raw, &names, &ratings);
        assert_eq!(entries.len(), 3);
        // Higher score ranks first, regardless of input order.
        assert_eq!(entries[0].rank, 1);
        assert_eq!(entries[0].player_name, "Nomander");
        assert_eq!(entries[0].score, Some(1500));
        assert_eq!(entries[0].rating, Some(1400));
        assert_eq!(entries[1].rank, 2);
        assert_eq!(entries[1].player_name, "Seraphim-Noob");
        assert_eq!(entries[1].division.as_deref(), Some("Bronze III"));
        assert_eq!(entries[2].rank, 3);
        assert_eq!(entries[2].player_name, "unknown");
        assert_eq!(entries[2].rating, None);
    }

    #[test]
    fn build_entries_defaults_gracefully_for_missing_attributes() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [{ "type": "leagueSeasonScore", "id": "1", "attributes": {} }],
        }))
        .unwrap();

        let raw = parse_raw_entries(&doc);
        let entries = build_entries(raw, &HashMap::new(), &HashMap::new());
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].player_name, "unknown");
        assert_eq!(entries[0].score, Some(0));
        assert_eq!(entries[0].rating, None);
        assert_eq!(entries[0].rank, 1);
        assert_eq!(entries[0].division, None);
    }

    #[test]
    fn parses_global_entries_resolving_player_and_ranking_by_rating() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [
                {
                    "type": "leaderboardRating",
                    "id": "1",
                    "attributes": { "rating": 1150.4, "totalGames": 300 },
                    "relationships": { "player": { "data": { "type": "player", "id": "500" } } },
                },
                {
                    "type": "leaderboardRating",
                    "id": "2",
                    "attributes": { "rating": 1600.9, "totalGames": 900 },
                    "relationships": { "player": { "data": { "type": "player", "id": "501" } } },
                },
            ],
            "included": [
                { "type": "player", "id": "500", "attributes": { "login": "Seraphim-Noob" } },
                { "type": "player", "id": "501", "attributes": { "login": "Nomander" } },
            ],
        }))
        .unwrap();

        let entries = parse_global_entries(&doc);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].rank, 1);
        assert_eq!(entries[0].player_name, "Nomander");
        assert_eq!(entries[0].rating, Some(1601));
        assert_eq!(entries[0].score, None);
        assert_eq!(entries[0].division, None);
        assert_eq!(entries[1].rank, 2);
        assert_eq!(entries[1].games_played, 300);
    }

    #[tokio::test]
    async fn fake_leaderboard_fails_cleanly() {
        let fake = FakeLeaderboard;
        assert!(fake.list_leagues().await.is_err());
        assert!(fake.list_entries(1).await.is_err());
        assert!(fake.list_global().await.is_err());
    }
}
