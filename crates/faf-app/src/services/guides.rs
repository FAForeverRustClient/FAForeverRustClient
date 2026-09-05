//! Catalogue maintenance: signing in to GitHub, and the submission queue.
//!
//! The interesting part is concurrency policy, because three of these
//! operations have very different shapes:
//!
//! - **Signing in polls for minutes.** It runs single-flight, so pressing the
//!   button twice cannot leave two loops polling the same code, and cancelling
//!   reaches the loop through the port rather than by dropping a task.
//! - **A verdict is a short write that must not overtake another.** Two accepts
//!   at once would both read the catalogue, both patch their own copy and one
//!   would lose; the sha check turns that into a refusal rather than a silent
//!   overwrite, but serialising them means it never happens in the first place.
//! - **Reading the queue is replaceable.** The newest answer wins; an older one
//!   still in flight is not worth waiting for.
//!
//! Every write re-reads the queue afterwards, for the reason the tournament
//! service does the same: the response says nothing about what else changed,
//! and a list that disagrees with the server is worse than a slow one.

use faf_domain::state::{GuidesCommand, GuidesEvent};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: GuidesCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        GuidesCommand::Restore => restore(ctx, out).await,
        GuidesCommand::SignIn => sign_in(ctx, out).await,
        GuidesCommand::CancelSignIn => {
            ctx.ports.guides.cancel_login();
            out.emit(GuidesEvent::SignInCancelled);
        }
        GuidesCommand::SignOut => {
            ctx.ports.guides.sign_out().await;
            out.emit(GuidesEvent::SignedOut);
        }
        GuidesCommand::LoadQueue => load_queue(ctx, out).await,
        GuidesCommand::Accept { number } => accept(number, ctx, out).await,
        GuidesCommand::Reject {
            number,
            reason,
            note,
        } => reject(number, reason, note, ctx, out).await,
        GuidesCommand::Submit { draft } => {
            out.emit(GuidesEvent::Submitting);
            // The author is this client's FAF account, which is what a reader
            // of the catalogue will see credited. GitHub knows who opened the
            // issue; the catalogue entry should name the player.
            let author = out.with_state(|state| {
                state
                    .auth
                    .player
                    .as_ref()
                    .map(|player| player.name.clone())
                    .unwrap_or_default()
            });
            let entry = faf_domain::state::entry_from_draft(&draft, &author);
            match ctx.ports.guides.submit(entry, draft.body.clone()).await {
                Ok(url) => {
                    out.emit(GuidesEvent::Submitted { url });
                    // The queue the author is about to look at should already
                    // contain what they just sent.
                    load_queue(ctx, out).await;
                }
                Err(reason) => out.emit(GuidesEvent::SubmitFailed { reason }),
            }
        }
    }
}

/// Announce what the client was configured with, and pick up a stored session.
///
/// Runs when the tab first opens. The configuration event goes out first and
/// unconditionally: whether signing in is possible at all is what the UI needs
/// before it can decide between a button and an explanation.
async fn restore(ctx: &ServiceCtx, out: &EventSink) {
    out.emit(GuidesEvent::Configured {
        repo: ctx.ports.guides.repo(),
        configured: ctx.ports.guides.configured(),
    });
    match ctx.ports.guides.restore_login().await {
        Ok(Some(identity)) => out.emit(GuidesEvent::SignedIn {
            identity: Box::new(identity),
        }),
        // Nobody has ever signed in here. Not a failure and not worth a word.
        Ok(None) => {}
        // There was a session and it no longer works. Said out loud, because
        // otherwise an expired token looks exactly like never having signed in.
        Err(reason) => out.emit(GuidesEvent::SignInFailed { reason }),
    }
}

async fn sign_in(ctx: &ServiceCtx, out: &EventSink) {
    let Some(_guard) = ctx.guides_login_active.try_acquire() else {
        // Already waiting on a code. Starting a second one would issue a
        // second code and leave the one on screen dead.
        return;
    };

    let code = match ctx.ports.guides.begin_login().await {
        Ok(code) => code,
        Err(reason) => {
            out.emit(GuidesEvent::SignInFailed { reason });
            return;
        }
    };

    out.emit(GuidesEvent::SignInStarted {
        login: Box::new(faf_domain::state::DeviceLogin {
            user_code: code.user_code.clone(),
            verification_uri: code.verification_uri.clone(),
            expires_at: super::now_seconds().saturating_add(code.expires_in),
        }),
    });

    match ctx.ports.guides.complete_login(code).await {
        Ok(identity) => {
            out.emit(GuidesEvent::SignedIn {
                identity: Box::new(identity),
            });
            // Now that there is a token the queue reads under a much larger
            // rate limit, and the maintainer is about to act on it.
            load_queue(ctx, out).await;
        }
        // A cancellation already emitted its own event; anything else is worth
        // reporting where the sign-in button is.
        Err(reason) if reason.contains("cancelled") => {}
        Err(reason) => out.emit(GuidesEvent::SignInFailed { reason }),
    }
}

async fn load_queue(ctx: &ServiceCtx, out: &EventSink) {
    let generation = ctx.guides_queue_generation.begin();
    out.emit(GuidesEvent::QueueLoading);
    let answer = ctx.ports.guides.list_submissions().await;
    if !ctx.guides_queue_generation.is_current(generation) {
        return; // A newer load has already been asked for.
    }
    match answer {
        Ok(submissions) => out.emit(GuidesEvent::QueueLoaded { submissions }),
        Err(reason) => out.emit(GuidesEvent::QueueLoadFailed { reason }),
    }
}

async fn accept(number: i32, ctx: &ServiceCtx, out: &EventSink) {
    let _order = ctx.guides_verdict.acquire().await;

    // Read back rather than carried on the command: the queue may have been
    // reloaded since the button was drawn, and publishing an entry that is no
    // longer what the issue says would be worse than refusing.
    let Some(submission) = out.with_state(|state| state.guides.submission(number).cloned()) else {
        out.emit(GuidesEvent::WriteFailed {
            number,
            reason: "that submission is no longer in the queue".into(),
        });
        return;
    };
    if !submission.is_acceptable() {
        out.emit(GuidesEvent::WriteFailed {
            number,
            reason: "this submission carries no catalogue entry to publish".into(),
        });
        return;
    }

    out.emit(GuidesEvent::Accepting { number });
    match ctx.ports.guides.accept(submission).await {
        Ok(()) => {
            out.emit(GuidesEvent::Accepted { number });
            load_queue(ctx, out).await;
            // And the library, because the maintainer's next question is
            // whether it worked. Leaving them to press refresh on another tab
            // to find out is how a working write looks broken.
            super::training::handle(faf_domain::state::TrainingCommand::Load, ctx, out).await;
        }
        Err(reason) => out.emit(GuidesEvent::WriteFailed { number, reason }),
    }
}

async fn reject(
    number: i32,
    reason: faf_domain::state::RejectReason,
    note: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let _order = ctx.guides_verdict.acquire().await;

    out.emit(GuidesEvent::Rejecting { number });
    match ctx.ports.guides.reject(number, reason, note).await {
        Ok(()) => {
            out.emit(GuidesEvent::Rejected { number });
            load_queue(ctx, out).await;
        }
        Err(reason) => out.emit(GuidesEvent::WriteFailed { number, reason }),
    }
}
