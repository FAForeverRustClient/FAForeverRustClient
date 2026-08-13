//! Leaderboard service.
//!
//! Thin handler (like `services/maps.rs`): asks the [`crate::ports::
//! LeaderboardPort`] to do the work, then emits the corresponding events.

use faf_domain::state::{LeaderboardCommand, LeaderboardEvent};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: LeaderboardCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        LeaderboardCommand::LoadLeagues => {
            out.emit(LeaderboardEvent::LeaguesLoading);
            match ctx.ports.leaderboard.list_leagues().await {
                Ok(leagues) => out.emit(LeaderboardEvent::LeaguesLoaded { leagues }),
                Err(reason) => out.emit(LeaderboardEvent::LeaguesLoadFailed { reason }),
            }
        }
        LeaderboardCommand::SelectLeague { league_id } => {
            out.emit(LeaderboardEvent::EntriesLoading { league_id });
            match ctx.ports.leaderboard.list_entries(league_id).await {
                Ok(entries) => out.emit(LeaderboardEvent::EntriesLoaded { league_id, entries }),
                Err(reason) => out.emit(LeaderboardEvent::EntriesLoadFailed { reason }),
            }
        }
        LeaderboardCommand::LoadGlobal => {
            out.emit(LeaderboardEvent::GlobalLoading);
            match ctx.ports.leaderboard.list_global().await {
                Ok(entries) => out.emit(LeaderboardEvent::GlobalLoaded { entries }),
                Err(reason) => out.emit(LeaderboardEvent::GlobalLoadFailed { reason }),
            }
        }
    }
}
