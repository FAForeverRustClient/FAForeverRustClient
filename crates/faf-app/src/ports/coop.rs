//! Co-op API boundary: missions, scenarios, and the record board.

use async_trait::async_trait;
use faf_domain::state::{CoopMission, CoopResult, CoopScenario};

use super::RequestError;

#[async_trait]
pub trait CoopPort: Send + Sync {
    /// Every mission and the scenarios grouping them.
    ///
    /// One call for both because the UI needs them together and neither is
    /// large: the Java client fetches both up front and caches them for the
    /// session.
    async fn list_catalog(&self) -> Result<(Vec<CoopScenario>, Vec<CoopMission>), RequestError>;

    /// Fastest completions of one mission.
    ///
    /// `player_count` of [`faf_domain::state::ANY_PLAYER_COUNT`] means "don't
    /// filter". Returned unranked and possibly with repeat runs by the same
    /// team; `rank_results` collapses and numbers them.
    async fn list_leaderboard(
        &self,
        mission_id: i32,
        player_count: i32,
    ) -> Result<Vec<CoopResult>, RequestError>;
}
