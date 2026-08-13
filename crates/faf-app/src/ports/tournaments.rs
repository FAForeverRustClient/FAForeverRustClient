//! Tournaments API boundary.
//!
//! One read: FAF's API proxies Challonge at `/challonge/v1/tournaments.json`,
//! and the client can do nothing else with an event: signing up, seeding and
//! reporting all happen on challonge.com. The Java client's
//! `TournamentService` has exactly this one method for the same reason.

use async_trait::async_trait;
use faf_domain::state::Tournament;

#[async_trait]
pub trait TournamentsPort: Send + Sync {
    /// Every tournament the API knows about, unsorted: ordering is a domain
    /// decision (`faf_domain::state::sort_tournaments`), not a transport one.
    async fn list_tournaments(&self) -> Result<Vec<Tournament>, String>;
}
