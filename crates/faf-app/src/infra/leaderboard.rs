//! FAF Data API implementation for rating boards and competitive leagues.

use std::collections::HashMap;

use async_trait::async_trait;
use faf_domain::state::{
    LeaderboardEntry, LeaderboardTier, League, LeagueSeason, RatingLeaderboard, RatingPage,
    RatingQuery, SeasonLeaderboard,
};
use serde_json::Value;

use crate::infra::env_or;
use crate::infra::jsonapi::{
    fetch_document, rel_target, rel_targets, resource_index, JsonApiDoc, JsonApiResource,
};
use crate::ports::LeaderboardPort;

const MAX_SEASON_ENTRIES: usize = 10_000;
const ID_CHUNK_SIZE: usize = 200;

#[derive(Debug, Clone)]
pub struct LeaderboardConfig {
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

#[derive(Debug, Clone, Default)]
struct RatingStats {
    rating: Option<i32>,
    mean: Option<f64>,
    deviation: Option<f64>,
    games_played: i32,
    won_games: Option<i32>,
    update_time: Option<String>,
}

impl LeaderboardClient {
    pub fn new(config: LeaderboardConfig, tokens: crate::infra::session::TokenStore) -> Self {
        Self {
            config,
            tokens,
            http: super::http::shared_http_client(),
        }
    }

    pub fn faf(tokens: crate::infra::session::TokenStore) -> Self {
        Self::new(LeaderboardConfig::faf(), tokens)
    }

    fn token(&self) -> Result<String, String> {
        self.tokens.get().ok_or_else(|| "not logged in".to_string())
    }

    fn collection_url(&self, resource: &str) -> Result<url::Url, String> {
        url::Url::parse(&format!("{}/data/{resource}", self.config.api_base))
            .map_err(|error| format!("invalid API base: {error}"))
    }

    async fn get_json(&self, url: url::Url, token: &str) -> Result<JsonApiDoc, String> {
        fetch_document(&self.http, url, token).await
    }

    async fn resolve_player_names(
        &self,
        player_ids: &[i32],
        token: &str,
    ) -> Result<HashMap<i32, String>, String> {
        let mut names = HashMap::new();
        for chunk in unique_ids(player_ids).chunks(ID_CHUNK_SIZE) {
            let ids = csv_ids(chunk);
            let mut url = self.collection_url("player")?;
            url.query_pairs_mut()
                .append_pair("filter", &format!("id=in=({ids})"))
                .append_pair("page[size]", &chunk.len().to_string());
            let doc = self.get_json(url, token).await?;
            names.extend(doc.data.iter().filter_map(|resource| {
                Some((
                    resource.id.parse().ok()?,
                    string_attr(resource, "login")?.to_string(),
                ))
            }));
        }
        Ok(names)
    }

    async fn season_tiers(
        &self,
        season_id: i32,
        token: &str,
    ) -> Result<Vec<LeaderboardTier>, String> {
        let mut url = self.collection_url("leagueSeasonDivisionSubdivision")?;
        url.query_pairs_mut()
            .append_pair(
                "filter",
                &format!("leagueSeasonDivision.leagueSeason.id=={season_id}"),
            )
            .append_pair("include", "leagueSeasonDivision")
            .append_pair("page[size]", "1000");
        let doc = self.get_json(url, token).await?;
        Ok(parse_tiers(&doc))
    }

    async fn season_scores(
        &self,
        season_id: i32,
        token: &str,
    ) -> Result<Vec<RawSeasonEntry>, String> {
        let mut url = self.collection_url("leagueSeasonScore")?;
        url.query_pairs_mut()
            .append_pair(
                "filter",
                &format!("(leagueSeason.id=={season_id};score=ge=0)"),
            )
            .append_pair(
                "sort",
                "-leagueSeasonDivisionSubdivision.leagueSeasonDivision.divisionIndex,-leagueSeasonDivisionSubdivision.subdivisionIndex,-score",
            )
            .append_pair("page[size]", &MAX_SEASON_ENTRIES.to_string())
            .append_pair(
                "include",
                "leagueSeasonDivisionSubdivision.leagueSeasonDivision",
            );
        let doc = self.get_json(url, token).await?;
        Ok(parse_raw_season_entries(&doc))
    }
}

#[async_trait]
impl LeaderboardPort for LeaderboardClient {
    async fn list_rating_leaderboards(&self) -> Result<Vec<RatingLeaderboard>, String> {
        let token = self.token()?;
        let mut url = self.collection_url("leaderboard")?;
        url.query_pairs_mut()
            .append_pair("sort", "id")
            .append_pair("page[size]", "100");
        let doc = self.get_json(url, &token).await?;
        Ok(parse_rating_leaderboards(&doc))
    }

