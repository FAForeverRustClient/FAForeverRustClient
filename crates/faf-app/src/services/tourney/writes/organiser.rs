//! The organiser's writes on one event: creating it and the pictures in its
//! text, its settings and format, publishing, archiving and abandoning it,
//! seeding and divisions, the admin console's single-call changes, staff and
//! casters, news, and the qualifiers that feed entrants into it.

use faf_domain::state::{
    FormatDraft, QualifierRule, SeedOrder, TourneyAction, TourneyAdmin, TourneyDraft, TourneyEvent,
};

use crate::runtime::{EventSink, ServiceCtx};

use super::{write, write_selecting};

pub(super) async fn create(draft: TourneyDraft, ctx: &ServiceCtx, out: &EventSink) {
    write_selecting(TourneyAction::Creating, ctx, out, {
        let draft = trimmed_draft(draft);
        async move {
            let id = ctx.ports.tourney_organiser.create(&draft).await?;
            // Pictures pasted before the event existed go up now, and
            // the text is saved again with their paths in place of
            // the tokens. A failure leaves the event created, as the
            // website does, with the token where the picture was.
            if !draft.pending_images.is_empty() {
                let mut placed = Vec::new();
                for image in &draft.pending_images {
                    match ctx.ports.tourney_organiser.upload_desc_image(&id, &image.data_url).await {
                        Ok(url) if !url.is_empty() => placed.push((image.token.clone(), url)),
                        Ok(_) => {}
                        Err(error) => tracing::warn!(%error, "a pasted picture could not be stored"),
                    }
                }
                if !placed.is_empty() {
                    let swapped = draft.with_images_placed(&placed);
                    if let Err(error) = ctx.ports.tourney_organiser.edit_info(&id, &swapped).await {
                        tracing::warn!(%error, "the text with the pasted pictures could not be saved");
                    }
                }
            }
            Ok(Some(id))
        }
    })
    .await;
}

pub(super) async fn upload_desc_image(
    tournament_id: String,
    data_url: String,
    request_id: u32,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let stored = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    let held = stored.clone();
    write(TourneyAction::Editing, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            let url = ctx
                .ports
                .tourney_organiser
                .upload_desc_image(&tournament_id, &data_url)
                .await?;
            if let Ok(mut slot) = held.lock() {
                *slot = Some(url);
            }
            Ok(())
        }
    })
    .await;
    // Answered either way: `write` reports a failure as the panel's
    // action error, which says nothing about which paste it was.
    match stored.lock().ok().and_then(|mut slot| slot.take()) {
        Some(url) => out.emit(TourneyEvent::DescImageUploaded { request_id, url }),
        None => out.emit(TourneyEvent::DescImageUploadFailed { request_id }),
    }
}

pub(super) async fn edit_info(
    tournament_id: String,
    draft: TourneyDraft,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    write(TourneyAction::Editing, ctx, out, {
        let tournament_id = tournament_id.clone();
        let draft = trimmed_draft(draft);
        async move {
            ctx.ports
                .tourney_organiser
                .edit_info(&tournament_id, &draft)
                .await
        }
    })
    .await;
}

pub(super) async fn edit_format(
    tournament_id: String,
    format: FormatDraft,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    // Whether the team setup is among the changes is decided here,
    // against the event on screen, because the service refuses those
    // four keys outside signups on presence alone. Sending an unchanged
    // team size alongside a bracket-type change would be refused with
    // "Reopen signups to change the team setup", for a change that
    // touched neither teams nor signups.
    let structural = open_event(out)
        .map(|event| format.is_structural(&event))
        .unwrap_or(true);
    write(TourneyAction::EditingFormat, ctx, out, {
        let tournament_id = tournament_id.clone();
        let format = format.clone();
        async move {
            ctx.ports
                .tourney_organiser
                .edit_format(&tournament_id, &format, structural)
                .await
        }
    })
    .await;
}

pub(super) async fn publish(tournament_id: String, ctx: &ServiceCtx, out: &EventSink) {
    write(TourneyAction::Publishing, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move { ctx.ports.tourney_organiser.publish(&tournament_id).await }
    })
    .await;
}

pub(super) async fn archive(tournament_id: String, ctx: &ServiceCtx, out: &EventSink) {
    write(TourneyAction::Archiving, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move { ctx.ports.tourney_organiser.archive(&tournament_id).await }
    })
    .await;
}

pub(super) async fn abandon(
    tournament_id: String,
    abandoned: bool,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    write(TourneyAction::Abandoning, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_organiser
                .abandon(&tournament_id, abandoned)
                .await
        }
    })
    .await;
}

pub(super) async fn reseed(
    tournament_id: String,
    order: SeedOrder,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    write(TourneyAction::Reseeding, ctx, out, {
        let tournament_id = tournament_id.clone();
        let order = tidy_order(order);
        async move {
            ctx.ports
                .tourney_organiser
                .reseed(&tournament_id, &order)
                .await
        }
    })
    .await;
}

pub(super) async fn split_divisions(
    tournament_id: String,
    divisions: i32,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    write(TourneyAction::Dividing, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_organiser
                .split_divisions(&tournament_id, divisions.clamp(1, 6))
                .await
        }
    })
    .await;
}

pub(super) async fn set_division(
    tournament_id: String,
    team_id: String,
    division: i32,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    write(TourneyAction::Dividing, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_organiser
                .set_division(&tournament_id, &team_id, division)
                .await
        }
    })
    .await;
}

