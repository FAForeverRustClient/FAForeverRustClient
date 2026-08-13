//! Review orchestration.
//!
//! Submitting is create-or-update depending on whether the signed-in player
//! already has a review: the same branch Java's `ReviewService.saveReview`
//! makes on `id == null`. Every write is followed by a re-read, so the list
//! and the histogram always describe the same set.

use faf_domain::state::{clamp_score, own_review, ReviewsCommand, ReviewsEvent};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: ReviewsCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        ReviewsCommand::Open { target } => {
            let generation = next_generation(ctx);
            out.emit(ReviewsEvent::Opened {
                target: target.clone(),
            });
            out.emit(ReviewsEvent::Loading);
            let result = ctx.ports.reviews.list(target.kind, target.id).await;
            if !is_current(ctx, generation) {
                return;
            }
            match result {
                Ok(page) => out.emit(ReviewsEvent::Loaded {
                    target,
                    reviews: page.reviews,
                }),
                Err(reason) => out.emit(ReviewsEvent::LoadFailed { reason }),
            }
        }
        ReviewsCommand::Close => {
            next_generation(ctx);
            out.emit(ReviewsEvent::Closed);
        }
        ReviewsCommand::Submit { score, text } => submit(score, text, ctx, out).await,
        ReviewsCommand::Delete => delete(ctx, out).await,
    }
}

async fn submit(score: i32, text: String, ctx: &ServiceCtx, out: &EventSink) {
    let generation = next_generation(ctx);
    let (target, login, existing) = out.with_state(|state| {
        let login = state.auth.player.as_ref().map(|player| player.name.clone());
        let existing = login
            .as_deref()
            .and_then(|login| own_review(&state.reviews.reviews, login))
            .map(|review| review.id);
        (state.reviews.target.clone(), login, existing)
    });
    let Some(target) = target else {
        return; // The panel closed while the request was being typed.
    };
    let Some(_login) = login else {
        out.emit(ReviewsEvent::SaveFailed {
            reason: "sign in to write a review".into(),
        });
        return;
    };

    let score = clamp_score(score);
    out.emit(ReviewsEvent::Saving);

    // Create or replace, exactly as Java branches on the review already
    // having an id.
    let written = match existing {
        Some(review_id) => {
            ctx.ports
                .reviews
                .update(target.kind, review_id, score, text)
                .await
        }
        None => {
            // A new review attaches to a version, so there has to be one.
            let version_id = match latest_version(ctx, &target).await {
                Ok(Some(version_id)) => version_id,
                Ok(None) => {
                    if is_current(ctx, generation) {
                        out.emit(ReviewsEvent::SaveFailed {
                            reason: "this has no published version to review".into(),
                        });
                    }
                    return;
                }
                Err(reason) => {
                    if is_current(ctx, generation) {
                        out.emit(ReviewsEvent::SaveFailed { reason });
                    }
                    return;
                }
            };
            ctx.ports
                .reviews
                .create(target.kind, version_id, score, text)
                .await
                .map(|_| ())
        }
    };

    if !is_current(ctx, generation) {
        return;
    }
    match written {
        Ok(()) => refresh(ctx, out, &target, generation).await,
        Err(reason) => out.emit(ReviewsEvent::SaveFailed { reason }),
    }
}

async fn delete(ctx: &ServiceCtx, out: &EventSink) {
    let generation = next_generation(ctx);
    let (target, review_id) = out.with_state(|state| {
        let review_id = state
            .auth
            .player
            .as_ref()
            .and_then(|player| own_review(&state.reviews.reviews, &player.name))
            .map(|review| review.id);
        (state.reviews.target.clone(), review_id)
    });
    let Some(target) = target else {
        return;
    };
    let Some(review_id) = review_id else {
        return; // Nothing of ours to withdraw.
    };

    out.emit(ReviewsEvent::Saving);
    let result = ctx.ports.reviews.delete(target.kind, review_id).await;
    if !is_current(ctx, generation) {
        return;
    }
    match result {
        Ok(()) => refresh(ctx, out, &target, generation).await,
        Err(reason) => out.emit(ReviewsEvent::SaveFailed { reason }),
    }
}

/// Re-read after a write.
///
/// The server assigns the id, resolves the author and may reject or alter the
/// text; echoing our own optimistic guess would drift from what everyone else
/// sees. The re-read is one request and the panel is already open.
async fn refresh(
    ctx: &ServiceCtx,
    out: &EventSink,
    target: &faf_domain::state::ReviewTarget,
    generation: u64,
) {
    let result = ctx.ports.reviews.list(target.kind, target.id).await;
    if !is_current(ctx, generation) {
        return;
    }
    match result {
        Ok(page) => out.emit(ReviewsEvent::Saved {
            reviews: page.reviews,
        }),
        // The write *did* land; only the re-read failed. Saying "could not
        // save" here would be a lie that makes the user post twice.
        Err(reason) => out.emit(ReviewsEvent::LoadFailed {
            reason: format!("your review was saved, but the list could not be refreshed: {reason}"),
        }),
    }
}

fn next_generation(ctx: &ServiceCtx) -> u64 {
    ctx.reviews_generation.begin()
}

fn is_current(ctx: &ServiceCtx, generation: u64) -> bool {
    ctx.reviews_generation.is_current(generation)
}

async fn latest_version(
    ctx: &ServiceCtx,
    target: &faf_domain::state::ReviewTarget,
) -> Result<Option<i32>, String> {
    Ok(ctx
        .ports
        .reviews
        .list(target.kind, target.id)
        .await?
        .latest_version_id)
}