    async fn list_leagues(&self) -> Result<Vec<League>, String> {
        let token = self.token()?;
        let mut url = self.collection_url("league")?;
        url.query_pairs_mut()
            .append_pair("filter", "enabled==true")
            .append_pair("sort", "technicalName")
            .append_pair("page[size]", "100");
        let doc = self.get_json(url, &token).await?;
        Ok(parse_leagues(&doc))
    }

    async fn list_ratings(&self, query: &RatingQuery) -> Result<RatingPage, String> {
        let token = self.token()?;
        let mut filters = vec![format!(
            "leaderboard.technicalName==\"{}\"",
            escape_filter_value(&query.leaderboard)
        )];
        if query.active_only {
            let cutoff = (chrono::Utc::now() - chrono::Duration::days(30))
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string();
            filters.push(format!("updateTime=ge=\"{cutoff}\""));
        } else {
            if let Some(after) = query
                .updated_after
                .as_deref()
                .filter(|value| !value.is_empty())
            {
                filters.push(format!("updateTime=ge=\"{}\"", escape_filter_value(after)));
            }
            if let Some(before) = query
                .updated_before
                .as_deref()
                .filter(|value| !value.is_empty())
            {
                filters.push(format!("updateTime=le=\"{}\"", escape_filter_value(before)));
            }
        }
        if !query.player.trim().is_empty() {
            filters.push(format!(
                "player.login==\"{}\"",
                escape_filter_value(query.player.trim())
            ));
        }

        let mut url = self.collection_url("leaderboardRating")?;
        url.query_pairs_mut()
            .append_pair("filter", &format!("({})", filters.join(";")))
            .append_pair("sort", "-rating")
            .append_pair(
                "include",
                "player,player.avatarAssignments.avatar,leaderboard",
            )
            .append_pair("page[number]", &query.page.max(1).to_string())
            .append_pair("page[size]", &query.page_size.clamp(25, 1_000).to_string())
            .append_pair("page[totals]", "yes");
        let doc = self.get_json(url, &token).await?;
        Ok(parse_rating_page(&doc, query))
    }

    async fn list_seasons(&self, league_id: i32) -> Result<Vec<LeagueSeason>, String> {
        let token = self.token()?;
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let mut url = self.collection_url("leagueSeason")?;
        url.query_pairs_mut()
            .append_pair(
                "filter",
                &format!("(league.id=={league_id};startDate=le=\"{now}\")"),
            )
            .append_pair("sort", "-startDate")
            .append_pair("include", "league,leaderboard")
            .append_pair("page[size]", "100");
        let doc = self.get_json(url, &token).await?;
        Ok(parse_seasons(&doc))
    }

    async fn list_season_leaderboard(&self, season_id: i32) -> Result<SeasonLeaderboard, String> {
        let token = self.token()?;
        let (tiers, scores) = tokio::join!(
            self.season_tiers(season_id, &token),
            self.season_scores(season_id, &token),
        );
        let tiers = tiers?;
        let raw = scores?;
        let player_ids: Vec<i32> = raw.iter().map(|entry| entry.player_id).collect();
        let names = self.resolve_player_names(&player_ids, &token).await?;
        Ok(SeasonLeaderboard {
            entries: build_season_entries(raw, &names),
            tiers,
        })
    }
}

fn string_attr<'a>(resource: &'a JsonApiResource, name: &str) -> Option<&'a str> {
    resource.attributes.get(name).and_then(Value::as_str)
}

fn i32_attr(resource: &JsonApiResource, name: &str) -> Option<i32> {
    resource
        .attributes
        .get(name)
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
}

