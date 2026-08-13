//! Leaderboard port — league listing and the active season's rankings.
//!
//! See `infra/leaderboard.rs` for the real implementation (FAF Data API's
//! league/season/score resources).

use async_trait::async_trait;
use faf_domain::state::{LeaderboardEntry, League};

#[async_trait]
pub trait LeaderboardPort: Send + Sync {
    /// List enabled leagues — the ladder brackets (1v1/2v2/3v3/4v4) — from
    /// the FAF Data API (`/data/league`, `filter=enabled==true`).
    async fn list_leagues(&self) -> Result<Vec<League>, String>;

    /// Rankings for the given league's currently active season, ranked by
    /// score descending, each entry also carrying that player's underlying
    /// rating for the matching game mode. Empty (not an error) if the
    /// league has no active season right now.
    async fn list_entries(&self, league_id: i32) -> Result<Vec<LeaderboardEntry>, String>;

    /// The global rating leaderboard — a flat list with no league/season/
    /// division concept (mirrors the Python client's `LeaderboardWidget`
    /// for the `"global"` leaderboard).
    async fn list_global(&self) -> Result<Vec<LeaderboardEntry>, String>;
}
