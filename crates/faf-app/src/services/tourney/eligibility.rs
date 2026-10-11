//! Eligibility and ratings checks: whether this account may enter the open
//! event, one entrant's ratings table, and which entrants' FAF accounts were
//! renamed. The first two are given up when the reader moves to another event.

use faf_domain::state::TourneyEvent;

use crate::runtime::{EventSink, ServiceCtx};

/// Whether this account may enter: `TourneyRead::CheckRating`.
pub(super) async fn check_rating(tournament_id: String, ctx: &ServiceCtx, out: &EventSink) {
    // Claimed before the request, and given up by `Select` when the
    // reader moves to another event. The events also name the
    // tournament, so the reducer can refuse an answer about an event
    // that is no longer open even if it slips past this check.
    let generation = ctx.tourney.rating_check_generation.begin();
    out.emit(TourneyEvent::RatingChecking {
        tournament_id: tournament_id.clone(),
    });
    let checked = ctx.ports.tourney_read.check_rating(&tournament_id).await;
    if !ctx.tourney.rating_check_generation.is_current(generation) {
        return;
    }
    match checked {
        Ok(check) => out.emit(TourneyEvent::RatingChecked {
            tournament_id,
            check,
        }),
        Err(error) => out.emit(TourneyEvent::RatingCheckFailed {
            tournament_id,
            reason: error.to_string(),
            kind: error.kind(),
        }),
    }
}

/// One entrant's ratings table: `TourneyRead::LoadPlayerRatings`.
pub(super) async fn load_player_ratings(
    tournament_id: String,
    player_id: String,
    refresh: bool,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    // One table on screen, so one owner: asking for another entrant,
    // or again from FAF, supersedes the answer in flight, and an older
    // one landing last would put the wrong player's ratings (or a
    // refusal nobody is waiting for) under the dialog that is open.
    // Claimed before the request, and given up by `Select` like the
    // eligibility check.
    let generation = ctx.tourney.player_ratings_generation.begin();
    out.emit(TourneyEvent::PlayerRatingsLoading {
        tournament_id: tournament_id.clone(),
    });
    let loaded = ctx
        .ports
        .tourney_read
        .player_ratings(&tournament_id, &player_id, refresh)
        .await;
    if !ctx.tourney.player_ratings_generation.is_current(generation) {
        return;
    }
    match loaded {
        Ok(ratings) => out.emit(TourneyEvent::PlayerRatingsLoaded {
            tournament_id,
            ratings,
        }),
        Err(error) => out.emit(TourneyEvent::PlayerRatingsFailed {
            tournament_id,
            reason: error.to_string(),
            kind: error.kind(),
        }),
    }
}

/// Which entrants' accounts were renamed: `TourneyRead::CheckRenames`.
pub(super) async fn check_renames(tournament_id: String, ctx: &ServiceCtx, out: &EventSink) {
    out.emit(TourneyEvent::RenamesChecking);
    match ctx.ports.tourney_read.check_renames(&tournament_id).await {
        Ok(check) => out.emit(TourneyEvent::RenamesChecked { check }),
        // Shown where the button is: the service's own sentence says
        // when the organiser has to sign in again.
        Err(error) => out.emit(TourneyEvent::RenamesCheckFailed {
            reason: error.to_string(),
            kind: error.kind(),
        }),
    }
}
