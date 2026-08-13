use async_trait::async_trait;
use faf_domain::state::{
    MatchmakerPlayerProfile, PlayerCardProfile, RatingHistoryPage, RatingHistoryQuery,
};

#[async_trait]
pub trait PlayerCardPort: Send + Sync {
    async fn load_profile(
        &self,
        player_id: Option<i32>,
        login: &str,
    ) -> Result<PlayerCardProfile, String>;
    async fn load_matchmaker_profile(
        &self,
        player_id: i32,
        login: &str,
    ) -> Result<MatchmakerPlayerProfile, String>;
    async fn load_rating_history(
        &self,
        query: &RatingHistoryQuery,
    ) -> Result<RatingHistoryPage, String>;
}
