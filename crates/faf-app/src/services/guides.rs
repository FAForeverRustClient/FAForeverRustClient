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

use faf_domain::state::{contribution_problem, ContributionProblem, GuidesCommand, GuidesEvent};

use crate::ports::guides::LOGIN_CANCELLED;
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
            // Checked here as well as by the form, because the form is not the
            // only thing that can send this command, and a draft with no title
            // opened an issue called "Training submission: " with nothing
            // after it.
            if let Some(problem) = contribution_problem(&draft) {
                out.emit(GuidesEvent::SubmitFailed {
                    reason: problem_reason(problem).into(),
                });
                return;
            }
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
            let answer = ctx.ports.guides.submit(entry, draft.body.clone()).await;
            report_lost_session(ctx, out);
            match answer {
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

/// Why a draft cannot be submitted, in the backend's words. The form shows its
/// own translated sentence before it ever sends one of these, so this is the
/// answer to a caller that skipped the form.
pub fn problem_reason(problem: ContributionProblem) -> &'static str {
    match problem {
        ContributionProblem::NoTitle => "a submission needs a title",
        ContributionProblem::NoContent => "a submission needs a link or a written guide",
        ContributionProblem::BadUrl => "the link must be an ordinary https:// address",
    }
}

/// Tell the tab when the port dropped a token GitHub no longer accepts.
///
/// Any request can be the one that finds out, a queue read included, and that
/// read then succeeds anonymously, so without this the tab would keep showing
/// a session that ended and the next accept would fail for a reason nobody
/// was told.
fn report_lost_session(ctx: &ServiceCtx, out: &EventSink) {
    if let Some(reason) = ctx.ports.guides.take_lost_session() {
        out.emit(GuidesEvent::SignInFailed { reason });
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
        Err(reason) => {
            // GitHub said the token is dead, and the port dropped it. Said out
            // loud, because otherwise an expired token looks exactly like never
            // having signed in.
            if let Some(lost) = ctx.ports.guides.take_lost_session() {
                out.emit(GuidesEvent::SignInFailed { reason: lost });
                return;
            }
            // Anything else (GitHub unreachable, a server error) says nothing
            // about the token, which the port kept. A session already on
            // screen stays there; the tab re-checks every time it opens, and
            // one failed check is no reason to take the controls away.
            let signed_in = out.with_state(|state| state.guides.may_moderate());
            if signed_in {
                tracing::info!(%reason, "could not re-check the GitHub session; keeping it");
            } else {
                out.emit(GuidesEvent::SignInFailed {
                    reason: format!(
                        "{reason}. The saved sign-in was kept and is tried again when the tab next opens"
                    ),
                });
            }
        }
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
        // Cancelled while the code was being issued: the cancel already said
        // so, and showing the code now would put a dead one on screen.
        Err(reason) if reason == LOGIN_CANCELLED => return,
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
        // A cancellation already emitted its own event, but it is said again:
        // a cancel that landed between the code being issued and announced is
        // otherwise overtaken by that announcement, leaving the tab waiting on
        // a code nothing polls for. Anything else is worth reporting where the
        // sign-in button is.
        Err(reason) if reason == LOGIN_CANCELLED => out.emit(GuidesEvent::SignInCancelled),
        Err(reason) => out.emit(GuidesEvent::SignInFailed { reason }),
    }
}

async fn load_queue(ctx: &ServiceCtx, out: &EventSink) {
    let generation = ctx.guides_queue_generation.begin();
    out.emit(GuidesEvent::QueueLoading);
    let answer = ctx.ports.guides.list_submissions().await;
    report_lost_session(ctx, out);
    if !ctx.guides_queue_generation.is_current(generation) {
        return; // A newer load has already been asked for.
    }
    match answer {
        Ok(submissions) => out.emit(GuidesEvent::QueueLoaded { submissions }),
        Err(reason) => out.emit(GuidesEvent::QueueLoadFailed { reason }),
    }
}

async fn accept(number: i32, ctx: &ServiceCtx, out: &EventSink) {
    let order = ctx.guides_verdict.acquire().await;

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
    let answer = ctx.ports.guides.accept(submission).await;
    // The write is what must not overtake another; the reloads after it are
    // reads. Holding the order across them made the next verdict wait for a
    // whole catalogue reload it has nothing to do with.
    drop(order);
    report_lost_session(ctx, out);
    match answer {
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
    let order = ctx.guides_verdict.acquire().await;

    out.emit(GuidesEvent::Rejecting { number });
    let answer = ctx.ports.guides.reject(number, reason, note).await;
    drop(order);
    report_lost_session(ctx, out);
    match answer {
        Ok(()) => {
            out.emit(GuidesEvent::Rejected { number });
            load_queue(ctx, out).await;
        }
        Err(reason) => out.emit(GuidesEvent::WriteFailed { number, reason }),
    }
}
