use async_trait::async_trait;
use faf_domain::state::{
    MatchmakerPlayerProfile, PlayerCardProfile, PlayerMapStats, PlayerSummary, RatingHistoryPage,
    RatingHistoryQuery,
};

use super::RequestError;

#[async_trait]
pub trait PlayerCardPort: Send + Sync {
    /// Accounts whose login starts with `query`.
    ///
    /// For pickers, so a tournament entry can carry a real account instead of
    /// a typed name. Returns at most `limit`; an empty or too-short query
    /// returns nothing rather than the first page of every account on FAF.
    async fn search_players(
        &self,
        query: &str,
        limit: i32,
    ) -> Result<Vec<PlayerSummary>, RequestError>;

    /// Resolve a batch of exact logins in one request.
    ///
    /// One request rather than one per name: a signup thread routinely holds
    /// thirty of them, and thirty round trips would be both slow and rude to
    /// the API. Names that match nothing are simply absent from the result.
    async fn players_by_login(&self, logins: &[String])
        -> Result<Vec<PlayerSummary>, RequestError>;

    /// Resolve a batch of account ids in one request.
    async fn players_by_id(&self, ids: &[i32]) -> Result<Vec<PlayerSummary>, RequestError>;

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

    /// Every game this player has finished, folded into per-map records.
    ///
    /// Separate from [`Self::load_profile`] because it walks the whole history
    /// rather than reading one document, and the profile's identity should not
    /// wait for it.
    async fn load_map_stats(&self, player_id: i32) -> Result<PlayerMapStats, String>;
}
