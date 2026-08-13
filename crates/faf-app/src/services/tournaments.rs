//! Tournament orchestration.
//!
//! Load, sort, select. The sort happens here rather than in the view because
//! ordering is part of the state every consumer shares: the Java client sorts
//! once on load for the same reason.

use faf_domain::state::{sort_tournaments, TournamentsCommand, TournamentsEvent};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: TournamentsCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        TournamentsCommand::Load => {
            out.emit(TournamentsEvent::Loading);
            match ctx.ports.tournaments.list_tournaments().await {
                Ok(mut tournaments) => {
                    sort_tournaments(&mut tournaments, crate::services::now_seconds());
                    out.emit(TournamentsEvent::Loaded { tournaments });
                }
                Err(reason) => out.emit(TournamentsEvent::LoadFailed { reason }),
            }
        }
        TournamentsCommand::Select { tournament_id } => {
            out.emit(TournamentsEvent::Selected { tournament_id })
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_clock_is_readable_as_unix_seconds() {
        // Guards `now_seconds`' `unwrap_or(0)`: if it ever starts returning 0
        // on a normal machine, every tournament silently sorts as finished and
        // every live match becomes old enough to spectate.
        assert!(
            crate::services::now_seconds() > 1_700_000_000,
            "expected a plausible current time"
        );
    }
}
