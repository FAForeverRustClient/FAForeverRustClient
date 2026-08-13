//! Leaderboard API boundary.

use async_trait::async_trait;
use faf_domain::state::{
    League, LeagueSeason, RatingLeaderboard, RatingPage, RatingQuery, SeasonLeaderboard,
};

#[async_trait]
pub trait LeaderboardPort: Send + Sync {
    async fn list_rating_leaderboards(&self) -> Result<Vec<RatingLeaderboard>, String>;
    async fn list_leagues(&self) -> Result<Vec<League>, String>;
    async fn list_ratings(&self, query: &RatingQuery) -> Result<RatingPage, String>;
    async fn list_seasons(&self, league_id: i32) -> Result<Vec<LeagueSeason>, String>;
    async fn list_season_leaderboard(&self, season_id: i32) -> Result<SeasonLeaderboard, String>;
}
