//! FAF Data API implementation of the combined Python/Java player profile.

use std::collections::HashMap;

use async_trait::async_trait;
use faf_domain::state::{
    ClanMember, MatchmakerPlayerProfile, PlayerAchievement, PlayerAchievementState, PlayerAvatar,
    PlayerCardProfile, PlayerClan, PlayerEventCount, PlayerLeaguePlacement, PlayerNameRecord,
    PlayerRatingSummary, RatingHistoryPage, RatingHistoryPeriod, RatingHistoryPoint,
    RatingHistoryQuery,
};
use serde_json::Value;

use crate::infra::env_or;
use crate::infra::jsonapi::{
    document_index as index, fetch_document, rel_many, rel_one, JsonApiDoc,
    JsonApiResource as Resource, ResourceIndex as Index,
};
use crate::ports::PlayerCardPort;

const MAX_PAGE_SIZE: usize = 10_000;

#[derive(Debug, Clone)]
pub struct PlayerCardConfig {
    pub api_base: String,
}

impl PlayerCardConfig {
    pub fn faf() -> Self {
        Self {
            api_base: env_or("FAF_API_BASE", "https://api.faforever.com"),
        }
    }
}

pub struct PlayerCardClient {
    config: PlayerCardConfig,
    tokens: crate::infra::session::TokenStore,
    http: reqwest::Client,
}

impl PlayerCardClient {
    pub fn new(config: PlayerCardConfig, tokens: crate::infra::session::TokenStore) -> Self {
        Self {
            config,
            tokens,
            http: super::http::shared_http_client(),
        }
    }

    pub fn faf(tokens: crate::infra::session::TokenStore) -> Self {
        Self::new(PlayerCardConfig::faf(), tokens)
    }

    fn token(&self) -> Result<String, String> {
        self.tokens.get().ok_or_else(|| "not logged in".to_string())
    }

    fn url(&self, resource: &str) -> Result<url::Url, String> {
        url::Url::parse(&format!("{}/data/{resource}", self.config.api_base))
            .map_err(|error| format!("invalid API base: {error}"))
    }

    async fn get(&self, url: url::Url, token: &str) -> Result<JsonApiDoc, String> {
        fetch_document(&self.http, url, token).await
    }

    async fn profile_document(
        &self,
        player_id: Option<i32>,
        login: &str,
        token: &str,
    ) -> Result<JsonApiDoc, String> {
        let filter = player_id.map_or_else(
            || format!("login==\"{}\"", escape(login.trim())),
            |id| format!("id=={id}"),
        );
        let mut url = self.url("player")?;
        url.query_pairs_mut()
            .append_pair("filter", &filter)
            .append_pair(
                "include",
                "avatarAssignments.avatar,names,clanMembership.clan.memberships.player,clanMembership.clan.leader,clanMembership.clan.founder",
            )
            .append_pair("page[size]", "1");
        self.get(url, token).await
    }

    async fn matchmaker_profile_document(
        &self,
        player_id: i32,
        login: &str,
        token: &str,
    ) -> Result<JsonApiDoc, String> {
        let filter = if player_id > 0 {
            format!("id=={player_id}")
        } else {
            format!("login==\"{}\"", escape(login.trim()))
        };
        let mut url = self.url("player")?;
        url.query_pairs_mut()
            .append_pair("filter", &filter)
            .append_pair("include", "avatarAssignments.avatar,clanMembership.clan")
            .append_pair("page[size]", "1");
        self.get(url, token).await
    }

    async fn ratings(&self, player_id: i32, token: &str) -> Result<JsonApiDoc, String> {
        let mut url = self.url("leaderboardRating")?;
        url.query_pairs_mut()
            .append_pair("filter", &format!("player.id=={player_id}"))
            .append_pair("include", "leaderboard")
            .append_pair("sort", "leaderboard.id")
            .append_pair("page[size]", &MAX_PAGE_SIZE.to_string());
        self.get(url, token).await
    }

    async fn events(&self, player_id: i32, token: &str) -> Result<JsonApiDoc, String> {
        let mut url = self.url("playerEvent")?;
        url.query_pairs_mut()
            .append_pair("filter", &format!("player.id=={player_id}"))
            .append_pair("include", "event")
            .append_pair("page[size]", &MAX_PAGE_SIZE.to_string());
        self.get(url, token).await
    }

