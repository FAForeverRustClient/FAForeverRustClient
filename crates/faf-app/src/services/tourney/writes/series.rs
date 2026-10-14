//! The series: saving and deleting one, which reload the series rather than
//! the events, and filing an event under one, which changes both.

use faf_domain::state::{SeriesDraft, TourneyAction};

use crate::runtime::{EventSink, ServiceCtx};
use crate::services::tourney::reads::load_series;

use super::{write, write_series};

pub(super) async fn save_series(draft: SeriesDraft, ctx: &ServiceCtx, out: &EventSink) {
    let draft = trimmed_series(draft);
    write_series(TourneyAction::SavingSeries, ctx, out, {
        let draft = draft.clone();
        async move { ctx.ports.tourney_organiser.save_series(&draft).await }
    })
    .await;
}

pub(super) async fn delete_series(series_id: String, ctx: &ServiceCtx, out: &EventSink) {
    let action = TourneyAction::DeletingSeries {
        series_id: series_id.clone(),
    };
    // The open series is the one being deleted more often than not, so
    // it is closed before the reload rather than after: a detail pane
    // showing a series the next list will not contain is a flicker of
    // something that no longer exists.
    write_series(action, ctx, out, {
        let series_id = series_id.clone();
        async move { ctx.ports.tourney_organiser.delete_series(&series_id).await }
    })
    .await;
}

pub(super) async fn set_series(
    tournament_id: String,
    series_id: Option<String>,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    // Touches both sides: the event gains or loses its label, and the
    // series gains or loses an edition. `write` reloads the event; the
    // series list is reloaded after it, or the count beside the name
    // would stay a request behind.
    write(TourneyAction::SettingSeries, ctx, out, {
        let tournament_id = tournament_id.clone();
        let series_id = series_id.clone();
        async move {
            ctx.ports
                .tourney_organiser
                .set_series(&tournament_id, series_id.as_deref())
                .await
        }
    })
    .await;
    load_series(ctx, out).await;
}

/// Trim what a form leaves behind, the way every other draft is trimmed.
fn trimmed_series(draft: SeriesDraft) -> SeriesDraft {
    SeriesDraft {
        id: draft.id.trim().to_string(),
        name: draft.name.trim().to_string(),
        description: draft.description.trim().to_string(),
        ..draft
    }
}
