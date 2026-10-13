//! Entering an event: signing up, declining an invitation, withdrawing and
//! checking in, and the organiser's side of the same list: adding, approving,
//! removing, banning, editing and inviting entrants.

use faf_domain::state::{TourneyAction, TourneyActionFailure, TourneyAdmin, TourneyEvent};

use crate::runtime::{EventSink, ServiceCtx};

use super::write;

pub(super) async fn sign_up(
    tournament_id: String,
    rating: Option<i32>,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    write(TourneyAction::SigningUp, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .sign_up(&tournament_id, rating)
                .await
        }
    })
    .await;
}

pub(super) async fn decline_invite(tournament_id: String, ctx: &ServiceCtx, out: &EventSink) {
    write(TourneyAction::DecliningInvite, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move { ctx.ports.tourney_entry.decline_invite(&tournament_id).await }
    })
    .await;
}

pub(super) async fn withdraw(tournament_id: String, ctx: &ServiceCtx, out: &EventSink) {
    // Which entry to remove is the server's own answer, read back out of
    // the open event. A client that supplied its own id could only ever
    // be wrong about it, and the server would refuse it anyway.
    let Some(player_id) = my_player_id(&tournament_id, out) else {
        out.emit(TourneyEvent::ActionFailed {
            failure: TourneyActionFailure {
                action: TourneyAction::Withdrawing,
                reason: "You are not signed up for this tournament.".into(),
                kind: faf_domain::state::RequestFailureKind::Rejected,
            },
        });
        return;
    };
    write(TourneyAction::Withdrawing, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .withdraw(&tournament_id, &player_id)
                .await
        }
    })
    .await;
}

pub(super) async fn check_in(
    tournament_id: String,
    checked_in: bool,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    write(TourneyAction::CheckingIn, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .check_in(&tournament_id, checked_in)
                .await
        }
    })
    .await;
}

// The organiser's side of signing up. Adding and inviting go by FAF
// name, which the server resolves against a real account: there is no
// free-typed entrant, and that is what keeps an entry attached to
// somebody the client can show an avatar and a rating for.
pub(super) async fn add_player(
    tournament_id: String,
    name: String,
    rating: Option<i32>,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    if name.trim().is_empty() {
        return;
    }
    write(TourneyAction::AddingPlayer, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .add_player(&tournament_id, name.trim(), rating)
                .await
        }
    })
    .await;
}

pub(super) async fn respond_signup(
    tournament_id: String,
    player_id: String,
    accept: bool,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::AnsweringSignup {
        player_id: player_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .respond_signup(&tournament_id, &player_id, accept)
                .await
        }
    })
    .await;
}

pub(super) async fn remove_player(
    tournament_id: String,
    player_id: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::RemovingPlayer {
        player_id: player_id.clone(),
    };
    // The same endpoint self-withdrawal uses. The server decides which
    // it is from who is asking, so there is one route rather than two
    // that could disagree.
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .withdraw(&tournament_id, &player_id)
                .await
        }
    })
    .await;
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn ban_player(
    tournament_id: String,
    player_id: String,
    faf_id: i32,
    name: String,
    reason: String,
    expires: Option<u32>,
    remove: bool,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::BanningPlayer {
        player_id: player_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            let ban = TourneyAdmin::Ban {
                faf_id,
                name,
                reason,
                expires,
            };
            ctx.ports
                .tourney_organiser
                .administer(&tournament_id, &ban)
                .await?;
            if remove {
                ctx.ports
                    .tourney_entry
                    .withdraw(&tournament_id, &player_id)
                    .await?;
            }
            Ok(())
        }
    })
    .await;
}

pub(super) async fn edit_player(
    tournament_id: String,
    player_id: String,
    note: String,
    rating: Option<i32>,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::EditingPlayer {
        player_id: player_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        // Trimmed here rather than in the form: the server stores what it
        // is given, and a note of spaces would render as a stray "()"
        // beside the name.
        let note = note.trim().to_string();
        async move {
            ctx.ports
                .tourney_entry
                .edit_player(&tournament_id, &player_id, &note, rating)
                .await
        }
    })
    .await;
}

pub(super) async fn invite_player(
    tournament_id: String,
    name: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    if name.trim().is_empty() {
        return;
    }
    write(TourneyAction::Inviting, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .invite_player(&tournament_id, name.trim())
                .await
        }
    })
    .await;
}

pub(super) async fn uninvite(
    tournament_id: String,
    faf_id: i32,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    write(TourneyAction::Inviting, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .uninvite(&tournament_id, faf_id)
                .await
        }
    })
    .await;
}

/// This account's entry in the open event, as the server named it.
fn my_player_id(tournament_id: &str, out: &EventSink) -> Option<String> {
    out.with_state(|state| {
        state
            .tourney
            .detail
            .as_ref()
            .filter(|event| event.id == tournament_id)
            .and_then(|event| event.viewer.signed_up_player_id.clone())
    })
}