    async fn achievement_definitions(&self, token: &str) -> Result<JsonApiDoc, String> {
        let mut url = self.url("achievement")?;
        url.query_pairs_mut()
            .append_pair("sort", "order")
            .append_pair("page[size]", &MAX_PAGE_SIZE.to_string());
        self.get(url, token).await
    }

    async fn player_achievements(&self, player_id: i32, token: &str) -> Result<JsonApiDoc, String> {
        let mut url = self.url("playerAchievement")?;
        url.query_pairs_mut()
            .append_pair("filter", &format!("player.id=={player_id}"))
            .append_pair("include", "achievement")
            .append_pair("sort", "achievement.order")
            .append_pair("page[size]", &MAX_PAGE_SIZE.to_string());
        self.get(url, token).await
    }

    async fn placements(&self, player_id: i32, token: &str) -> Result<JsonApiDoc, String> {
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let mut url = self.url("leagueSeasonScore")?;
        url.query_pairs_mut()
            .append_pair(
                "filter",
                &format!(
                    "(loginId=={player_id};leagueSeason.startDate=le=\"{now}\";leagueSeason.endDate=ge=\"{now}\")"
                ),
            )
            .append_pair(
                "include",
                "leagueSeasonDivisionSubdivision,leagueSeasonDivisionSubdivision.leagueSeasonDivision,leagueSeason,leagueSeason.leaderboard",
            )
            .append_pair("page[size]", &MAX_PAGE_SIZE.to_string());
        self.get(url, token).await
    }
}

#[async_trait]
impl PlayerCardPort for PlayerCardClient {
    async fn load_profile(
        &self,
        player_id: Option<i32>,
        login: &str,
    ) -> Result<PlayerCardProfile, String> {
        let token = self.token()?;
        let identity_doc = self.profile_document(player_id, login, &token).await?;
        let identity = identity_doc
            .data
            .first()
            .ok_or_else(|| format!("player '{}' was not found", login.trim()))?;
        let resolved_id = identity
            .id
            .parse::<i32>()
            .map_err(|_| "player has an invalid id".to_string())?;

        let (ratings, events, definitions, player_achievements, placements) = tokio::join!(
            self.ratings(resolved_id, &token),
            self.events(resolved_id, &token),
            self.achievement_definitions(&token),
            self.player_achievements(resolved_id, &token),
            self.placements(resolved_id, &token),
        );

        let mut warnings = Vec::new();
        let rating_values = section(ratings, "Ratings", &mut warnings);
        let event_values = section(events, "Statistics", &mut warnings);
        let achievement_definitions = section(definitions, "Achievements", &mut warnings);
        let player_achievement_values =
            section(player_achievements, "Achievement progress", &mut warnings);
        let placement_values = section(placements, "League placement", &mut warnings);

        let mut profile = parse_identity(&identity_doc, identity)?;
        profile.ratings = rating_values
            .as_ref()
            .map(parse_ratings)
            .unwrap_or_default();
        profile.events = event_values.as_ref().map(parse_events).unwrap_or_default();
        profile.achievements = achievement_definitions
            .as_ref()
            .map(|definitions| parse_achievements(definitions, player_achievement_values.as_ref()))
            .unwrap_or_default();
        profile.league_placements = placement_values
            .as_ref()
            .map(parse_placements)
            .unwrap_or_default();
        profile.warnings = warnings;
        Ok(profile)
    }

    async fn load_matchmaker_profile(
        &self,
        player_id: i32,
        login: &str,
    ) -> Result<MatchmakerPlayerProfile, String> {
        let token = self.token()?;
        let identity_doc = self
            .matchmaker_profile_document(player_id, login, &token)
            .await?;
        let identity = identity_doc
            .data
            .first()
            .ok_or_else(|| format!("player '{}' was not found", login.trim()))?;
        let resolved_id = identity
            .id
            .parse::<i32>()
            .map_err(|_| "player has an invalid id".to_string())?;
        let (ratings, placements) = tokio::join!(
            self.ratings(resolved_id, &token),
            self.placements(resolved_id, &token),
        );

        let mut warnings = Vec::new();
        let ratings = section(ratings, "Ratings", &mut warnings)
            .as_ref()
            .map(parse_ratings)
            .unwrap_or_default();
        let league_placements = section(placements, "League placement", &mut warnings)
            .as_ref()
            .map(parse_placements)
            .unwrap_or_default();
        let identity = parse_identity(&identity_doc, identity)?;
        let selected_avatar = identity.avatars.iter().find(|avatar| avatar.selected);
        let games_played = ratings
            .iter()
            .find(|rating| rating.technical_name == "global")
            .or_else(|| ratings.iter().max_by_key(|rating| rating.games_played))
            .map(|rating| rating.games_played)
            .unwrap_or_default();

        Ok(MatchmakerPlayerProfile {
            player_id: identity.player_id,
            login: identity.login,
            country: identity.country,
            clan_tag: identity.clan.map(|clan| clan.tag).unwrap_or_default(),
            avatar_url: selected_avatar
                .map(|avatar| avatar.url.clone())
                .unwrap_or_default(),
            avatar_tooltip: selected_avatar
                .map(|avatar| avatar.tooltip.clone())
                .unwrap_or_default(),
            games_played,
            ratings,
            league_placements,
            warnings,
        })
    }

