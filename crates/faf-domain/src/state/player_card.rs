//! Player investigation: the combined Python player-card and Java user-info feature.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PlayerCardStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RatingHistoryPeriod {
    Day,
    Week,
    #[default]
    Month,
    Year,
    All,
}

/// A player as a picker row or a list entry needs them.
///
/// Deliberately much smaller than [`PlayerCardProfile`]: this is what comes
/// back when searching for someone to enter into a tournament, or when
/// resolving a list of names, and both routinely return dozens at a time. The
/// full profile is four requests; this is one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSummary {
    pub id: i32,
    pub login: String,
    /// Empty when the player has no avatar selected.
    pub avatar_url: String,
    pub country: String,
    /// The number a signup post means by "rating". Absent for an account that
    /// has never been rated.
    pub global_rating: Option<i32>,
    pub ladder_rating: Option<i32>,
}

impl PlayerSummary {
    /// The rating to sort and display by, preferring the global one.
    pub fn headline_rating(&self) -> Option<i32> {
        self.global_rating.or(self.ladder_rating)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerAvatar {
    pub url: String,
    pub tooltip: String,
    pub selected: bool,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerNameRecord {
    pub name: String,
    pub change_time: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClanMember {
    pub player_id: i32,
    pub login: String,
    pub joined_at: String,
    pub account_created_at: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerClan {
    pub id: String,
    pub name: String,
    pub tag: String,
    pub description: String,
    pub website_url: String,
    pub requires_invitation: bool,
    pub created_at: String,
    pub joined_at: String,
    pub leader: String,
    pub founder: String,
    pub members: Vec<ClanMember>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerRatingSummary {
    pub leaderboard_id: i32,
    pub technical_name: String,
    pub name: String,
    pub rating: i32,
    pub mean: f64,
    pub deviation: f64,
    pub games_played: i32,
    pub won_games: i32,
    pub update_time: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerLeaguePlacement {
    pub leaderboard: String,
    pub season: String,
    pub division: String,
    pub score: i32,
    pub games_played: i32,
    pub image_url: String,
}

/// The small account projection used while preparing a matchmaker search.
///
/// Unlike [`PlayerCardProfile`], this deliberately omits name history,
/// achievements, event statistics and clan membership details. Opening the
/// Matchmaker tab should not download an entire investigation profile merely
/// to show the signed-in player's identity, ratings and active placement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MatchmakerPlayerProfile {
    pub player_id: i32,
    pub login: String,
    pub country: String,
    pub clan_tag: String,
    pub avatar_url: String,
    pub avatar_tooltip: String,
    pub games_played: i32,
    pub ratings: Vec<PlayerRatingSummary>,
    pub league_placements: Vec<PlayerLeaguePlacement>,
    /// Non-fatal rating or league endpoint failures.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerEventCount {
    pub event_id: String,
    pub count: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PlayerAchievementState {
    Locked,
    Unlocked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerAchievement {
    pub id: String,
    pub name: String,
    pub description: String,
    pub experience_points: i32,
    pub incremental: bool,
    pub total_steps: Option<i32>,
    pub current_steps: i32,
    pub state: PlayerAchievementState,
    pub revealed_icon_url: String,
    pub unlocked_icon_url: String,
    pub unlockers_count: Option<i32>,
    pub unlockers_percent: Option<f64>,
    pub updated_at: String,
    pub order: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerCardProfile {
    pub player_id: i32,
    pub login: String,
    pub country: String,
    pub registered_at: String,
    pub last_seen_at: String,
    pub user_agent: String,
    pub avatars: Vec<PlayerAvatar>,
    pub names: Vec<PlayerNameRecord>,
    pub clan: Option<PlayerClan>,
    pub ratings: Vec<PlayerRatingSummary>,
    pub league_placements: Vec<PlayerLeaguePlacement>,
    pub events: Vec<PlayerEventCount>,
    pub achievements: Vec<PlayerAchievement>,
    /// Non-fatal API section failures. Identity still loads and the UI explains omissions.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RatingHistoryQuery {
    pub player_id: i32,
    pub leaderboard_id: i32,
    pub leaderboard: String,
    pub period: RatingHistoryPeriod,
    pub page: i32,
    pub page_size: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RatingHistoryPoint {
    pub timestamp: String,
    pub rating: f64,
    pub mean: f64,
    pub deviation: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RatingHistoryPage {
    pub points: Vec<RatingHistoryPoint>,
    /// Python-client-compatible all-time maximum, resolved independently of paging.
    pub maximum: Option<RatingHistoryPoint>,
    pub page: i32,
    pub total_pages: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerCardState {
    pub open: bool,
    pub requested_login: String,
    pub profile: Option<PlayerCardProfile>,
    pub profile_status: PlayerCardStatus,
    pub profile_error: String,
    pub history_query: Option<RatingHistoryQuery>,
    pub history: Vec<RatingHistoryPoint>,
    pub history_maximum: Option<RatingHistoryPoint>,
    pub history_page: i32,
    pub history_total_pages: i32,
    pub history_status: PlayerCardStatus,
    pub history_error: String,
    pub matchmaker_profile: Option<MatchmakerPlayerProfile>,
    pub matchmaker_profile_status: PlayerCardStatus,
    pub matchmaker_profile_error: String,
    /// Per-map record, loaded separately from the profile because it scans
    /// the player's whole game history and should not hold up their identity.
    pub map_stats: Option<PlayerMapStats>,
    pub map_stats_status: PlayerCardStatus,
    pub map_stats_error: String,
}

impl Default for PlayerCardState {
    fn default() -> Self {
        Self {
            open: false,
            requested_login: String::new(),
            profile: None,
            profile_status: PlayerCardStatus::default(),
            profile_error: String::new(),
            history_query: None,
            history: Vec::new(),
            history_maximum: None,
            history_page: 0,
            // Not the derived `0`. Every reducer arm that writes this clamps
            // with `.max(1)`, so "zero pages" is a state the code never
            // produces and the pagination UI should not have to render. The
            // frontend's initial state already assumed 1; this makes the two
            // agree at the source rather than by coincidence.
            history_total_pages: 1,
            history_status: PlayerCardStatus::default(),
            history_error: String::new(),
            matchmaker_profile: None,
            matchmaker_profile_status: PlayerCardStatus::default(),
            matchmaker_profile_error: String::new(),
            map_stats: None,
            map_stats_status: PlayerCardStatus::default(),
            map_stats_error: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum PlayerCardCommand {
    #[serde(rename_all = "camelCase")]
    Open {
        player_id: Option<i32>,
        login: String,
    },
    Close,
    #[serde(rename_all = "camelCase")]
    LoadHistory {
        query: RatingHistoryQuery,
        append: bool,
    },
    #[serde(rename_all = "camelCase")]
    LoadAllHistory {
        query: RatingHistoryQuery,
    },
    #[serde(rename_all = "camelCase")]
    LoadMatchmakerProfile {
        player_id: i32,
        login: String,
    },
    /// Scan this player's games and fold them into per-map records.
    #[serde(rename_all = "camelCase")]
    LoadMapStats {
        player_id: i32,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum PlayerCardEvent {
    #[serde(rename_all = "camelCase")]
    Loading {
        login: String,
    },
    #[serde(rename_all = "camelCase")]
    Loaded {
        profile: Box<PlayerCardProfile>,
    },
    #[serde(rename_all = "camelCase")]
    LoadFailed {
        reason: String,
    },
    Closed,
    #[serde(rename_all = "camelCase")]
    HistoryLoading {
        query: RatingHistoryQuery,
        append: bool,
    },
    #[serde(rename_all = "camelCase")]
    HistoryLoaded {
        query: RatingHistoryQuery,
        page: RatingHistoryPage,
        append: bool,
    },
    #[serde(rename_all = "camelCase")]
    HistoryLoadFailed {
        reason: String,
    },
    /// Optimistic confirmation of the authenticated player's lobby avatar
    /// selection. The lobby command has no acknowledgement, so both reference
    /// clients update their own profile immediately after the send succeeds.
    #[serde(rename_all = "camelCase")]
    AvatarSelected {
        player_id: i32,
        url: Option<String>,
        tooltip: String,
    },
    #[serde(rename_all = "camelCase")]
    MatchmakerProfileLoading {
        player_id: i32,
    },
    #[serde(rename_all = "camelCase")]
    MatchmakerProfileLoaded {
        profile: Box<MatchmakerPlayerProfile>,
    },
    #[serde(rename_all = "camelCase")]
    MatchmakerProfileLoadFailed {
        player_id: i32,
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    MapStatsLoading {
        player_id: i32,
    },
    #[serde(rename_all = "camelCase")]
    MapStatsLoaded {
        stats: Box<PlayerMapStats>,
    },
    #[serde(rename_all = "camelCase")]
    MapStatsLoadFailed {
        reason: String,
    },
}

pub fn reduce(state: &mut PlayerCardState, event: &PlayerCardEvent) {
    match event {
        PlayerCardEvent::Loading { login } => {
            state.open = true;
            state.requested_login = login.clone();
            state.profile = None;
            state.profile_status = PlayerCardStatus::Loading;
            state.profile_error.clear();
            state.history_query = None;
            state.history.clear();
            state.history_status = PlayerCardStatus::Idle;
        }
        PlayerCardEvent::Loaded { profile } => {
            state.requested_login = profile.login.clone();
            state.profile = Some((**profile).clone());
            state.profile_status = PlayerCardStatus::Ready;
        }
        PlayerCardEvent::LoadFailed { reason } => {
            state.profile_status = PlayerCardStatus::Failed;
            state.profile_error = reason.clone();
        }
        PlayerCardEvent::Closed => {
            state.open = false;
            state.profile_status = PlayerCardStatus::Idle;
            state.history_status = PlayerCardStatus::Idle;
        }
        PlayerCardEvent::HistoryLoading { query, append } => {
            state.history_query = Some(query.clone());
            state.history_status = PlayerCardStatus::Loading;
            state.history_error.clear();
            if !append {
                state.history.clear();
                state.history_maximum = None;
                state.history_page = 0;
                state.history_total_pages = 1;
            }
        }
        PlayerCardEvent::HistoryLoaded {
            query,
            page,
            append,
        } => {
            state.history_query = Some(query.clone());
            if *append {
                state.history.extend(page.points.clone());
                if page.maximum.is_some() {
                    state.history_maximum = page.maximum.clone();
                }
            } else {
                state.history = page.points.clone();
                state.history_maximum = page.maximum.clone();
            }
            state
                .history
                .sort_by(|left, right| left.timestamp.cmp(&right.timestamp));
            state
                .history
                .dedup_by(|left, right| left.timestamp == right.timestamp);
            state.history_page = page.page;
            state.history_total_pages = page.total_pages.max(1);
            state.history_status = PlayerCardStatus::Ready;
        }
        PlayerCardEvent::HistoryLoadFailed { reason } => {
            state.history_status = PlayerCardStatus::Failed;
            state.history_error = reason.clone();
        }
        PlayerCardEvent::AvatarSelected {
            player_id,
            url,
            tooltip,
        } => {
            if let Some(profile) = state
                .profile
                .as_mut()
                .filter(|profile| profile.player_id == *player_id)
            {
                for avatar in &mut profile.avatars {
                    avatar.selected = url.as_deref() == Some(avatar.url.as_str());
                }
                if let Some(url) = url {
                    if !profile.avatars.iter().any(|avatar| avatar.url == *url) {
                        profile.avatars.push(PlayerAvatar {
                            url: url.clone(),
                            tooltip: tooltip.clone(),
                            selected: true,
                            expires_at: None,
                        });
                    }
                }
            }
            if let Some(profile) = state
                .matchmaker_profile
                .as_mut()
                .filter(|profile| profile.player_id == *player_id)
            {
                profile.avatar_url = url.clone().unwrap_or_default();
                profile.avatar_tooltip = tooltip.clone();
            }
        }
        PlayerCardEvent::MapStatsLoading { player_id: _ } => {
            // Cleared rather than kept: unlike the matchmaker projection,
            // these belong to whichever profile is open, and showing the
            // previous player's maps under a new name would be a lie.
            state.map_stats = None;
            state.map_stats_status = PlayerCardStatus::Loading;
            state.map_stats_error.clear();
        }
        PlayerCardEvent::MapStatsLoaded { stats } => {
            state.map_stats = Some((**stats).clone());
            state.map_stats_status = PlayerCardStatus::Ready;
            state.map_stats_error.clear();
        }
        PlayerCardEvent::MapStatsLoadFailed { reason } => {
            state.map_stats = None;
            state.map_stats_status = PlayerCardStatus::Failed;
            state.map_stats_error = reason.clone();
        }
        PlayerCardEvent::MatchmakerProfileLoading { player_id } => {
            if state
                .matchmaker_profile
                .as_ref()
                .is_some_and(|profile| profile.player_id != *player_id)
            {
                state.matchmaker_profile = None;
            }
            state.matchmaker_profile_status = PlayerCardStatus::Loading;
            state.matchmaker_profile_error.clear();
        }
        PlayerCardEvent::MatchmakerProfileLoaded { profile } => {
            state.matchmaker_profile = Some((**profile).clone());
            state.matchmaker_profile_status = PlayerCardStatus::Ready;
            state.matchmaker_profile_error.clear();
        }
        PlayerCardEvent::MatchmakerProfileLoadFailed { player_id, reason } => {
            if state
                .matchmaker_profile
                .as_ref()
                .is_some_and(|profile| profile.player_id == *player_id)
            {
                // Keep a previously loaded projection visible if a refresh
                // failed. The error remains available for a compact warning.
            } else {
                state.matchmaker_profile = None;
            }
            state.matchmaker_profile_status = PlayerCardStatus::Failed;
            state.matchmaker_profile_error = reason.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_a_different_player_clears_stale_profile_and_history() {
        let mut state = PlayerCardState {
            open: true,
            requested_login: "Old".into(),
            history: vec![RatingHistoryPoint {
                timestamp: "2020-01-01T00:00:00Z".into(),
                rating: 1000.0,
                mean: 1500.0,
                deviation: 166.0,
            }],
            ..PlayerCardState::default()
        };
        reduce(
            &mut state,
            &PlayerCardEvent::Loading {
                login: "New".into(),
            },
        );
        assert!(state.open);
        assert!(state.profile.is_none());
        assert!(state.history.is_empty());
    }

    #[test]
    fn appended_history_is_chronological_and_deduplicated() {
        let query = RatingHistoryQuery {
            player_id: 1,
            leaderboard_id: 2,
            leaderboard: "global".into(),
            period: RatingHistoryPeriod::All,
            page: 2,
            page_size: 1000,
        };
        let point = |timestamp: &str| RatingHistoryPoint {
            timestamp: timestamp.into(),
            rating: 1000.0,
            mean: 1500.0,
            deviation: 166.0,
        };
        let mut state = PlayerCardState {
            history: vec![point("2024-02-01T00:00:00Z")],
            ..PlayerCardState::default()
        };
        reduce(
            &mut state,
            &PlayerCardEvent::HistoryLoaded {
                query,
                page: RatingHistoryPage {
                    points: vec![point("2024-01-01T00:00:00Z"), point("2024-02-01T00:00:00Z")],
                    maximum: None,
                    page: 2,
                    total_pages: 3,
                },
                append: true,
            },
        );
        assert_eq!(state.history.len(), 2);
        assert_eq!(state.history[0].timestamp, "2024-01-01T00:00:00Z");
    }

    #[test]
    fn own_avatar_selection_updates_only_the_matching_open_profile() {
        let mut state = PlayerCardState {
            profile: Some(PlayerCardProfile {
                player_id: 7,
                login: "Ada".into(),
                country: String::new(),
                registered_at: String::new(),
                last_seen_at: String::new(),
                user_agent: String::new(),
                avatars: vec![PlayerAvatar {
                    url: "old".into(),
                    tooltip: "Old".into(),
                    selected: true,
                    expires_at: None,
                }],
                names: Vec::new(),
                clan: None,
                ratings: Vec::new(),
                league_placements: Vec::new(),
                events: Vec::new(),
                achievements: Vec::new(),
                warnings: Vec::new(),
            }),
            ..PlayerCardState::default()
        };

        reduce(
            &mut state,
            &PlayerCardEvent::AvatarSelected {
                player_id: 7,
                url: Some("new".into()),
                tooltip: "New".into(),
            },
        );
        let avatars = &state.profile.as_ref().unwrap().avatars;
        assert!(!avatars[0].selected);
        assert_eq!(avatars[1].url, "new");
        assert!(avatars[1].selected);

        reduce(
            &mut state,
            &PlayerCardEvent::AvatarSelected {
                player_id: 7,
                url: None,
                tooltip: String::new(),
            },
        );
        assert!(state
            .profile
            .as_ref()
            .unwrap()
            .avatars
            .iter()
            .all(|avatar| !avatar.selected));
    }

    #[test]
    fn matchmaker_profile_refresh_keeps_same_player_data_but_not_another_players() {
        let profile = |player_id| MatchmakerPlayerProfile {
            player_id,
            login: format!("Player{player_id}"),
            country: "de".into(),
            clan_tag: String::new(),
            avatar_url: String::new(),
            avatar_tooltip: String::new(),
            games_played: 10,
            ratings: Vec::new(),
            league_placements: Vec::new(),
            warnings: Vec::new(),
        };
        let mut state = PlayerCardState {
            matchmaker_profile: Some(profile(7)),
            matchmaker_profile_status: PlayerCardStatus::Ready,
            ..PlayerCardState::default()
        };

        reduce(
            &mut state,
            &PlayerCardEvent::MatchmakerProfileLoading { player_id: 7 },
        );
        assert_eq!(state.matchmaker_profile.as_ref().unwrap().player_id, 7);
        assert_eq!(state.matchmaker_profile_status, PlayerCardStatus::Loading);

        reduce(
            &mut state,
            &PlayerCardEvent::MatchmakerProfileLoading { player_id: 8 },
        );
        assert!(state.matchmaker_profile.is_none());
        reduce(
            &mut state,
            &PlayerCardEvent::MatchmakerProfileLoaded {
                profile: Box::new(profile(8)),
            },
        );
        assert_eq!(state.matchmaker_profile.as_ref().unwrap().player_id, 8);
        assert_eq!(state.matchmaker_profile_status, PlayerCardStatus::Ready);
    }

    #[test]
    fn avatar_selection_updates_the_cached_matchmaker_identity() {
        let mut state = PlayerCardState {
            matchmaker_profile: Some(MatchmakerPlayerProfile {
                player_id: 7,
                login: "Ada".into(),
                country: String::new(),
                clan_tag: String::new(),
                avatar_url: "old".into(),
                avatar_tooltip: "Old".into(),
                games_played: 0,
                ratings: Vec::new(),
                league_placements: Vec::new(),
                warnings: Vec::new(),
            }),
            ..PlayerCardState::default()
        };

        reduce(
            &mut state,
            &PlayerCardEvent::AvatarSelected {
                player_id: 7,
                url: Some("new".into()),
                tooltip: "New".into(),
            },
        );
        let profile = state.matchmaker_profile.unwrap();
        assert_eq!(profile.avatar_url, "new");
        assert_eq!(profile.avatar_tooltip, "New");
    }
}

/// One game from a player's history, reduced to what map statistics need.
///
/// Produced by the infrastructure from `gamePlayerStats` rows and folded by
/// [`aggregate_map_stats`]. A separate type so the folding is testable without
/// a JSON:API document in the way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayedGame {
    pub map: String,
    /// `false` for a draw, an unfinished game, or a result the API did not state.
    pub decided: bool,
    pub won: bool,
    /// ISO timestamp, or empty when the API did not state one.
    pub played_at: String,
}

/// A player's record on one map.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerMapStat {
    pub map: String,
    pub games: i32,
    pub wins: i32,
    pub losses: i32,
    /// Most recent appearance, ISO. Empty when no game on this map stated one.
    pub last_played: String,
}

/// How often a player has played, and on what.
///
/// Deliberately narrow. The profile already reports games and wins **per
/// leaderboard** (from `PlayerRatingSummary`) and plays and wins **per faction**
/// (from the achievement events), so neither is repeated here. What was missing,
/// and what this exists for, is the per-map picture a host wants when judging
/// whether a rating means much on the map they are about to host.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerMapStats {
    /// Games actually counted, which is every game the scan returned.
    pub total_games: i32,
    pub wins: i32,
    pub losses: i32,
    /// Games the API returned without a decided result (draws, unfinished).
    pub undecided: i32,
    /// Every map played, most played first.
    pub maps: Vec<PlayerMapStat>,
    /// Set when the scan hit its safety limit, so the view can say the numbers
    /// cover a prefix of the history rather than all of it.
    pub truncated: bool,
}

/// Fold a player's games into per-map records, most played first.
///
/// Ties break on the map name so the order is stable between two loads of the
/// same profile; without that, two maps with equal counts could swap places and
/// look like the data changed.
pub fn aggregate_map_stats(games: &[PlayedGame], truncated: bool) -> PlayerMapStats {
    let mut by_map: BTreeMap<String, PlayerMapStat> = BTreeMap::new();
    let mut stats = PlayerMapStats {
        truncated,
        ..PlayerMapStats::default()
    };

    for game in games {
        stats.total_games += 1;
        match (game.decided, game.won) {
            (true, true) => stats.wins += 1,
            (true, false) => stats.losses += 1,
            (false, _) => stats.undecided += 1,
        }

        // A game whose map the API did not name still counts towards the
        // totals; it simply cannot be attributed to a map.
        if game.map.is_empty() {
            continue;
        }

        let entry = by_map
            .entry(game.map.clone())
            .or_insert_with(|| PlayerMapStat {
                map: game.map.clone(),
                games: 0,
                wins: 0,
                losses: 0,
                last_played: String::new(),
            });
        entry.games += 1;
        if game.decided {
            if game.won {
                entry.wins += 1;
            } else {
                entry.losses += 1;
            }
        }
        if game.played_at > entry.last_played {
            entry.last_played = game.played_at.clone();
        }
    }

    stats.maps = by_map.into_values().collect();
    stats
        .maps
        .sort_by(|a, b| b.games.cmp(&a.games).then_with(|| a.map.cmp(&b.map)));
    stats
}

#[cfg(test)]
mod map_stats_tests {
    use super::*;

    fn game(map: &str, decided: bool, won: bool, played_at: &str) -> PlayedGame {
        PlayedGame {
            map: map.into(),
            decided,
            won,
            played_at: played_at.into(),
        }
    }

    #[test]
    fn maps_are_ordered_by_how_often_they_were_played() {
        let stats = aggregate_map_stats(
            &[
                game("Setons Clutch", true, true, "2026-01-01"),
                game("Dual Gap", true, false, "2026-01-02"),
                game("Setons Clutch", true, false, "2026-01-03"),
                game("Setons Clutch", true, true, "2026-01-04"),
            ],
            false,
        );

        assert_eq!(stats.total_games, 4);
        assert_eq!(stats.wins, 2);
        assert_eq!(stats.losses, 2);
        assert_eq!(
            stats
                .maps
                .iter()
                .map(|m| m.map.as_str())
                .collect::<Vec<_>>(),
            ["Setons Clutch", "Dual Gap"],
            "most played first, which is the question a host is asking"
        );

        let setons = &stats.maps[0];
        assert_eq!((setons.games, setons.wins, setons.losses), (3, 2, 1));
        assert_eq!(
            setons.last_played, "2026-01-04",
            "the newest appearance wins"
        );
    }

    #[test]
    fn equal_counts_keep_a_stable_order() {
        let first = aggregate_map_stats(
            &[game("Beta", true, true, ""), game("Alpha", true, true, "")],
            false,
        );
        let second = aggregate_map_stats(
            &[game("Alpha", true, true, ""), game("Beta", true, true, "")],
            false,
        );
        assert_eq!(first.maps, second.maps, "order must not depend on arrival");
    }

    #[test]
    fn undecided_games_count_towards_the_total_but_not_the_record() {
        let stats = aggregate_map_stats(
            &[
                game("Loki", true, true, "2026-01-01"),
                game("Loki", false, false, "2026-01-02"),
            ],
            false,
        );
        assert_eq!(stats.total_games, 2);
        assert_eq!(stats.wins, 1);
        assert_eq!(stats.losses, 0);
        assert_eq!(stats.undecided, 1);

        let loki = &stats.maps[0];
        assert_eq!(loki.games, 2, "a draw is still a game played there");
        assert_eq!((loki.wins, loki.losses), (1, 0));
    }

    #[test]
    fn a_game_without_a_map_still_counts_towards_the_totals() {
        let stats = aggregate_map_stats(&[game("", true, true, "2026-01-01")], false);
        assert_eq!(stats.total_games, 1);
        assert_eq!(stats.wins, 1);
        assert!(
            stats.maps.is_empty(),
            "but it cannot be attributed to a map"
        );
    }
}
