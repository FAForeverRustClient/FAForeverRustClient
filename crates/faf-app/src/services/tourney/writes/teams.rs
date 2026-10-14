//! Teams and the draft: forming, joining, leaving, renaming and disbanding a
//! team, the captain's armband, moving an entrant between teams, and the
//! draft that fills the teams pick by pick.

use faf_domain::state::TourneyAction;

use crate::runtime::{EventSink, ServiceCtx};

use super::write;

// Teams. Every one of these ends in the same reload, because forming a
// team moves people between lists the response never mentions: a member
// joining clears their outstanding requests everywhere, and the last
// one leaving dissolves the team.
pub(super) async fn create_team(
    tournament_id: String,
    name: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    if name.trim().is_empty() {
        return;
    }
    write(TourneyAction::CreatingTeam, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .create_team(&tournament_id, name.trim())
                .await
        }
    })
    .await;
}

pub(super) async fn request_join(
    tournament_id: String,
    team_id: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::AnsweringTeam {
        team_id: team_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .request_join(&tournament_id, &team_id)
                .await
        }
    })
    .await;
}

pub(super) async fn cancel_join(
    tournament_id: String,
    team_id: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::AnsweringTeam {
        team_id: team_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .cancel_join(&tournament_id, &team_id)
                .await
        }
    })
    .await;
}

pub(super) async fn respond_join(
    tournament_id: String,
    team_id: String,
    player_id: String,
    accept: bool,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::AnsweringTeam {
        team_id: team_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .respond_join(&tournament_id, &team_id, &player_id, accept)
                .await
        }
    })
    .await;
}

pub(super) async fn invite_to_team(
    tournament_id: String,
    team_id: String,
    player_id: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::InvitingToTeam {
        player_id: player_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .invite_to_team(&tournament_id, &team_id, &player_id)
                .await
        }
    })
    .await;
}

pub(super) async fn respond_invite(
    tournament_id: String,
    team_id: String,
    accept: bool,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::AnsweringTeam {
        team_id: team_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .respond_invite(&tournament_id, &team_id, accept)
                .await
        }
    })
    .await;
}

pub(super) async fn leave_team(tournament_id: String, ctx: &ServiceCtx, out: &EventSink) {
    write(TourneyAction::LeavingTeam, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move { ctx.ports.tourney_entry.leave_team(&tournament_id).await }
    })
    .await;
}

pub(super) async fn disband_team(
    tournament_id: String,
    team_id: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::AnsweringTeam {
        team_id: team_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .disband_team(&tournament_id, &team_id)
                .await
        }
    })
    .await;
}

pub(super) async fn rename_team(
    tournament_id: String,
    team_id: String,
    name: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    if name.trim().is_empty() {
        return;
    }
    write(TourneyAction::RenamingTeam, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .rename_team(&tournament_id, &team_id, name.trim())
                .await
        }
    })
    .await;
}

pub(super) async fn set_captain(
    tournament_id: String,
    team_id: String,
    player_id: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::SettingCaptain {
        player_id: player_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .set_captain(&tournament_id, &team_id, &player_id)
                .await
        }
    })
    .await;
}

pub(super) async fn move_player(
    tournament_id: String,
    player_id: String,
    team_id: Option<String>,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::MovingPlayer {
        player_id: player_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .move_player(&tournament_id, &player_id, team_id.as_deref())
                .await
        }
    })
    .await;
}

pub(super) async fn draft_pick_player(
    tournament_id: String,
    player_id: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    write(TourneyAction::Drafting, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .draft_pick(&tournament_id, &player_id)
                .await
        }
    })
    .await;
}

pub(super) async fn draft_undo(tournament_id: String, ctx: &ServiceCtx, out: &EventSink) {
    write(TourneyAction::Drafting, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move { ctx.ports.tourney_entry.draft_undo(&tournament_id).await }
    })
    .await;
}

pub(super) async fn set_captains(
    tournament_id: String,
    player_ids: Vec<String>,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    write(TourneyAction::Drafting, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_entry
                .set_captains(&tournament_id, &player_ids)
                .await
        }
    })
    .await;
}