fn f64_attr(resource: &JsonApiResource, name: &str) -> Option<f64> {
    resource.attributes.get(name).and_then(Value::as_f64)
}

fn bool_attr(resource: &JsonApiResource, name: &str) -> Option<bool> {
    resource.attributes.get(name).and_then(Value::as_bool)
}

fn avatar_url(
    resource: Option<&JsonApiResource>,
    index: &HashMap<(String, String), &JsonApiResource>,
) -> Option<String> {
    let resource = resource?;
    let assignment = rel_targets(&resource.relationships, "avatarAssignments")
        .into_iter()
        .filter_map(|key| index.get(&key).copied())
        .find(|assignment| bool_attr(assignment, "selected").unwrap_or(false));
    let avatar = assignment
        .and_then(|assignment| rel_target(&assignment.relationships, "avatar"))
        .and_then(|key| index.get(&key).copied());
    avatar
        .and_then(|avatar| string_attr(avatar, "url"))
        .filter(|url| !url.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            resource
                .attributes
                .get("avatarUrl")
                .and_then(Value::as_str)
                .filter(|url| !url.trim().is_empty())
                .map(str::to_string)
        })
}

fn display_key(value: &str) -> String {
    let raw = value
        .rsplit('.')
        .next()
        .unwrap_or(value)
        .replace(['_', '-'], " ");
    raw.split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().chain(chars).collect::<String>())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn pretty_mode_name(technical_name: &str, fallback: &str) -> String {
    match technical_name {
        "global" => "Global".into(),
        "ladder_1v1" | "ladder1v1" => "1v1 Ladder".into(),
        "tmm_2v2" | "ladder2v2" => "2v2".into(),
        "tmm_3v3" | "ladder3v3" => "3v3".into(),
        "tmm_4v4_full_share" | "ladder4v4" => "4v4 Full Share".into(),
        "tmm_4v4_share_until_death" => "4v4 No Share".into(),
        _ if !fallback.is_empty() => display_key(fallback),
        _ => display_key(technical_name),
    }
}

