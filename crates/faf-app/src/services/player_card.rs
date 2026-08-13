//! Player-card orchestration. The port aggregates profile tabs; history stays lazy and pageable.

use faf_domain::state::{PlayerCardCommand, PlayerCardEvent};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(command: PlayerCardCommand, ctx: &ServiceCtx, out: &EventSink) {
    match command {
        PlayerCardCommand::Open { player_id, login } => {
            let generation = ctx.player_card_profile_generation.begin();
            ctx.player_card_history_generation.invalidate();
            out.emit(PlayerCardEvent::Loading {
                login: login.clone(),
            });
            let result = ctx.ports.player_card.load_profile(player_id, &login).await;
            if !ctx.player_card_profile_generation.is_current(generation) {
                return;
            }
            match result {
                Ok(profile) => out.emit(PlayerCardEvent::Loaded {
                    profile: Box::new(profile),
                }),
                Err(reason) => out.emit(PlayerCardEvent::LoadFailed { reason }),
            }
        }
        PlayerCardCommand::Close => {
            ctx.player_card_profile_generation.invalidate();
            ctx.player_card_history_generation.invalidate();
            out.emit(PlayerCardEvent::Closed);
        }
        PlayerCardCommand::LoadHistory { mut query, append } => {
            let generation = ctx.player_card_history_generation.begin();
            query.page = query.page.max(1);
            query.page_size = query.page_size.clamp(100, 10_000);
            out.emit(PlayerCardEvent::HistoryLoading {
                query: query.clone(),
                append,
            });
            let result = ctx.ports.player_card.load_rating_history(&query).await;
            if !ctx.player_card_history_generation.is_current(generation) {
                return;
            }
            match result {
                Ok(page) => out.emit(PlayerCardEvent::HistoryLoaded {
                    query,
                    page,
                    append,
                }),
                Err(reason) => out.emit(PlayerCardEvent::HistoryLoadFailed { reason }),
            }
        }
        PlayerCardCommand::LoadAllHistory { mut query } => {
            let generation = ctx.player_card_history_generation.begin();
            query.page = query.page.max(1);
            query.page_size = query.page_size.clamp(100, 10_000);
            loop {
                if !ctx.player_card_history_generation.is_current(generation) {
                    return;
                }
                out.emit(PlayerCardEvent::HistoryLoading {
                    query: query.clone(),
                    append: true,
                });
                let result = ctx.ports.player_card.load_rating_history(&query).await;
                if !ctx.player_card_history_generation.is_current(generation) {
                    return;
                }
                match result {
                    Ok(page) => {
                        let last_page = page.total_pages.max(1);
                        out.emit(PlayerCardEvent::HistoryLoaded {
                            query: query.clone(),
                            page,
                            append: true,
                        });
                        if query.page >= last_page {
                            break;
                        }
                        query.page += 1;
                    }
                    Err(reason) => {
                        out.emit(PlayerCardEvent::HistoryLoadFailed { reason });
                        break;
                    }
                }
            }
        }
        PlayerCardCommand::LoadMatchmakerProfile { player_id, login } => {
            let generation = ctx.player_card_matchmaker_generation.begin();
            out.emit(PlayerCardEvent::MatchmakerProfileLoading { player_id });
            let result = ctx
                .ports
                .player_card
                .load_matchmaker_profile(player_id, &login)
                .await;
            if !ctx.player_card_matchmaker_generation.is_current(generation) {
                return;
            }
            match result {
                Ok(profile) => out.emit(PlayerCardEvent::MatchmakerProfileLoaded {
                    profile: Box::new(profile),
                }),
                Err(reason) => {
                    out.emit(PlayerCardEvent::MatchmakerProfileLoadFailed { player_id, reason })
                }
            }
        }
    }
}
