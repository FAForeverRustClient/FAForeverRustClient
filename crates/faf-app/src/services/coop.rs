//! Co-op orchestration.
//!
//! Loading the catalog also loads the first mission's board, and changing
//! either the mission or the player-count filter reloads it: the leaderboard
//! is never something the user has to ask for separately, matching the Java
//! client's `CoopController`, where both combo boxes are subscribed to
//! `loadLeaderboard`.

use faf_domain::state::{rank_results, CoopCommand, CoopEvent};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: CoopCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        CoopCommand::LoadCatalog => {
            let generation = ctx.coop_catalog_generation.begin();
            out.emit(CoopEvent::CatalogLoading);
            let result = ctx.ports.coop.list_catalog().await;
            if !ctx.coop_catalog_generation.is_current(generation) {
                return;
            }
            match result {
                Ok((scenarios, missions)) => {
                    out.emit(CoopEvent::CatalogLoaded {
                        scenarios,
                        missions,
                    });
                    // The reducer picks the opening mission; read it back
                    // rather than re-deriving the same rule here.
                    load_leaderboard(ctx, out).await;
                }
                Err(error) => out.emit(CoopEvent::CatalogLoadFailed {
                    reason: error.to_string(),
                    kind: error.kind(),
                }),
            }
        }
        CoopCommand::SelectMission { mission_id } => {
            out.emit(CoopEvent::MissionSelected { mission_id });
            load_leaderboard(ctx, out).await;
        }
        CoopCommand::SetPlayerCount { player_count } => {
            out.emit(CoopEvent::PlayerCountChanged { player_count });
            load_leaderboard(ctx, out).await;
        }
    }
}

/// Fetch the board for whatever is currently selected.
///
/// Reads the selection back out of state instead of taking it as an argument,
/// so the mission and player count sent to the API are always the pair the
/// reducer settled on: the same pair echoed back in `LeaderboardLoaded`,
/// which is how a stale reply is recognised.
async fn load_leaderboard(ctx: &ServiceCtx, out: &EventSink) {
    let (mission_id, player_count) =
        out.with_state(|state| (state.coop.selected_mission_id, state.coop.player_count));
    let Some(mission_id) = mission_id else {
        return; // Nothing selected: an empty catalog, or a failed load.
    };
    let generation = ctx.coop_leaderboard_generation.begin();

    out.emit(CoopEvent::LeaderboardLoading);
    let result = ctx
        .ports
        .coop
        .list_leaderboard(mission_id, player_count)
        .await;
    if !ctx.coop_leaderboard_generation.is_current(generation) {
        return;
    }
    match result {
        // Collapsing repeat runs and numbering them is a domain rule, not a
        // transport one: the server returns every completion.
        Ok(results) => out.emit(CoopEvent::LeaderboardLoaded {
            mission_id,
            player_count,
            results: rank_results(results),
        }),
        Err(error) => out.emit(CoopEvent::LeaderboardLoadFailed {
            reason: error.to_string(),
            kind: error.kind(),
        }),
    }
}