fn parse_rating_leaderboards(doc: &JsonApiDoc) -> Vec<RatingLeaderboard> {
    doc.data
        .iter()
        .filter_map(|resource| {
            let id = resource.id.parse().ok()?;
            let technical_name = string_attr(resource, "technicalName")?.to_string();
            let name_key = string_attr(resource, "nameKey").unwrap_or_default();
            Some(RatingLeaderboard {
                id,
                name: pretty_mode_name(&technical_name, name_key),
                technical_name,
                // A `descriptionKey` is a translation lookup, not prose. The
                // Java client resolves it through its localization bundle;
                // displaying its last segment here produced "Description".
                description: string_attr(resource, "description")
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect()
}

fn parse_leagues(doc: &JsonApiDoc) -> Vec<League> {
    doc.data
        .iter()
        .filter_map(|resource| {
            let id = resource.id.parse().ok()?;
            let technical_name = string_attr(resource, "technicalName")?.to_string();
            let name_key = string_attr(resource, "nameKey").unwrap_or_default();
            Some(League {
                id,
                name: pretty_mode_name(&technical_name, name_key),
                technical_name,
                description: string_attr(resource, "description")
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect()
}

fn parse_seasons(doc: &JsonApiDoc) -> Vec<LeagueSeason> {
    let now = chrono::Utc::now();
    doc.data
        .iter()
        .filter_map(|resource| {
            let id = resource.id.parse().ok()?;
            let league_id = rel_target(&resource.relationships, "league")?
                .1
                .parse()
                .ok()?;
            let leaderboard_id = rel_target(&resource.relationships, "leaderboard")?
                .1
                .parse()
                .ok()?;
            let season_number = i32_attr(resource, "seasonNumber").unwrap_or_default();
            let start_date = string_attr(resource, "startDate")
                .unwrap_or_default()
                .to_string();
            let end_date = string_attr(resource, "endDate")
                .unwrap_or_default()
                .to_string();
            let active = chrono::DateTime::parse_from_rfc3339(&start_date)
                .ok()
                .zip(chrono::DateTime::parse_from_rfc3339(&end_date).ok())
                .is_some_and(|(start, end)| now >= start && now <= end);
            Some(LeagueSeason {
                id,
                league_id,
                leaderboard_id,
                season_number,
                name: format!("Season {season_number}"),
                start_date,
                end_date,
                placement_games: i32_attr(resource, "placementGames").unwrap_or_default(),
                placement_games_returning_player: i32_attr(
                    resource,
                    "placementGamesReturningPlayer",
                )
                .unwrap_or_default(),
                active,
            })
        })
        .collect()
}

fn parse_rating_stats(resource: &JsonApiResource) -> RatingStats {
    RatingStats {
        rating: f64_attr(resource, "rating").map(|value| value.round() as i32),
        mean: f64_attr(resource, "mean"),
        deviation: f64_attr(resource, "deviation"),
        games_played: i32_attr(resource, "totalGames").unwrap_or_default(),
        won_games: i32_attr(resource, "wonGames"),
        update_time: string_attr(resource, "updateTime").map(str::to_string),
    }
}

fn parse_rating_page(doc: &JsonApiDoc, query: &RatingQuery) -> RatingPage {
    let index = resource_index(&doc.included);
    let page = meta_i32(&doc.meta, "number").unwrap_or(query.page.max(1));
    let page_size = meta_i32(&doc.meta, "limit").unwrap_or(query.page_size);
    let mut entries = Vec::with_capacity(doc.data.len());
    for (offset, resource) in doc.data.iter().enumerate() {
        let player_key = rel_target(&resource.relationships, "player");
        let player = player_key.as_ref().and_then(|key| index.get(key).copied());
        let player_id = player_key
            .as_ref()
            .and_then(|(_, id)| id.parse().ok())
            .unwrap_or_default();
        let stats = parse_rating_stats(resource);
        entries.push(LeaderboardEntry {
            player_id,
            rank: (page - 1) * page_size + offset as i32 + 1,
            player_name: player
                .and_then(|value| string_attr(value, "login"))
                .unwrap_or("unknown")
                .to_string(),
            avatar_url: avatar_url(player, &index),
            score: None,
            rating: stats.rating,
            mean: stats.mean,
            deviation: stats.deviation,
            games_played: stats.games_played,
            won_games: stats.won_games,
            update_time: stats.update_time,
            division: None,
            division_order: None,
            highest_score: None,
            division_image_url: None,
            returning_player: None,
        });
    }
    let total_pages = meta_i32(&doc.meta, "totalPages").unwrap_or(1).max(1);
    let total_results = ["totalRecords", "totalResults", "totalElements"]
        .into_iter()
        .find_map(|key| meta_i32(&doc.meta, key));
    RatingPage {
        entries,
        page,
        page_size,
        total_pages,
        total_results,
    }
}

fn meta_i32(meta: &Value, key: &str) -> Option<i32> {
    meta.get("page")?
        .get(key)?
        .as_i64()
        .and_then(|value| i32::try_from(value).ok())
}

fn resolve_tier(
    resource: &JsonApiResource,
    index: &HashMap<(String, String), &JsonApiResource>,
) -> Option<LeaderboardTier> {
    let division =
        rel_target(&resource.relationships, "leagueSeasonDivision").and_then(|key| index.get(&key));
    let division_name = division
        .and_then(|value| string_attr(value, "nameKey"))
        .map(display_key)
        .unwrap_or_else(|| "Placement".into());
    let subdivision = string_attr(resource, "nameKey")
        .map(display_key)
        .unwrap_or_default();
    let division_index = division
        .and_then(|value| i32_attr(value, "divisionIndex"))
        .unwrap_or_default();
    let subdivision_index = i32_attr(resource, "subdivisionIndex").unwrap_or_default();
    Some(LeaderboardTier {
        name: format!("{division_name} {subdivision}").trim().to_string(),
        division: division_name,
        subdivision,
        division_order: division_index * 1_000 + subdivision_index,
        highest_score: i32_attr(resource, "highestScore").unwrap_or_default(),
        image_url: string_attr(resource, "smallImageUrl")
            .or_else(|| string_attr(resource, "imageUrl"))
            .map(str::to_string),
    })
}

fn parse_tiers(doc: &JsonApiDoc) -> Vec<LeaderboardTier> {
    let index = resource_index(&doc.included);
    let mut tiers: Vec<_> = doc
        .data
        .iter()
        .filter_map(|resource| resolve_tier(resource, &index))
        .collect();
    tiers.sort_by_key(|tier| tier.division_order);
    tiers
}

#[derive(Debug)]
struct RawSeasonEntry {
    player_id: i32,
    score: i32,
    games_played: i32,
    returning_player: bool,
    tier: Option<LeaderboardTier>,
}

fn parse_raw_season_entries(doc: &JsonApiDoc) -> Vec<RawSeasonEntry> {
    let index = resource_index(&doc.included);
    doc.data
        .iter()
        .map(|resource| {
            let tier = rel_target(&resource.relationships, "leagueSeasonDivisionSubdivision")
                .and_then(|key| index.get(&key))
                .and_then(|subdivision| resolve_tier(subdivision, &index));
            RawSeasonEntry {
                player_id: i32_attr(resource, "loginId").unwrap_or_default(),
                score: i32_attr(resource, "score").unwrap_or_default(),
                games_played: i32_attr(resource, "gameCount").unwrap_or_default(),
                returning_player: bool_attr(resource, "returningPlayer").unwrap_or(false),
                tier,
            }
        })
        .collect()
}

fn build_season_entries(
    raw: Vec<RawSeasonEntry>,
    names: &HashMap<i32, String>,
) -> Vec<LeaderboardEntry> {
    let mut entries: Vec<_> = raw
        .into_iter()
        .map(|entry| LeaderboardEntry {
            player_id: entry.player_id,
            rank: 0,
            player_name: names
                .get(&entry.player_id)
                .cloned()
                .unwrap_or_else(|| "unknown".into()),
            avatar_url: None,
            score: Some(entry.score),
            rating: None,
            mean: None,
            deviation: None,
            games_played: entry.games_played,
            won_games: None,
            update_time: None,
            division: entry.tier.as_ref().map(|tier| tier.name.clone()),
            division_order: entry.tier.as_ref().map(|tier| tier.division_order),
            highest_score: entry.tier.as_ref().map(|tier| tier.highest_score),
            division_image_url: entry.tier.and_then(|tier| tier.image_url),
            returning_player: Some(entry.returning_player),
        })
        .collect();
    entries.sort_by(|left, right| {
        right
            .division_order
            .unwrap_or(-1)
            .cmp(&left.division_order.unwrap_or(-1))
            .then_with(|| {
                right
                    .score
                    .unwrap_or_default()
                    .cmp(&left.score.unwrap_or_default())
            })
    });
    for (index, entry) in entries.iter_mut().enumerate() {
        entry.rank = index as i32 + 1;
    }
    entries
}

fn escape_filter_value(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn unique_ids(ids: &[i32]) -> Vec<i32> {
    let mut ids = ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    ids
}

fn csv_ids(ids: &[i32]) -> String {
    ids.iter().map(i32::to_string).collect::<Vec<_>>().join(",")
}

#[derive(Debug, Clone, Default)]
pub struct FakeLeaderboard;

fn fake_entry(player_id: i32, rank: i32, name: &str, rating: i32) -> LeaderboardEntry {
    LeaderboardEntry {
        player_id,
        rank,
        player_name: name.into(),
        avatar_url: None,
        score: None,
        rating: Some(rating),
        mean: Some(rating as f64 + 500.0),
        deviation: Some(500.0),
        games_played: 180 - rank * 7,
        won_games: Some(95 - rank * 3),
        update_time: Some("2026-08-01T12:00:00Z".into()),
        division: None,
        division_order: None,
        highest_score: None,
        division_image_url: None,
        returning_player: None,
    }
}

#[async_trait]
impl LeaderboardPort for FakeLeaderboard {
    async fn list_rating_leaderboards(&self) -> Result<Vec<RatingLeaderboard>, String> {
        Ok(vec![
            RatingLeaderboard {
                id: 1,
                technical_name: "global".into(),
                name: "Global".into(),
                description: "All ranked games".into(),
            },
            RatingLeaderboard {
                id: 2,
                technical_name: "ladder_1v1".into(),
                name: "1v1 Ladder".into(),
                description: "Ranked one versus one".into(),
            },
            RatingLeaderboard {
                id: 3,
                technical_name: "tmm_2v2".into(),
                name: "2v2".into(),
                description: "Team matchmaker".into(),
            },
        ])
    }

    async fn list_leagues(&self) -> Result<Vec<League>, String> {
        Ok(vec![League {
            id: 1,
            technical_name: "ladder_1v1".into(),
            name: "1v1 Ladder".into(),
            description: "Seasonal competitive ladder".into(),
        }])
    }

    async fn list_ratings(&self, query: &RatingQuery) -> Result<RatingPage, String> {
        let names = [
            "TestPlayer",
            "Jip",
            "Voodoo",
            "Techno",
            "Nomander",
            "Deribus",
        ];
        let entries = names
            .iter()
            .enumerate()
            .map(|(index, name)| {
                fake_entry(
                    index as i32 + 1,
                    index as i32 + 1,
                    name,
                    2100 - index as i32 * 95,
                )
            })
            .collect();
        Ok(RatingPage {
            entries,
            page: query.page,
            page_size: query.page_size,
            total_pages: 1,
            total_results: Some(names.len() as i32),
        })
    }

    async fn list_seasons(&self, league_id: i32) -> Result<Vec<LeagueSeason>, String> {
        Ok(vec![LeagueSeason {
            id: 10,
            league_id,
            leaderboard_id: 2,
            season_number: 12,
            name: "Season 12".into(),
            start_date: "2026-07-01T00:00:00Z".into(),
            end_date: "2026-09-30T23:59:59Z".into(),
            placement_games: 10,
            placement_games_returning_player: 5,
            active: true,
        }])
    }

    async fn list_season_leaderboard(&self, _season_id: i32) -> Result<SeasonLeaderboard, String> {
        let tiers = vec![
            LeaderboardTier {
                name: "Silver III".into(),
                division: "Silver".into(),
                subdivision: "III".into(),
                division_order: 2003,
                highest_score: 1000,
                image_url: None,
            },
            LeaderboardTier {
                name: "Gold I".into(),
                division: "Gold".into(),
                subdivision: "I".into(),
                division_order: 3001,
                highest_score: 1600,
                image_url: None,
            },
        ];
        let mut entries = vec![
            fake_entry(1, 1, "TestPlayer", 2050),
            fake_entry(2, 2, "Jip", 1920),
            fake_entry(3, 3, "Voodoo", 1810),
        ];
        for (index, entry) in entries.iter_mut().enumerate() {
            entry.score = Some(1500 - index as i32 * 170);
            let tier = if index == 2 { &tiers[0] } else { &tiers[1] };
            entry.division = Some(tier.name.clone());
            entry.division_order = Some(tier.division_order);
            entry.highest_score = Some(tier.highest_score);
            entry.returning_player = Some(false);
        }
        Ok(SeasonLeaderboard { entries, tiers })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_all_python_style_rating_statistics() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [{
                "type": "leaderboardRating",
                "id": "1",
                "attributes": {
                    "rating": 1600.9,
                    "mean": 2100.25,
                    "deviation": 499.35,
                    "totalGames": 90,
                    "wonGames": 54,
                    "updateTime": "2026-08-01T12:00:00Z"
                },
                "relationships": { "player": { "data": { "type": "player", "id": "501" } } }
            }],
            "included": [
                {
                    "type": "player", "id": "501",
                    "attributes": { "login": "Nomander" },
                    "relationships": {
                        "avatarAssignments": { "data": [{ "type": "avatarAssignment", "id": "9001" }] }
                    }
                },
                {
                    "type": "avatarAssignment", "id": "9001",
                    "attributes": { "selected": true },
                    "relationships": { "avatar": { "data": { "type": "avatar", "id": "7001" } } }
                },
                {
                    "type": "avatar", "id": "7001",
                    "attributes": { "url": "https://content.example/avatar.png" }
                }
            ],
            "meta": { "page": { "number": 2, "limit": 100, "totalPages": 4, "totalRecords": 340 } }
        }))
        .unwrap();
        let query = RatingQuery {
            page: 2,
            ..RatingQuery::default()
        };
        let page = parse_rating_page(&doc, &query);
        assert_eq!(page.entries[0].rank, 101);
        assert_eq!(page.entries[0].player_id, 501);
        assert_eq!(
            page.entries[0].avatar_url.as_deref(),
            Some("https://content.example/avatar.png")
        );
        assert_eq!(page.entries[0].rating, Some(1601));
        assert_eq!(page.entries[0].mean, Some(2100.25));
        assert_eq!(page.entries[0].won_games, Some(54));
        assert_eq!(page.total_pages, 4);
        assert_eq!(page.total_results, Some(340));
    }

    #[test]
    fn localization_keys_are_not_presented_as_descriptions() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [{
                "type": "leaderboard", "id": "1",
                "attributes": {
                    "technicalName": "global",
                    "nameKey": "leaderboard.global.name",
                    "descriptionKey": "leaderboard.global.description"
                }
            }, {
                "type": "leaderboard", "id": "2",
                "attributes": {
                    "technicalName": "community_queue",
                    "nameKey": "Community Queue",
                    "description": "A directly supplied explanation."
                }
            }]
        }))
        .unwrap();

        let parsed = parse_rating_leaderboards(&doc);
        assert_eq!(parsed[0].description, "");
        assert_eq!(parsed[1].description, "A directly supplied explanation.");
    }

    #[test]
    fn parses_season_metadata_and_tiers() {
        let seasons: JsonApiDoc = serde_json::from_value(json!({
            "data": [{
                "type": "leagueSeason", "id": "7",
                "attributes": { "seasonNumber": 3, "startDate": "2020-01-01T00:00:00Z", "endDate": "2030-01-01T00:00:00Z", "placementGames": 10, "placementGamesReturningPlayer": 5 },
                "relationships": {
                    "league": { "data": { "type": "league", "id": "2" } },
                    "leaderboard": { "data": { "type": "leagueLeaderboard", "id": "9" } }
                }
            }]
        })).unwrap();
        let parsed = parse_seasons(&seasons);
        assert_eq!(parsed[0].season_number, 3);
        assert_eq!(parsed[0].leaderboard_id, 9);

        let tiers: JsonApiDoc = serde_json::from_value(json!({
            "data": [{
                "type": "leagueSeasonDivisionSubdivision", "id": "5",
                "attributes": { "nameKey": "III", "subdivisionIndex": 3, "highestScore": 1200, "smallImageUrl": "https://example.invalid/bronze.png" },
                "relationships": { "leagueSeasonDivision": { "data": { "type": "leagueSeasonDivision", "id": "4" } } }
            }],
            "included": [{ "type": "leagueSeasonDivision", "id": "4", "attributes": { "nameKey": "Bronze", "divisionIndex": 1 } }]
        })).unwrap();
        let parsed = parse_tiers(&tiers);
        assert_eq!(parsed[0].name, "Bronze III");
        assert_eq!(parsed[0].division_order, 1003);
        assert_eq!(parsed[0].highest_score, 1200);
    }

    #[test]
    fn season_rank_respects_division_before_score() {
        let raw = vec![
            RawSeasonEntry {
                player_id: 1,
                score: 1500,
                games_played: 10,
                returning_player: false,
                tier: Some(LeaderboardTier {
                    name: "Silver I".into(),
                    division: "Silver".into(),
                    subdivision: "I".into(),
                    division_order: 2001,
                    highest_score: 1600,
                    image_url: None,
                }),
            },
            RawSeasonEntry {
                player_id: 2,
                score: 900,
                games_played: 10,
                returning_player: false,
                tier: Some(LeaderboardTier {
                    name: "Gold III".into(),
                    division: "Gold".into(),
                    subdivision: "III".into(),
                    division_order: 3003,
                    highest_score: 1000,
                    image_url: None,
                }),
            },
        ];
        let names = HashMap::from([(1, "Silver".into()), (2, "Gold".into())]);
        let entries = build_season_entries(raw, &names);
        assert_eq!(entries[0].player_name, "Gold");
        assert_eq!(entries[0].rank, 1);
    }

    #[test]
    fn filter_values_are_escaped() {
        assert_eq!(escape_filter_value("a\\\"b"), "a\\\\\\\"b");
    }
}
