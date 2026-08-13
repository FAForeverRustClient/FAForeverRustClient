//! Leaderboard orchestration.

use faf_domain::state::{LeaderboardCommand, LeaderboardEvent};

use crate::runtime::{EventSink, ServiceCtx};

async fn load_season(season_id: i32, ctx: &ServiceCtx, out: &EventSink) {
    let generation = ctx.leaderboard_season_generation.begin();
    out.emit(LeaderboardEvent::SeasonLoading { season_id });
    let result = ctx
        .ports
        .leaderboard
        .list_season_leaderboard(season_id)
        .await;
    if !ctx.leaderboard_season_generation.is_current(generation) {
        return;
    }
    match result {
        Ok(leaderboard) => out.emit(LeaderboardEvent::SeasonLoaded {
            season_id,
            leaderboard,
        }),
        Err(reason) => out.emit(LeaderboardEvent::SeasonLoadFailed { reason }),
    }
}

pub async fn handle(cmd: LeaderboardCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        LeaderboardCommand::SetMode { mode } => {
            out.emit(LeaderboardEvent::ModeChanged { mode });
        }
        LeaderboardCommand::LoadCatalog => {
            let generation = ctx.leaderboard_catalog_generation.begin();
            out.emit(LeaderboardEvent::CatalogLoading);
            let (rating_leaderboards, leagues) = tokio::join!(
                ctx.ports.leaderboard.list_rating_leaderboards(),
                ctx.ports.leaderboard.list_leagues(),
            );
            if !ctx.leaderboard_catalog_generation.is_current(generation) {
                return;
            }
            match (rating_leaderboards, leagues) {
                (Ok(rating_leaderboards), Ok(leagues)) => {
                    out.emit(LeaderboardEvent::CatalogLoaded {
                        rating_leaderboards,
                        leagues,
                    });
                }
                (Err(reason), _) | (_, Err(reason)) => {
                    out.emit(LeaderboardEvent::CatalogLoadFailed { reason });
                }
            }
        }
        LeaderboardCommand::LoadRatings { mut query } => {
            let generation = ctx.leaderboard_ratings_generation.begin();
            query.page = query.page.max(1);
            query.page_size = query.page_size.clamp(25, 1_000);
            out.emit(LeaderboardEvent::RatingsLoading {
                query: query.clone(),
            });
            let result = ctx.ports.leaderboard.list_ratings(&query).await;
            if !ctx.leaderboard_ratings_generation.is_current(generation) {
                return;
            }
            match result {
                Ok(page) => out.emit(LeaderboardEvent::RatingsLoaded { query, page }),
                Err(reason) => out.emit(LeaderboardEvent::RatingsLoadFailed { reason }),
            }
        }
        LeaderboardCommand::SelectLeague { league_id } => {
            let generation = ctx.leaderboard_seasons_generation.begin();
            // A board from the previously selected league is no longer relevant.
            ctx.leaderboard_season_generation.invalidate();
            out.emit(LeaderboardEvent::SeasonsLoading { league_id });
            let result = ctx.ports.leaderboard.list_seasons(league_id).await;
            if !ctx.leaderboard_seasons_generation.is_current(generation) {
                return;
            }
            match result {
                Ok(seasons) => {
                    let first_season = seasons.first().map(|season| season.id);
                    out.emit(LeaderboardEvent::SeasonsLoaded { league_id, seasons });
                    if let Some(season_id) = first_season {
                        load_season(season_id, ctx, out).await;
                    }
                }
                Err(reason) => out.emit(LeaderboardEvent::SeasonsLoadFailed { reason }),
            }
        }
        LeaderboardCommand::SelectSeason { season_id } => {
            load_season(season_id, ctx, out).await;
        }
    }
}
