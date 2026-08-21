//! Leaderboards: FAF's statistical rating boards and competitive leagues.
//!
//! The legacy Python client is the reference for paged rating statistics;
//! the Java client is the reference for seasons, divisions and placement
//! progress. Both are represented in this slice so the frontend remains a
//! projection of authoritative application state.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LeaderboardMode {
    #[default]
    Ratings,
    Leagues,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RatingLeaderboard {
    pub id: i32,
    pub technical_name: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct League {
    pub id: i32,
    pub technical_name: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LeagueSeason {
    pub id: i32,
    pub league_id: i32,
    pub leaderboard_id: i32,
    pub season_number: i32,
    pub name: String,
    pub start_date: String,
    pub end_date: String,
    pub placement_games: i32,
    pub placement_games_returning_player: i32,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardTier {
    pub name: String,
    pub division: String,
    pub subdivision: String,
    pub division_order: i32,
    pub highest_score: i32,
    pub image_url: Option<String>,
    pub medium_image_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardEntry {
    pub player_id: i32,
    pub rank: i32,
    pub player_name: String,
    /// Absolute URL of the player's selected avatar, when one is assigned.
    pub avatar_url: Option<String>,
    pub score: Option<i32>,
    pub rating: Option<i32>,
    pub mean: Option<f64>,
    pub deviation: Option<f64>,
    pub games_played: i32,
    pub won_games: Option<i32>,
    pub update_time: Option<String>,
    pub division: Option<String>,
    pub division_order: Option<i32>,
    pub highest_score: Option<i32>,
    pub division_image_url: Option<String>,
    pub division_medium_image_url: Option<String>,
    pub returning_player: Option<bool>,
}

impl LeaderboardEntry {
    pub fn win_rate(&self) -> Option<f64> {
        self.won_games.map(|wins| {
            if self.games_played == 0 {
                0.0
            } else {
                wins as f64 / self.games_played as f64
            }
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RatingQuery {
    pub leaderboard: String,
    pub page: i32,
    pub page_size: i32,
    pub active_only: bool,
    pub updated_after: Option<String>,
    pub updated_before: Option<String>,
    pub player: String,
}

impl Default for RatingQuery {
    fn default() -> Self {
        Self {
            leaderboard: "global".into(),
            page: 1,
            page_size: 100,
            active_only: true,
            updated_after: None,
            updated_before: None,
            player: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RatingPage {
    pub entries: Vec<LeaderboardEntry>,
    pub page: i32,
    pub page_size: i32,
    pub total_pages: i32,
    pub total_results: Option<i32>,
}

impl Default for RatingPage {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            page: 1,
            page_size: 100,
            total_pages: 1,
            total_results: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SeasonLeaderboard {
    pub entries: Vec<LeaderboardEntry>,
    pub tiers: Vec<LeaderboardTier>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum LeaderboardStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardState {
    pub mode: LeaderboardMode,
    pub rating_leaderboards: Vec<RatingLeaderboard>,
    pub leagues: Vec<League>,
    pub catalog_status: LeaderboardStatus,
    pub rating_query: RatingQuery,
    pub rating_page: RatingPage,
    pub ratings_status: LeaderboardStatus,
    pub selected_league_id: Option<i32>,
    pub seasons: Vec<LeagueSeason>,
    pub seasons_status: LeaderboardStatus,
    pub selected_season_id: Option<i32>,
    pub season_entries: Vec<LeaderboardEntry>,
    pub tiers: Vec<LeaderboardTier>,
    pub season_status: LeaderboardStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum LeaderboardEvent {
    #[serde(rename_all = "camelCase")]
    ModeChanged {
        mode: LeaderboardMode,
    },
    CatalogLoading,
    #[serde(rename_all = "camelCase")]
    CatalogLoaded {
        rating_leaderboards: Vec<RatingLeaderboard>,
        leagues: Vec<League>,
    },
    #[serde(rename_all = "camelCase")]
    CatalogLoadFailed {
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    RatingsLoading {
        query: RatingQuery,
    },
    #[serde(rename_all = "camelCase")]
    RatingsLoaded {
        query: RatingQuery,
        page: RatingPage,
    },
    #[serde(rename_all = "camelCase")]
    RatingsLoadFailed {
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    SeasonsLoading {
        league_id: i32,
    },
    #[serde(rename_all = "camelCase")]
    SeasonsLoaded {
        league_id: i32,
        seasons: Vec<LeagueSeason>,
    },
    #[serde(rename_all = "camelCase")]
    SeasonsLoadFailed {
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    SeasonLoading {
        season_id: i32,
    },
    #[serde(rename_all = "camelCase")]
    SeasonLoaded {
        season_id: i32,
        leaderboard: SeasonLeaderboard,
    },
    #[serde(rename_all = "camelCase")]
    SeasonLoadFailed {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum LeaderboardCommand {
    #[serde(rename_all = "camelCase")]
    SetMode {
        mode: LeaderboardMode,
    },
    LoadCatalog,
    #[serde(rename_all = "camelCase")]
    LoadRatings {
        query: RatingQuery,
    },
    #[serde(rename_all = "camelCase")]
    SelectLeague {
        league_id: i32,
    },
    #[serde(rename_all = "camelCase")]
    SelectSeason {
        season_id: i32,
    },
}

pub fn reduce(state: &mut LeaderboardState, event: &LeaderboardEvent) {
    match event {
        LeaderboardEvent::ModeChanged { mode } => state.mode = *mode,
        LeaderboardEvent::CatalogLoading => state.catalog_status = LeaderboardStatus::Loading,
        LeaderboardEvent::CatalogLoaded {
            rating_leaderboards,
            leagues,
        } => {
            state.rating_leaderboards = rating_leaderboards.clone();
            state.leagues = leagues.clone();
            state.catalog_status = LeaderboardStatus::Ready;
        }
        LeaderboardEvent::CatalogLoadFailed { reason } => {
            state.catalog_status = LeaderboardStatus::Failed {
                reason: reason.clone(),
            };
        }
        LeaderboardEvent::RatingsLoading { query } => {
            state.rating_query = query.clone();
            state.ratings_status = LeaderboardStatus::Loading;
        }
        LeaderboardEvent::RatingsLoaded { query, page } => {
            state.rating_query = query.clone();
            state.rating_page = page.clone();
            state.ratings_status = LeaderboardStatus::Ready;
        }
        LeaderboardEvent::RatingsLoadFailed { reason } => {
            state.ratings_status = LeaderboardStatus::Failed {
                reason: reason.clone(),
            };
        }
        LeaderboardEvent::SeasonsLoading { league_id } => {
            state.selected_league_id = Some(*league_id);
            state.seasons_status = LeaderboardStatus::Loading;
            state.selected_season_id = None;
            state.seasons.clear();
            state.season_entries.clear();
            state.tiers.clear();
        }
        LeaderboardEvent::SeasonsLoaded { league_id, seasons } => {
            state.selected_league_id = Some(*league_id);
            state.seasons = seasons.clone();
            state.seasons_status = LeaderboardStatus::Ready;
        }
        LeaderboardEvent::SeasonsLoadFailed { reason } => {
            state.seasons_status = LeaderboardStatus::Failed {
                reason: reason.clone(),
            };
        }
        LeaderboardEvent::SeasonLoading { season_id } => {
            state.selected_season_id = Some(*season_id);
            state.season_status = LeaderboardStatus::Loading;
        }
        LeaderboardEvent::SeasonLoaded {
            season_id,
            leaderboard,
        } => {
            state.selected_season_id = Some(*season_id);
            state.season_entries = leaderboard.entries.clone();
            state.tiers = leaderboard.tiers.clone();
            state.season_status = LeaderboardStatus::Ready;
        }
        LeaderboardEvent::SeasonLoadFailed { reason } => {
            state.season_status = LeaderboardStatus::Failed {
                reason: reason.clone(),
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rating_query_defaults_match_python_client() {
        let query = RatingQuery::default();
        assert_eq!(query.leaderboard, "global");
        assert_eq!(query.page, 1);
        assert_eq!(query.page_size, 100);
        assert!(query.active_only);
    }

    #[test]
    fn rating_load_keeps_query_and_page_together() {
        let mut state = LeaderboardState::default();
        let query = RatingQuery {
            page: 3,
            ..RatingQuery::default()
        };
        reduce(
            &mut state,
            &LeaderboardEvent::RatingsLoading {
                query: query.clone(),
            },
        );
        assert_eq!(state.rating_query.page, 3);
        reduce(
            &mut state,
            &LeaderboardEvent::RatingsLoaded {
                query,
                page: RatingPage {
                    page: 3,
                    total_pages: 7,
                    ..RatingPage::default()
                },
            },
        );
        assert_eq!(state.rating_page.page, 3);
        assert_eq!(state.rating_page.total_pages, 7);
        assert_eq!(state.ratings_status, LeaderboardStatus::Ready);
    }

    #[test]
    fn changing_league_clears_stale_season_data() {
        let mut state = LeaderboardState {
            selected_season_id: Some(4),
            season_entries: vec![LeaderboardEntry {
                player_id: 1,
                rank: 1,
                player_name: "Commander".into(),
                avatar_url: None,
                score: Some(100),
                rating: Some(1500),
                mean: None,
                deviation: None,
                games_played: 4,
                won_games: None,
                update_time: None,
                division: None,
                division_order: None,
                highest_score: None,
                division_image_url: None,
                division_medium_image_url: None,
                returning_player: None,
            }],
            ..LeaderboardState::default()
        };
        reduce(
            &mut state,
            &LeaderboardEvent::SeasonsLoading { league_id: 8 },
        );
        assert_eq!(state.selected_league_id, Some(8));
        assert_eq!(state.selected_season_id, None);
        assert!(state.season_entries.is_empty());
    }
}