pub(super) async fn administer(
    tournament_id: String,
    change: TourneyAdmin,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    // A proposal's step changes what waits on whom (#569): the proposer's
    // pending items, a director's alert and the console's queue, none of
    // which is part of the reload a write gets.
    let proposal = matches!(
        change,
        TourneyAdmin::ProposalSubmit { .. }
            | TourneyAdmin::ProposalWithdraw
            | TourneyAdmin::ProposalTake { .. }
            | TourneyAdmin::ProposalDecline { .. }
            | TourneyAdmin::ProposalRelease { .. }
            | TourneyAdmin::ProposalUnlock { .. }
            | TourneyAdmin::ProposalDrop
    );
    write(TourneyAction::Administering, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_organiser
                .administer(&tournament_id, &change)
                .await
        }
    })
    .await;
    if proposal {
        super::super::site::reload_site(ctx, out).await;
    }
}

pub(super) async fn add_organiser(
    tournament_id: String,
    faf_id: i32,
    name: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    write(TourneyAction::AddingOrganiser, ctx, out, {
        let tournament_id = tournament_id.clone();
        let name = name.clone();
        async move {
            ctx.ports
                .tourney_organiser
                .add_organiser(&tournament_id, faf_id, &name)
                .await
        }
    })
    .await;
}

pub(super) async fn set_caster(
    tournament_id: String,
    faf_id: i32,
    name: String,
    casting: bool,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::SettingCaster { faf_id };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        let name = name.clone();
        async move {
            ctx.ports
                .tourney_organiser
                .set_caster(&tournament_id, faf_id, &name, casting)
                .await
        }
    })
    .await;
}

pub(super) async fn set_organiser_visibility(
    tournament_id: String,
    faf_id: i32,
    hidden: bool,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::SettingOrganiserVisibility { faf_id };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_organiser
                .set_organiser_visibility(&tournament_id, faf_id, hidden)
                .await
        }
    })
    .await;
}

pub(super) async fn post_news(
    tournament_id: String,
    body: String,
    important: bool,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    if body.trim().is_empty() {
        return;
    }
    write(TourneyAction::PostingNews, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_organiser
                .post_news(&tournament_id, body.trim(), important)
                .await
        }
    })
    .await;
}

pub(super) async fn edit_news(
    tournament_id: String,
    news_id: String,
    body: String,
    important: bool,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::EditingNews {
        news_id: news_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        let news_id = news_id.clone();
        let body = body.clone();
        async move {
            ctx.ports
                .tourney_organiser
                .edit_news(&tournament_id, &news_id, &body, important)
                .await
        }
    })
    .await;
}

pub(super) async fn delete_news(
    tournament_id: String,
    news_id: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    write(TourneyAction::PostingNews, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_organiser
                .delete_news(&tournament_id, &news_id)
                .await
        }
    })
    .await;
}

pub(super) async fn add_qualifier(
    tournament_id: String,
    qualifier_id: String,
    rule: QualifierRule,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    write(TourneyAction::AddingQualifier, ctx, out, {
        let tournament_id = tournament_id.clone();
        let qualifier_id = qualifier_id.clone();
        async move {
            ctx.ports
                .tourney_organiser
                .add_qualifier(&tournament_id, &qualifier_id, rule)
                .await
        }
    })
    .await;
}

pub(super) async fn remove_qualifier(
    tournament_id: String,
    link_id: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::RemovingQualifier {
        link_id: link_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        let link_id = link_id.clone();
        async move {
            ctx.ports
                .tourney_organiser
                .remove_qualifier(&tournament_id, &link_id)
                .await
        }
    })
    .await;
}

/// The event the pane is showing, read back out of the state.
fn open_event(out: &EventSink) -> Option<faf_domain::state::Tourney> {
    out.with_state(|state| state.tourney.open_event().cloned())
}

/// Trim what a form leaves behind, and settle the fields the server would
/// override anyway, so the draft that is sent is the one that comes back.
fn trimmed_draft(draft: TourneyDraft) -> TourneyDraft {
    let formation = draft.effective_formation();
    TourneyDraft {
        name: draft.name.trim().to_string(),
        description: draft.description.trim().to_string(),
        team_size: draft.team_size.clamp(1, 6),
        formation,
        ..draft
    }
}

/// Drop blank ids a drag-and-drop list can leave behind.
///
/// The server refuses an order that does not name every team exactly once, so
/// an empty entry would cost the whole reseed rather than one row.
fn tidy_order(order: SeedOrder) -> SeedOrder {
    match order {
        SeedOrder::Randomise => SeedOrder::Randomise,
        SeedOrder::InviteOrder => SeedOrder::InviteOrder,
        SeedOrder::Explicit { team_ids } => SeedOrder::Explicit {
            team_ids: team_ids
                .into_iter()
                .map(|id| id.trim().to_string())
                .filter(|id| !id.is_empty())
                .collect(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_solo_event_is_solo_whatever_the_form_said() {
        // The server forces it, so the draft that is sent should already say
        // so rather than being quietly overridden.
        let draft = trimmed_draft(TourneyDraft {
            team_size: 1,
            formation: faf_domain::state::Formation::Draft,
            name: "  Weekend Cup  ".into(),
            ..TourneyDraft::new()
        });
        assert_eq!(draft.formation, faf_domain::state::Formation::Solo);
        assert_eq!(draft.name, "Weekend Cup");
    }
}