    async fn load_rating_history(
        &self,
        query: &RatingHistoryQuery,
    ) -> Result<RatingHistoryPage, String> {
        let token = self.token()?;
        let base_filters = vec![
            format!("gamePlayerStats.player.id=={}", query.player_id),
            format!("leaderboard.id=={}", query.leaderboard_id),
            "gamePlayerStats.scoreTime=isnull=false".to_string(),
        ];
        let mut filters = base_filters.clone();
        if let Some(since) = period_cutoff(query.period) {
            filters.push(format!("gamePlayerStats.scoreTime=ge=\"{since}\""));
        }
        let mut url = self.url("leaderboardRatingJournal")?;
        url.query_pairs_mut()
            .append_pair("filter", &format!("({})", filters.join(";")))
            .append_pair("include", "gamePlayerStats")
            .append_pair("sort", "-gamePlayerStats.scoreTime")
            .append_pair("page[number]", &query.page.max(1).to_string())
            .append_pair(
                "page[size]",
                &query.page_size.clamp(100, 10_000).to_string(),
            )
            .append_pair("page[totals]", "yes");
        if query.page.max(1) == 1 {
            let mut maximum_url = self.url("leaderboardRatingJournal")?;
            maximum_url
                .query_pairs_mut()
                .append_pair("filter", &format!("({})", base_filters.join(";")))
                .append_pair("include", "gamePlayerStats")
                .append_pair("sort", "-meanAfter")
                .append_pair("page[number]", "1")
                .append_pair("page[size]", "100");
            let (history, maximum) =
                tokio::join!(self.get(url, &token), self.get(maximum_url, &token));
            let mut page = parse_history(&history?, query);
            page.maximum = maximum.ok().and_then(|doc| maximum_history_point(&doc));
            Ok(page)
        } else {
            Ok(parse_history(&self.get(url, &token).await?, query))
        }
    }
}

fn section(
    result: Result<JsonApiDoc, String>,
    label: &str,
    warnings: &mut Vec<String>,
) -> Option<JsonApiDoc> {
    match result {
        Ok(value) => Some(value),
        Err(reason) => {
            warnings.push(format!("{label}: {reason}"));
            None
        }
    }
}

fn related<'a>(resource: &Resource, name: &str, index: &Index<'a>) -> Option<&'a Resource> {
    rel_one(resource, name).and_then(|key| index.get(&key).copied())
}

