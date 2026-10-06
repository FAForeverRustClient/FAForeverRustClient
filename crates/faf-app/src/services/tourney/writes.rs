//! Tournament writes: every command that changes an event, its entrants, its
//! teams, maps, pools and news, or the series, and the helpers that announce
//! each one, run it under the shared write serialisation and reload from the
//! server afterwards. The chat post comes through here like every other write
//! and is run by `chat`, which owns the room it reloads.

use faf_domain::state::{
    MatchReport, PoolDraft, SeedOrder, SeriesDraft, TourneyAction, TourneyActionFailure,
    TourneyAdmin, TourneyDraft, TourneyEvent, TourneyWrite,
};

use crate::ports::RequestError;
use crate::runtime::{EventSink, ServiceCtx};

use super::chat::{post_chat, read_room};
use super::reads::{load, load_detail, load_series, open_series};
use super::site::reload_site;

/// Every write. Exhaustive over [`TourneyWrite`], so a new write does not
/// compile until it has an arm here.
pub(super) async fn handle(cmd: TourneyWrite, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        TourneyWrite::SignUp {
            tournament_id,
            rating,
        } => {
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

        TourneyWrite::DeclineInvite { tournament_id } => {
            write(TourneyAction::DecliningInvite, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move { ctx.ports.tourney_entry.decline_invite(&tournament_id).await }
            })
            .await;
        }

        TourneyWrite::SiteWrite { write } => {
            // An import names the tournament it made, which then opens; a
            // picture upload names its path, which the editor inserts.
            let answer = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
            let held = answer.clone();
            let sent = write.clone();
            write_selecting(TourneyAction::SiteWriting, ctx, out, async move {
                let (opened, image) = ctx.ports.tourney_site.site_write(&sent).await?;
                if let Ok(mut slot) = held.lock() {
                    *slot = image;
                }
                Ok(opened)
            })
            .await;
            let image = answer.lock().ok().and_then(|mut slot| slot.take());
            if let Some(url) = image {
                out.emit(TourneyEvent::ArticleImageUploaded { url });
            }
            if write.touches_console() {
                reload_site(ctx, out).await;
            }
        }

        TourneyWrite::BanPlayer {
            tournament_id,
            player_id,
            faf_id,
            name,
            reason,
            expires,
            remove,
        } => {
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

        TourneyWrite::Withdraw { tournament_id } => {
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

        TourneyWrite::CheckIn {
            tournament_id,
            checked_in,
        } => {
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

        TourneyWrite::AnswerReport {
            tournament_id,
            match_id,
            accept,
        } => {
            let action = TourneyAction::AnsweringReport {
                match_id: match_id.clone(),
            };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move {
                    ctx.ports
                        .tourney_match
                        .confirm_report(&tournament_id, &match_id, accept)
                        .await
                }
            })
            .await;
        }

        TourneyWrite::DecideReport {
            tournament_id,
            report,
        } => {
            let action = TourneyAction::DecidingReport {
                match_id: report.match_id.clone(),
            };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                let report = clean(report);
                async move {
                    ctx.ports
                        .tourney_match
                        .decide_report(&tournament_id, &report)
                        .await
                }
            })
            .await;
        }

        TourneyWrite::SubmitReport {
            tournament_id,
            report,
        } => {
            let action = TourneyAction::SubmittingReport {
                match_id: report.match_id.clone(),
            };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                // The player path takes no winner and no forfeit; clearing them
                // here keeps a stray one from ever reaching the body.
                let report = MatchReport {
                    winner: None,
                    forfeit: None,
                    ..clean(report)
                };
                async move {
                    ctx.ports
                        .tourney_match
                        .submit_report(&tournament_id, &report)
                        .await
                }
            })
            .await;
        }

        TourneyWrite::Create { draft } => {
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

        TourneyWrite::UploadDescImage {
            tournament_id,
            data_url,
            request_id,
        } => {
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

        TourneyWrite::EditInfo {
            tournament_id,
            draft,
        } => {
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

        TourneyWrite::Publish { tournament_id } => {
            write(TourneyAction::Publishing, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move { ctx.ports.tourney_organiser.publish(&tournament_id).await }
            })
            .await;
        }

        TourneyWrite::Advance {
            tournament_id,
            phase,
            config,
        } => {
            write(TourneyAction::Advancing { phase }, ctx, out, {
                let tournament_id = tournament_id.clone();
                let config = config.clone();
                async move {
                    ctx.ports
                        .tourney_match
                        .advance(&tournament_id, phase, config.as_ref())
                        .await
                }
            })
            .await;
        }

        TourneyWrite::Archive { tournament_id } => {
            write(TourneyAction::Archiving, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move { ctx.ports.tourney_organiser.archive(&tournament_id).await }
            })
            .await;
        }

        // Teams. Every one of these ends in the same reload, because forming a
        // team moves people between lists the response never mentions: a member
        // joining clears their outstanding requests everywhere, and the last
        // one leaving dissolves the team.
        TourneyWrite::CreateTeam {
            tournament_id,
            name,
        } => {
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

        TourneyWrite::RequestJoin {
            tournament_id,
            team_id,
        } => {
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

        TourneyWrite::CancelJoin {
            tournament_id,
            team_id,
        } => {
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

        TourneyWrite::RespondJoin {
            tournament_id,
            team_id,
            player_id,
            accept,
        } => {
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

        TourneyWrite::InviteToTeam {
            tournament_id,
            team_id,
            player_id,
        } => {
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

        TourneyWrite::RespondInvite {
            tournament_id,
            team_id,
            accept,
        } => {
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

        TourneyWrite::LeaveTeam { tournament_id } => {
            write(TourneyAction::LeavingTeam, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move { ctx.ports.tourney_entry.leave_team(&tournament_id).await }
            })
            .await;
        }

        TourneyWrite::DisbandTeam {
            tournament_id,
            team_id,
        } => {
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

        TourneyWrite::RenameTeam {
            tournament_id,
            team_id,
            name,
        } => {
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

        // The organiser's side of signing up. Adding and inviting go by FAF
        // name, which the server resolves against a real account: there is no
        // free-typed entrant, and that is what keeps an entry attached to
        // somebody the client can show an avatar and a rating for.
        TourneyWrite::AddPlayer {
            tournament_id,
            name,
            rating,
        } => {
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

        TourneyWrite::RespondSignup {
            tournament_id,
            player_id,
            accept,
        } => {
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

        TourneyWrite::RemovePlayer {
            tournament_id,
            player_id,
        } => {
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

        TourneyWrite::SetCaptain {
            tournament_id,
            team_id,
            player_id,
        } => {
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

        TourneyWrite::MovePlayer {
            tournament_id,
            player_id,
            team_id,
        } => {
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

        TourneyWrite::EditPlayer {
            tournament_id,
            player_id,
            note,
            rating,
        } => {
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

        TourneyWrite::InvitePlayer {
            tournament_id,
            name,
        } => {
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

        TourneyWrite::Uninvite {
            tournament_id,
            faf_id,
        } => {
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

        TourneyWrite::Reseed {
            tournament_id,
            order,
        } => {
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

        TourneyWrite::SplitDivisions {
            tournament_id,
            divisions,
        } => {
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

        TourneyWrite::SetDivision {
            tournament_id,
            team_id,
            division,
        } => {
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

        TourneyWrite::PostNews {
            tournament_id,
            body,
            important,
        } => {
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

        TourneyWrite::DeleteNews {
            tournament_id,
            news_id,
        } => {
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

        TourneyWrite::AssignPool {
            tournament_id,
            round_key,
            pool_id,
        } => {
            let action = TourneyAction::AssigningPool {
                round_key: round_key.clone(),
            };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move {
                    ctx.ports
                        .tourney_maps
                        .assign_pool(&tournament_id, &round_key, &pool_id)
                        .await
                }
            })
            .await;
        }

        TourneyWrite::DraftPickPlayer {
            tournament_id,
            player_id,
        } => {
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

        TourneyWrite::DraftUndo { tournament_id } => {
            write(TourneyAction::Drafting, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move { ctx.ports.tourney_entry.draft_undo(&tournament_id).await }
            })
            .await;
        }

        TourneyWrite::SetCaptains {
            tournament_id,
            player_ids,
        } => {
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

        TourneyWrite::ReportFfa {
            tournament_id,
            report,
        } => {
            let action = TourneyAction::ReportingFfa {
                match_id: report.match_id.clone(),
            };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move {
                    ctx.ports
                        .tourney_match
                        .report_ffa(&tournament_id, &report)
                        .await
                }
            })
            .await;
        }

        TourneyWrite::VetoAct {
            tournament_id,
            match_id,
            map_id,
        } => {
            let action = TourneyAction::Vetoing {
                match_id: match_id.clone(),
            };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move {
                    ctx.ports
                        .tourney_maps
                        .veto_act(&tournament_id, &match_id, &map_id)
                        .await
                }
            })
            .await;
        }

        TourneyWrite::VetoSetSides {
            tournament_id,
            match_id,
            team_a,
        } => {
            let action = TourneyAction::Vetoing {
                match_id: match_id.clone(),
            };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move {
                    ctx.ports
                        .tourney_maps
                        .veto_set_sides(&tournament_id, &match_id, &team_a)
                        .await
                }
            })
            .await;
        }

        TourneyWrite::VetoUndo {
            tournament_id,
            match_id,
        } => {
            let action = TourneyAction::Vetoing {
                match_id: match_id.clone(),
            };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move {
                    ctx.ports
                        .tourney_maps
                        .veto_undo(&tournament_id, &match_id)
                        .await
                }
            })
            .await;
        }

        TourneyWrite::FactionVeto {
            tournament_id,
            match_id,
            game,
            faction,
        } => {
            let action = TourneyAction::Vetoing {
                match_id: match_id.clone(),
            };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move {
                    ctx.ports
                        .tourney_maps
                        .faction_veto(&tournament_id, &match_id, game, faction)
                        .await
                }
            })
            .await;
        }

        TourneyWrite::SetFactionVeto {
            tournament_id,
            config,
        } => {
            write(TourneyAction::SavingFactionVeto, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move {
                    ctx.ports
                        .tourney_maps
                        .set_faction_veto(&tournament_id, &config)
                        .await
                }
            })
            .await;
        }

        TourneyWrite::Administer {
            tournament_id,
            change,
        } => {
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
        }

        TourneyWrite::SaveMap {
            tournament_id,
            mut map,
        } => {
            if let Some(preview) = out.with_state(|state| {
                let stored = state
                    .tourney
                    .open_event()
                    .map(|event| event.map_db.as_slice())
                    .unwrap_or_default();
                faf_domain::state::tourney::vault_preview_for_new_picture(
                    &map,
                    stored,
                    &state.maps.vault,
                    |vault| vault.display_name.as_str(),
                    |vault| vault.folder_name.as_str(),
                    |vault| vault.thumbnail_url_large.as_str(),
                )
                .map(str::to_owned)
            }) {
                map.image = Some(preview);
            }
            write(TourneyAction::SavingMap, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move { ctx.ports.tourney_maps.save_map(&tournament_id, &map).await }
            })
            .await;
        }

        TourneyWrite::PublishMap {
            tournament_id,
            map_id,
            published,
        } => {
            let action = TourneyAction::PublishingMap {
                map_id: map_id.clone(),
            };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move {
                    ctx.ports
                        .tourney_maps
                        .publish_map(&tournament_id, &map_id, published)
                        .await
                }
            })
            .await;
        }

        TourneyWrite::DeleteMap {
            tournament_id,
            map_id,
        } => {
            let action = TourneyAction::DeletingMap {
                map_id: map_id.clone(),
            };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move {
                    ctx.ports
                        .tourney_maps
                        .delete_map(&tournament_id, &map_id)
                        .await
                }
            })
            .await;
        }

        TourneyWrite::PublishPool {
            tournament_id,
            pool_id,
            published,
        } => {
            let action = TourneyAction::PublishingPool {
                pool_id: pool_id.clone(),
            };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move {
                    ctx.ports
                        .tourney_maps
                        .publish_pool(&tournament_id, &pool_id, published)
                        .await
                }
            })
            .await;
        }

        TourneyWrite::DeletePool {
            tournament_id,
            pool_id,
        } => {
            let action = TourneyAction::DeletingPool {
                pool_id: pool_id.clone(),
            };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move {
                    ctx.ports
                        .tourney_maps
                        .delete_pool(&tournament_id, &pool_id)
                        .await
                }
            })
            .await;
        }

        TourneyWrite::SavePool {
            tournament_id,
            pool,
        } => {
            write(TourneyAction::SavingPool, ctx, out, {
                let tournament_id = tournament_id.clone();
                let pool = trimmed(pool);
                async move {
                    ctx.ports
                        .tourney_maps
                        .save_pool(&tournament_id, &pool)
                        .await
                }
            })
            .await;
        }

        TourneyWrite::SaveSeries { draft } => {
            let draft = trimmed_series(draft);
            write_series(TourneyAction::SavingSeries, ctx, out, {
                let draft = draft.clone();
                async move { ctx.ports.tourney_organiser.save_series(&draft).await }
            })
            .await;
        }

        TourneyWrite::DeleteSeries { series_id } => {
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

        TourneyWrite::SetSeries {
            tournament_id,
            series_id,
        } => {
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

        TourneyWrite::AddQualifier {
            tournament_id,
            qualifier_id,
            rule,
        } => {
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

        TourneyWrite::RemoveQualifier {
            tournament_id,
            link_id,
        } => {
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

        TourneyWrite::EditFormat {
            tournament_id,
            format,
        } => {
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

        TourneyWrite::MuteChat {
            tournament_id,
            faf_id,
            name,
            muted,
        } => {
            // No room reload afterwards, unlike deleting a post below: muting
            // changes who may speak, not what has been said. The event reload
            // `write` ends with carries the muted list and `chatMutedMe`, which
            // is everything that moved.
            let action = TourneyAction::MutingChat { faf_id };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                let name = name.clone();
                async move {
                    ctx.ports
                        .tourney_chat
                        .mute_chat(&tournament_id, faf_id, &name, muted)
                        .await
                }
            })
            .await;
        }

        TourneyWrite::DeleteChatPost {
            tournament_id,
            room_id,
            post_id,
        } => {
            let action = TourneyAction::DeletingChatPost {
                post_id: post_id.clone(),
            };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                let room_id = room_id.clone();
                let post_id = post_id.clone();
                async move {
                    ctx.ports
                        .tourney_chat
                        .delete_chat_post(&tournament_id, &room_id, &post_id)
                        .await
                }
            })
            .await;
            // A deleted post is only gone once the room is read again: the
            // event reload above does not carry the conversation.
            read_room(&tournament_id, &room_id, ctx, out).await;
        }

        TourneyWrite::AddOrganiser {
            tournament_id,
            faf_id,
            name,
        } => {
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

        TourneyWrite::SetCaster {
            tournament_id,
            faf_id,
            name,
            casting,
        } => {
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

        TourneyWrite::SetOrganiserVisibility {
            tournament_id,
            faf_id,
            hidden,
        } => {
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

        TourneyWrite::Abandon {
            tournament_id,
            abandoned,
        } => {
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

        TourneyWrite::EditNews {
            tournament_id,
            news_id,
            body,
            important,
        } => {
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

        // A write like the rest, serial under the same key, but its own shape:
        // it reloads the room it posted in rather than the event.
        TourneyWrite::PostChat {
            tournament_id,
            room_id,
            body,
            reply_to,
        } => post_chat(tournament_id, room_id, body, reply_to, ctx, out).await,
    }
}

/// The event the pane is showing, read back out of the state.
fn open_event(out: &EventSink) -> Option<faf_domain::state::Tourney> {
    out.with_state(|state| state.tourney.open_event().cloned())
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

/// Drop the blank replay ids a form leaves behind.
///
/// The server counts them and refuses a report whose count does not match the
/// number of new games, so an empty row the player tabbed past would cost them
/// the submission for a reason they cannot see.
///
/// The winner and the forfeit are kept. They are the organiser's to send, and
/// this used to blank them as well, so every walkover and every declared
/// winner entered in the client reached the server as a bare match id.
fn clean(report: MatchReport) -> MatchReport {
    MatchReport {
        replay_ids: usable(report.replay_ids),
        draw_replay_ids: usable(report.draw_replay_ids),
        ..report
    }
}

fn usable(ids: Vec<String>) -> Vec<String> {
    ids.into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect()
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

fn trimmed(pool: PoolDraft) -> PoolDraft {
    PoolDraft {
        name: pool.name.trim().to_string(),
        ..pool
    }
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

/// Run one write, then resynchronise from the server.
///
/// The shared shape of every mutation: announce it so the pane can disable
/// itself, serialise it against the other writes, and on success reload both
/// the list and the open event. Reloading rather than patching is deliberate:
/// entering changes the entrant count, confirming a score advances the winner
/// and may finish the tournament, and none of that is in the response.
///
/// Which event to re-read is *not* a parameter: [`write_selecting`] reads it
/// back from the selection, so a caller cannot reload one event while the pane
/// shows another.
async fn write(
    action: TourneyAction,
    ctx: &ServiceCtx,
    out: &EventSink,
    // A future rather than a closure: async blocks are lazy, so the operation
    // still does not begin until the guard below is held.
    operation: impl std::future::Future<Output = Result<(), RequestError>>,
) {
    write_selecting(action, ctx, out, async { operation.await.map(|()| None) }).await;
}

/// A write whose answer names the event to open afterwards.
///
/// Creation is the only one that does: everything else acts on the event
/// already on screen, and the reload below re-reads whichever that is.
///
/// Every write, here and in [`write_series`] and the chat post, is serial in
/// the command policy (`Key::TourneyWrite`): the server recomputes the bracket
/// on every confirmed result, so two overlapping reports would each be
/// answered against a bracket the other has already moved.
async fn write_selecting(
    action: TourneyAction,
    ctx: &ServiceCtx,
    out: &EventSink,
    operation: impl std::future::Future<Output = Result<Option<String>, RequestError>>,
) {
    crate::runtime::expect_admitted(crate::runtime::Key::TourneyWrite);
    out.emit(TourneyEvent::ActionStarted {
        action: action.clone(),
    });

    match operation.await {
        Ok(select) => {
            out.emit(TourneyEvent::ActionSucceeded {
                action,
                select: select.clone(),
            });
            load(ctx, out).await;
            // `select` names a freshly created event; otherwise the open one is
            // the one that changed. Archiving leaves neither, and the list
            // reload above has already moved the selection on.
            let open = select.or_else(|| selected_id(out));
            if let Some(tournament_id) = open {
                load_detail(&tournament_id, ctx, out).await;
            }
        }
        Err(error) => out.emit(failed(action, &error)),
    }
}

/// Which event the pane is showing, read back after the reduce.
fn selected_id(out: &EventSink) -> Option<String> {
    out.with_state(|state| state.tourney.selected_id.clone())
}

/// A write against the series collection rather than against one tournament.
///
/// Reloads the series list instead of the event list, and re-reads the open
/// series where it survived: renaming one from its own page has to change the
/// heading above the editions, not only the row in the list behind it.
async fn write_series(
    action: TourneyAction,
    ctx: &ServiceCtx,
    out: &EventSink,
    operation: impl std::future::Future<Output = Result<(), RequestError>>,
) {
    crate::runtime::expect_admitted(crate::runtime::Key::TourneyWrite);
    out.emit(TourneyEvent::ActionStarted {
        action: action.clone(),
    });

    match operation.await {
        Ok(()) => {
            out.emit(TourneyEvent::ActionSucceeded {
                action,
                select: None,
            });
            load_series(ctx, out).await;
            // Deleting the open series drops it in the reduce above, so this
            // asks the state rather than assuming either way.
            if let Some(open) = out.with_state(|state| {
                state
                    .tourney
                    .open_series
                    .as_ref()
                    .map(|series| series.id.clone())
            }) {
                open_series(&open, ctx, out).await;
            }
            // Unfiling an edition changes the event too: its label goes.
            if let Some(tournament_id) = selected_id(out) {
                load_detail(&tournament_id, ctx, out).await;
            }
        }
        Err(error) => out.emit(failed(action, &error)),
    }
}

pub(super) fn failed(action: TourneyAction, error: &RequestError) -> TourneyEvent {
    TourneyEvent::ActionFailed {
        failure: TourneyActionFailure {
            action,
            reason: error.to_string(),
            kind: error.kind(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_phase_step_is_only_offered_where_the_server_takes_it() {
        use faf_domain::state::{TourneyPhase, TourneyStatus};
        assert!(TourneyPhase::FormTeams.is_legal_from(TourneyStatus::Signup));
        assert!(!TourneyPhase::FormTeams.is_legal_from(TourneyStatus::Drafted));
        assert!(TourneyPhase::StartBracket.is_legal_from(TourneyStatus::Drafted));
        assert!(!TourneyPhase::StartBracket.is_legal_from(TourneyStatus::Running));
        // Reopening is the undo, and it stops working once anything was played.
        assert!(TourneyPhase::ReopenSignups.is_legal_from(TourneyStatus::Drafted));
        assert!(!TourneyPhase::ReopenSignups.is_legal_from(TourneyStatus::Running));
    }

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

    #[test]
    fn blank_replay_rows_never_reach_the_server() {
        // The server counts these against the number of new games, so an empty
        // row the player tabbed past would cost them the submission for a
        // reason the form never showed them.
        let cleaned = clean(MatchReport {
            match_id: "m1".into(),
            score1: 2,
            score2: 0,
            replay_ids: vec!["  22334455 ".into(), String::new(), "   ".into()],
            draw_replay_ids: vec!["".into()],
            winner: None,
            forfeit: None,
        });
        assert_eq!(cleaned.replay_ids, vec!["22334455".to_string()]);
        assert!(cleaned.draw_replay_ids.is_empty());
    }
}
