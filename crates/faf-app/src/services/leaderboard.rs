//! Leaderboard orchestration.

use faf_domain::state::{LeaderboardCommand, LeaderboardEvent, LeaderboardStatus};

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
            // Asked for on every mount of the leaderboard and the replay
            // vault, so the check that it is needed lives here. A failure is
            // retried; "loaded" and "in flight" are the reasons to do nothing.
            if out.with_state(|state| {
                matches!(
                    state.leaderboard.catalog_status,
                    LeaderboardStatus::Loading | LeaderboardStatus::Ready
                )
            }) {
                return;
            }
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
            let page = match result {
                Ok(page) => page,
                Err(reason) => {
                    out.emit(LeaderboardEvent::RatingsLoadFailed { reason });
                    return;
                }
            };
            let player_ids: Vec<i32> = page.entries.iter().map(|entry| entry.player_id).collect();
            out.emit(LeaderboardEvent::RatingsLoaded {
                query: query.clone(),
                page,
            });

            // The other boards, after the page rather than with it. They are
            // five more requests against the same endpoint, and the ranked
            // column is what the reader is waiting for: holding the whole page
            // back for the columns beside it would make every page turn as
            // slow as the slowest of six requests.
            if player_ids.is_empty() {
                return;
            }
            let ratings = ctx.ports.leaderboard.list_player_ratings(&player_ids).await;
            if !ctx.leaderboard_ratings_generation.is_current(generation) {
                return;
            }
            // A failure here is silence, not an error banner: the page is on
            // screen and correct, and the columns beside the ranked one are
            // worth less than the message would cost.
            if let Ok(ratings) = ratings {
                out.emit(LeaderboardEvent::CrossRatingsLoaded { query, ratings });
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