fn text(resource: &Resource, name: &str) -> String {
    resource
        .attributes
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn integer(resource: &Resource, name: &str) -> i32 {
    resource
        .attributes
        .get(name)
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .unwrap_or_default()
}

fn number(resource: &Resource, name: &str) -> f64 {
    resource
        .attributes
        .get(name)
        .and_then(Value::as_f64)
        .unwrap_or_default()
}

fn boolean(resource: &Resource, name: &str) -> bool {
    resource
        .attributes
        .get(name)
        .and_then(Value::as_bool)
        .unwrap_or_default()
}

fn optional_integer(resource: &Resource, name: &str) -> Option<i32> {
    resource
        .attributes
        .get(name)
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
}

fn optional_number(resource: &Resource, name: &str) -> Option<f64> {
    resource.attributes.get(name).and_then(Value::as_f64)
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

fn pretty_board(technical_name: &str, fallback: &str) -> String {
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

fn parse_identity(doc: &JsonApiDoc, player: &Resource) -> Result<PlayerCardProfile, String> {
    let index = index(doc);
    let player_id = player
        .id
        .parse()
        .map_err(|_| "player has an invalid id".to_string())?;
    let avatars = rel_many(player, "avatarAssignments")
        .into_iter()
        .filter_map(|key| index.get(&key).copied())
        .filter_map(|assignment| {
            let avatar = related(assignment, "avatar", &index)?;
            Some(PlayerAvatar {
                url: text(avatar, "url"),
                tooltip: text(avatar, "tooltip"),
                selected: boolean(assignment, "selected"),
                expires_at: assignment
                    .attributes
                    .get("expiresAt")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect();
    let mut names: Vec<_> = rel_many(player, "names")
        .into_iter()
        .filter_map(|key| index.get(&key).copied())
        .map(|record| PlayerNameRecord {
            name: text(record, "name"),
            change_time: text(record, "changeTime"),
        })
        .collect();
    names.sort_by(|left, right| right.change_time.cmp(&left.change_time));

    Ok(PlayerCardProfile {
        player_id,
        login: text(player, "login"),
        country: text(player, "country"),
        registered_at: text(player, "createTime"),
        last_seen_at: text(player, "updateTime"),
        user_agent: text(player, "userAgent"),
        avatars,
        names,
        clan: parse_clan(player, &index),
        ratings: Vec::new(),
        league_placements: Vec::new(),
        events: Vec::new(),
        achievements: Vec::new(),
        warnings: Vec::new(),
    })
}

fn parse_clan(player: &Resource, index: &Index<'_>) -> Option<PlayerClan> {
    let membership = related(player, "clanMembership", index)?;
    let clan = related(membership, "clan", index)?;
    let player_name = |name: &str| {
        related(clan, name, index)
            .map(|resource| text(resource, "login"))
            .unwrap_or_default()
    };
    let mut members: Vec<_> = rel_many(clan, "memberships")
        .into_iter()
        .filter_map(|key| index.get(&key).copied())
        .filter_map(|member| {
            let account = related(member, "player", index)?;
            Some(ClanMember {
                player_id: account.id.parse().ok()?,
                login: text(account, "login"),
                joined_at: text(member, "createTime"),
                account_created_at: text(account, "createTime"),
                last_seen_at: text(account, "updateTime"),
            })
        })
        .collect();
    members.sort_by(|left, right| left.joined_at.cmp(&right.joined_at));
    Some(PlayerClan {
        id: clan.id.clone(),
        name: text(clan, "name"),
        tag: text(clan, "tag"),
        description: text(clan, "description"),
        website_url: text(clan, "websiteUrl"),
        requires_invitation: boolean(clan, "requiresInvitation"),
        created_at: text(clan, "createTime"),
        joined_at: text(membership, "createTime"),
        leader: player_name("leader"),
        founder: player_name("founder"),
        members,
    })
}

fn parse_ratings(doc: &JsonApiDoc) -> Vec<PlayerRatingSummary> {
    let index = index(doc);
    let mut ratings: Vec<_> = doc
        .data
        .iter()
        .filter_map(|rating| {
            let board = related(rating, "leaderboard", &index)?;
            let technical_name = text(board, "technicalName");
            Some(PlayerRatingSummary {
                leaderboard_id: board.id.parse().ok()?,
                name: pretty_board(&technical_name, &text(board, "nameKey")),
                technical_name,
                rating: number(rating, "rating").round() as i32,
                mean: number(rating, "mean"),
                deviation: number(rating, "deviation"),
                games_played: integer(rating, "totalGames"),
                won_games: integer(rating, "wonGames"),
                update_time: text(rating, "updateTime"),
            })
        })
        .collect();
    ratings.sort_by_key(|rating| std::cmp::Reverse(rating.games_played));
    ratings
}

fn parse_events(doc: &JsonApiDoc) -> Vec<PlayerEventCount> {
    doc.data
        .iter()
        .filter_map(|player_event| {
            let event_id = rel_one(player_event, "event")?.1;
            Some(PlayerEventCount {
                event_id,
                count: integer(player_event, "currentCount"),
            })
        })
        .collect()
}

fn parse_achievements(
    definitions: &JsonApiDoc,
    progress: Option<&JsonApiDoc>,
) -> Vec<PlayerAchievement> {
    let progress_index: HashMap<String, &Resource> = progress
        .into_iter()
        .flat_map(|doc| doc.data.iter())
        .filter_map(|item| Some((rel_one(item, "achievement")?.1, item)))
        .collect();
    let mut achievements: Vec<_> = definitions
        .data
        .iter()
        .map(|definition| {
            let player_value = progress_index.get(&definition.id).copied();
            PlayerAchievement {
                id: definition.id.clone(),
                name: text(definition, "name"),
                description: text(definition, "description"),
                experience_points: integer(definition, "experiencePoints"),
                incremental: text(definition, "type") == "INCREMENTAL",
                total_steps: optional_integer(definition, "totalSteps"),
                current_steps: player_value
                    .map(|item| integer(item, "currentSteps"))
                    .unwrap_or_default(),
                state: if player_value.is_some_and(|item| text(item, "state") == "UNLOCKED") {
                    PlayerAchievementState::Unlocked
                } else {
                    PlayerAchievementState::Locked
                },
                revealed_icon_url: text(definition, "revealedIconUrl"),
                unlocked_icon_url: text(definition, "unlockedIconUrl"),
                unlockers_count: optional_integer(definition, "unlockersCount"),
                unlockers_percent: optional_number(definition, "unlockersPercent"),
                updated_at: player_value
                    .map(|item| text(item, "updateTime"))
                    .unwrap_or_default(),
                order: integer(definition, "order"),
            }
        })
        .collect();
    achievements.sort_by_key(|achievement| achievement.order);
    achievements
}

fn parse_placements(doc: &JsonApiDoc) -> Vec<PlayerLeaguePlacement> {
    let index = index(doc);
    let mut placements: Vec<_> = doc
        .data
        .iter()
        .filter_map(|score| {
            let season = related(score, "leagueSeason", &index)?;
            let board = related(season, "leaderboard", &index)?;
            let subdivision = related(score, "leagueSeasonDivisionSubdivision", &index)?;
            let division = related(subdivision, "leagueSeasonDivision", &index)?;
            let technical_name = text(board, "technicalName");
            let order = integer(division, "divisionIndex") * 1_000
                + integer(subdivision, "subdivisionIndex");
            Some((
                order,
                PlayerLeaguePlacement {
                    leaderboard: pretty_board(&technical_name, &text(board, "nameKey")),
                    season: display_key(&text(season, "nameKey")),
                    division: format!(
                        "{} {}",
                        display_key(&text(division, "nameKey")),
                        display_key(&text(subdivision, "nameKey"))
                    )
                    .trim()
                    .to_string(),
                    score: integer(score, "score"),
                    games_played: integer(score, "gameCount"),
                    image_url: {
                        let medium = text(subdivision, "mediumImageUrl");
                        if medium.is_empty() {
                            text(subdivision, "imageUrl")
                        } else {
                            medium
                        }
                    },
                },
            ))
        })
        .collect();
    // Java chooses the greatest division index and then greatest subdivision
    // index for the compact Matchmaker identity. Keep that item first while
    // retaining the complete placement list for the full profile.
    placements.sort_by_key(|(order, _)| std::cmp::Reverse(*order));
    placements
        .into_iter()
        .map(|(_, placement)| placement)
        .collect()
}

fn parse_history(doc: &JsonApiDoc, query: &RatingHistoryQuery) -> RatingHistoryPage {
    let index = index(doc);
    let mut points: Vec<_> = doc
        .data
        .iter()
        .filter_map(|journal| {
            let stats = related(journal, "gamePlayerStats", &index)?;
            let mean = number(journal, "meanAfter");
            let deviation = number(journal, "deviationAfter");
            Some(RatingHistoryPoint {
                timestamp: text(stats, "scoreTime"),
                rating: mean - 3.0 * deviation,
                mean,
                deviation,
            })
        })
        .filter(|point| !point.timestamp.is_empty())
        .collect();
    points.sort_by(|left, right| left.timestamp.cmp(&right.timestamp));
    RatingHistoryPage {
        points,
        maximum: None,
        page: meta_page(&doc.meta, "number").unwrap_or(query.page.max(1)),
        total_pages: meta_page(&doc.meta, "totalPages").unwrap_or(1).max(1),
    }
}

fn maximum_history_point(doc: &JsonApiDoc) -> Option<RatingHistoryPoint> {
    parse_history(
        doc,
        &RatingHistoryQuery {
            player_id: 0,
            leaderboard_id: 0,
            leaderboard: String::new(),
            period: RatingHistoryPeriod::All,
            page: 1,
            page_size: 100,
        },
    )
    .points
    .into_iter()
    .max_by(|left, right| left.rating.total_cmp(&right.rating))
}

fn meta_page(meta: &Value, field: &str) -> Option<i32> {
    meta.get("page")?
        .get(field)?
        .as_i64()
        .and_then(|value| i32::try_from(value).ok())
}

fn period_cutoff(period: RatingHistoryPeriod) -> Option<String> {
    let now = chrono::Utc::now();
    let cutoff = match period {
        RatingHistoryPeriod::Day => now - chrono::Duration::days(1),
        RatingHistoryPeriod::Week => now - chrono::Duration::weeks(1),
        RatingHistoryPeriod::Month => now - chrono::Duration::days(30),
        RatingHistoryPeriod::Year => now - chrono::Duration::days(365),
        RatingHistoryPeriod::All => return None,
    };
    Some(cutoff.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

fn escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[derive(Debug, Clone, Default)]
pub struct FakePlayerCard;

#[async_trait]
impl PlayerCardPort for FakePlayerCard {
    async fn load_profile(
        &self,
        player_id: Option<i32>,
        login: &str,
    ) -> Result<PlayerCardProfile, String> {
        let player_id = player_id.unwrap_or(1);
        let login = if login.trim().is_empty() {
            "TestPlayer"
        } else {
            login.trim()
        };
        Ok(PlayerCardProfile {
            player_id,
            login: login.into(),
            country: "de".into(),
            registered_at: "2017-04-12T14:20:00Z".into(),
            last_seen_at: "2026-08-05T12:00:00Z".into(),
            user_agent: "Forged Alliance Forever".into(),
            avatars: vec![PlayerAvatar {
                url: String::new(),
                tooltip: "Tournament participant".into(),
                selected: true,
                expires_at: None,
            }],
            names: vec![PlayerNameRecord {
                name: "OldCommander".into(),
                change_time: "2024-05-10T18:00:00Z".into(),
            }],
            clan: None,
            ratings: vec![
                PlayerRatingSummary {
                    leaderboard_id: 1,
                    technical_name: "global".into(),
                    name: "Global".into(),
                    rating: 1842,
                    mean: 2260.0,
                    deviation: 139.3,
                    games_played: 842,
                    won_games: 456,
                    update_time: "2026-08-05T12:00:00Z".into(),
                },
                PlayerRatingSummary {
                    leaderboard_id: 2,
                    technical_name: "ladder_1v1".into(),
                    name: "1v1 Ladder".into(),
                    rating: 1710,
                    mean: 2120.0,
                    deviation: 136.7,
                    games_played: 318,
                    won_games: 170,
                    update_time: "2026-08-04T12:00:00Z".into(),
                },
            ],
            league_placements: vec![PlayerLeaguePlacement {
                leaderboard: "1v1 Ladder".into(),
                season: "Season 12".into(),
                division: "Diamond II".into(),
                score: 1470,
                games_played: 38,
                image_url: String::new(),
            }],
            events: fake_events(),
            achievements: vec![
                PlayerAchievement {
                    id: "first-win".into(),
                    name: "First Victory".into(),
                    description: "Win your first ranked game".into(),
                    experience_points: 10,
                    incremental: false,
                    total_steps: None,
                    current_steps: 1,
                    state: PlayerAchievementState::Unlocked,
                    revealed_icon_url: String::new(),
                    unlocked_icon_url: String::new(),
                    unlockers_count: Some(40_000),
                    unlockers_percent: Some(61.0),
                    updated_at: "2025-01-02T10:00:00Z".into(),
                    order: 1,
                },
                PlayerAchievement {
                    id: "veteran".into(),
                    name: "Veteran".into(),
                    description: "Play 1,000 games".into(),
                    experience_points: 100,
                    incremental: true,
                    total_steps: Some(1000),
                    current_steps: 842,
                    state: PlayerAchievementState::Locked,
                    revealed_icon_url: String::new(),
                    unlocked_icon_url: String::new(),
                    unlockers_count: Some(1200),
                    unlockers_percent: Some(1.8),
                    updated_at: "2026-08-05T12:00:00Z".into(),
                    order: 2,
                },
            ],
            warnings: Vec::new(),
        })
    }

    async fn load_matchmaker_profile(
        &self,
        player_id: i32,
        login: &str,
    ) -> Result<MatchmakerPlayerProfile, String> {
        let profile = self.load_profile(Some(player_id), login).await?;
        let selected_avatar = profile.avatars.iter().find(|avatar| avatar.selected);
        Ok(MatchmakerPlayerProfile {
            player_id: profile.player_id,
            login: profile.login,
            country: profile.country,
            clan_tag: profile.clan.map(|clan| clan.tag).unwrap_or_default(),
            avatar_url: selected_avatar
                .map(|avatar| avatar.url.clone())
                .unwrap_or_default(),
            avatar_tooltip: selected_avatar
                .map(|avatar| avatar.tooltip.clone())
                .unwrap_or_default(),
            games_played: profile
                .ratings
                .iter()
                .find(|rating| rating.technical_name == "global")
                .map(|rating| rating.games_played)
                .unwrap_or_default(),
            ratings: profile.ratings,
            league_placements: profile.league_placements,
            warnings: profile.warnings,
        })
    }

    async fn load_rating_history(
        &self,
        query: &RatingHistoryQuery,
    ) -> Result<RatingHistoryPage, String> {
        let points = (0..60)
            .map(|index| {
                let mean = 1800.0 + index as f64 * 8.0 + (index % 7) as f64 * 14.0;
                let deviation = 180.0 - (index as f64 * 0.8).min(70.0);
                RatingHistoryPoint {
                    timestamp: format!(
                        "2026-{:02}-{:02}T12:00:00Z",
                        index / 28 + 5,
                        index % 28 + 1
                    ),
                    rating: mean - 3.0 * deviation,
                    mean,
                    deviation,
                }
            })
            .collect();
        Ok(RatingHistoryPage {
            points,
            maximum: None,
            page: query.page,
            total_pages: 1,
        })
    }
}

fn fake_events() -> Vec<PlayerEventCount> {
    [
        ("96ccc66a-c5a0-4f48-acaa-888b00778b57", 220),
        ("a6b51c26-64e6-4e7a-bda7-ea1cfe771ebb", 118),
        ("ad193982-e7ca-465c-80b0-5493f9739559", 180),
        ("56b06197-1890-42d0-8b59-25e1add8dc9a", 91),
        ("1b900d26-90d2-43d0-a64e-ed90b74c3704", 300),
        ("7be6fdc5-7867-4467-98ce-f7244a66625a", 167),
        ("fefcb392-848f-4836-9683-300b283bc308", 142),
        ("15b6c19a-6084-4e82-ada9-6c30e282191f", 80),
        ("3ebb0c4d-5e92-4446-bf52-d17ba9c5cd3c", 22000),
        ("225e9b2e-ae09-4ae1-a198-eca8780b0fcd", 9000),
        ("ea123d7f-bb2e-4a71-bd31-88859f0c3c00", 46000),
        ("a1a3fd33-abe2-4e56-800a-b72f4c925825", 18000),
        ("b5265b42-1747-4ba1-936c-292202637ce6", 7000),
        ("3a7b3667-0f79-4ac7-be63-ba841fd5ef05", 2800),
        ("ed9fd79d-5ec7-4243-9ccf-f18c4f5baef1", 210),
        ("701ca426-0943-4931-85af-6a08d36d9aaa", 84),
    ]
    .into_iter()
    .map(|(event_id, count)| PlayerEventCount {
        event_id: event_id.into(),
        count,
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rating_history_uses_conservative_displayed_rating() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [{
                "type": "leaderboardRatingJournal", "id": "1",
                "attributes": { "meanAfter": 2000.0, "deviationAfter": 200.0 },
                "relationships": { "gamePlayerStats": { "data": { "type": "gamePlayerStats", "id": "7" } } }
            }],
            "included": [{ "type": "gamePlayerStats", "id": "7", "attributes": { "scoreTime": "2026-01-01T00:00:00Z" } }],
            "meta": { "page": { "number": 1, "totalPages": 2 } }
        })).unwrap();
        let query = RatingHistoryQuery {
            player_id: 1,
            leaderboard_id: 1,
            leaderboard: "global".into(),
            period: RatingHistoryPeriod::All,
            page: 1,
            page_size: 1000,
        };
        let page = parse_history(&doc, &query);
        assert_eq!(page.points[0].rating, 1400.0);
        assert_eq!(page.total_pages, 2);
    }

    #[test]
    fn maximum_history_uses_displayed_rating_not_the_highest_mean_alone() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [
                { "type": "leaderboardRatingJournal", "id": "1", "attributes": { "meanAfter": 2200.0, "deviationAfter": 300.0 }, "relationships": { "gamePlayerStats": { "data": { "type": "gamePlayerStats", "id": "1" } } } },
                { "type": "leaderboardRatingJournal", "id": "2", "attributes": { "meanAfter": 2100.0, "deviationAfter": 100.0 }, "relationships": { "gamePlayerStats": { "data": { "type": "gamePlayerStats", "id": "2" } } } }
            ],
            "included": [
                { "type": "gamePlayerStats", "id": "1", "attributes": { "scoreTime": "2026-01-01T00:00:00Z" } },
                { "type": "gamePlayerStats", "id": "2", "attributes": { "scoreTime": "2026-02-01T00:00:00Z" } }
            ]
        })).unwrap();

        let maximum = maximum_history_point(&doc).expect("a maximum should be found");
        assert_eq!(maximum.rating, 1800.0);
        assert_eq!(maximum.timestamp, "2026-02-01T00:00:00Z");
    }

    #[test]
    fn missing_achievement_progress_becomes_locked() {
        let definitions: JsonApiDoc = serde_json::from_value(json!({
            "data": [{ "type": "achievement", "id": "a", "attributes": { "name": "Veteran", "description": "Play", "experiencePoints": 10, "type": "INCREMENTAL", "totalSteps": 100, "order": 1 } }]
        })).unwrap();
        let parsed = parse_achievements(&definitions, None);
        assert_eq!(parsed[0].state, PlayerAchievementState::Locked);
        assert_eq!(parsed[0].current_steps, 0);
    }

    #[test]
    fn auxiliary_failure_is_non_fatal_and_visible() {
        let mut warnings = Vec::new();
        let result = section(Err("offline".into()), "Statistics", &mut warnings);
        assert!(result.is_none());
        assert_eq!(warnings, ["Statistics: offline"]);
    }

    #[test]
    fn placements_put_javas_highest_active_division_first() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [
                { "type": "leagueSeasonScore", "id": "1", "attributes": { "score": 900, "gameCount": 8 }, "relationships": {
                    "leagueSeason": { "data": { "type": "leagueSeason", "id": "s" } },
                    "leagueSeasonDivisionSubdivision": { "data": { "type": "leagueSeasonDivisionSubdivision", "id": "low" } }
                }},
                { "type": "leagueSeasonScore", "id": "2", "attributes": { "score": 1200, "gameCount": 12 }, "relationships": {
                    "leagueSeason": { "data": { "type": "leagueSeason", "id": "s" } },
                    "leagueSeasonDivisionSubdivision": { "data": { "type": "leagueSeasonDivisionSubdivision", "id": "high" } }
                }}
            ],
            "included": [
                { "type": "leaderboard", "id": "b", "attributes": { "technicalName": "ladder_1v1" } },
                { "type": "leagueSeason", "id": "s", "attributes": { "nameKey": "season_1" }, "relationships": { "leaderboard": { "data": { "type": "leaderboard", "id": "b" } } } },
                { "type": "leagueSeasonDivision", "id": "bronze", "attributes": { "nameKey": "bronze", "divisionIndex": 1 } },
                { "type": "leagueSeasonDivision", "id": "diamond", "attributes": { "nameKey": "diamond", "divisionIndex": 4 } },
                { "type": "leagueSeasonDivisionSubdivision", "id": "low", "attributes": { "nameKey": "ii", "subdivisionIndex": 2 }, "relationships": { "leagueSeasonDivision": { "data": { "type": "leagueSeasonDivision", "id": "bronze" } } } },
                { "type": "leagueSeasonDivisionSubdivision", "id": "high", "attributes": { "nameKey": "i", "subdivisionIndex": 1 }, "relationships": { "leagueSeasonDivision": { "data": { "type": "leagueSeasonDivision", "id": "diamond" } } } }
            ]
        })).unwrap();

        let placements = parse_placements(&doc);
        assert_eq!(placements[0].division, "Diamond I");
        assert_eq!(placements[1].division, "Bronze Ii");
    }
}
