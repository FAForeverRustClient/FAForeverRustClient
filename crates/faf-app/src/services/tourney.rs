//! Tournament orchestration: reading the list, entering an event, playing it.
//!
//! Reads and writes have different shapes. A read is fire-and-forget with a
//! generation token, so only the newest answer lands. A write is serialised and
//! always ends by reloading from the server rather than patching the local
//! copy: confirming a score moves the winner into the next match, eliminates
//! the loser and can finish the tournament outright, and none of that is in the
//! response. Any local simulation of it would drift within one round.

use faf_domain::state::{
    MatchReport, PoolDraft, SeedOrder, SeriesDraft, TourneyAction, TourneyActionFailure,
    TourneyCommand, TourneyDraft, TourneyEvent,
};

use crate::ports::RequestError;
use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: TourneyCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        TourneyCommand::Load => load(ctx, out).await,

        TourneyCommand::Select { tournament_id } => {
            out.emit(TourneyEvent::Selected {
                tournament_id: tournament_id.clone(),
            });
            // Selecting is what makes a detail worth having; requiring the UI to
            // dispatch both would let the two drift apart.
            load_detail(&tournament_id, ctx, out).await;
        }

        TourneyCommand::SignUp { tournament_id } => {
            write(TourneyAction::SigningUp, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move { ctx.ports.tourney.sign_up(&tournament_id).await }
            })
            .await;
        }

        TourneyCommand::Withdraw { tournament_id } => {
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
                async move { ctx.ports.tourney.withdraw(&tournament_id, &player_id).await }
            })
            .await;
        }

        TourneyCommand::CheckIn { tournament_id } => {
            write(TourneyAction::CheckingIn, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move { ctx.ports.tourney.check_in(&tournament_id).await }
            })
            .await;
        }

        TourneyCommand::AnswerReport {
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
                        .tourney
                        .confirm_report(&tournament_id, &match_id, accept)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::DecideReport {
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
                        .tourney
                        .decide_report(&tournament_id, &report)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::LoadChat { tournament_id } => load_rooms(&tournament_id, ctx, out).await,

        TourneyCommand::OpenRoom {
            tournament_id,
            room_id,
        } => {
            out.emit(TourneyEvent::RoomOpened {
                room_id: room_id.clone(),
            });
            read_room(&tournament_id, &room_id, ctx, out).await;
        }

        TourneyCommand::RefreshChat {
            tournament_id,
            room_id,
        } => {
            // Both halves, because they answer different questions: the room
            // is what is being read, and the list carries the unread counts,
            // the `@` marks and the organiser bells for every other room.
            //
            // Silent throughout. A failed poll is logged and dropped rather
            // than shown: the room on screen is still the last good one, and a
            // banner every few seconds on a flaky connection would be worse
            // than the gap it reports.
            match ctx.ports.tourney.chat_read(&tournament_id, &room_id).await {
                Ok(posts) => out.emit(TourneyEvent::ChatLoaded { room_id, posts }),
                Err(error) => {
                    tracing::debug!(%error, "a tournament chat poll came back empty-handed");
                    return;
                }
            }
            if let Ok(rooms) = ctx.ports.tourney.chat_rooms(&tournament_id).await {
                out.emit(TourneyEvent::ChatRoomsLoaded { rooms });
            }
        }

        TourneyCommand::PostChat {
            tournament_id,
            room_id,
            body,
        } => {
            if body.trim().is_empty() {
                return;
            }
            let action = TourneyAction::PostingChat {
                room_id: room_id.clone(),
            };
            // A post reloads the room rather than the whole tournament: nothing
            // about the bracket changed, and refetching it would make typing a
            // message the most expensive thing in the tab.
            out.emit(TourneyEvent::ActionStarted {
                action: action.clone(),
            });
            let _guard = ctx.tourney_mutation.acquire().await;
            match ctx
                .ports
                .tourney
                .chat_post(&tournament_id, &room_id, body.trim())
                .await
            {
                Ok(()) => {
                    out.emit(TourneyEvent::ActionSucceeded {
                        action,
                        select: None,
                    });
                    read_room(&tournament_id, &room_id, ctx, out).await;
                    load_rooms(&tournament_id, ctx, out).await;
                }
                Err(error) => out.emit(failed(action, &error)),
            }
        }

        TourneyCommand::LoadHosting => match ctx.ports.tourney.hosting().await {
            Ok(hosting) => out.emit(TourneyEvent::HostingLoaded { hosting }),
            // Silent: not knowing means the create button stays hidden, which
            // is the same as not being allowed and is the safer of the two.
            Err(error) => tracing::warn!(%error, "could not read the hosting status"),
        },

        TourneyCommand::SearchAccounts { query } => search_accounts(&query, ctx, out).await,

        TourneyCommand::ClearAccountSearch => {
            // Bump the generation as well as clearing: a request already in
            // flight must not repopulate the list after the organiser picked
            // somebody and the field closed.
            ctx.tourney_account_search_generation.begin();
            out.emit(TourneyEvent::AccountSearchCleared);
        }

        TourneyCommand::Create { draft } => {
            write_selecting(TourneyAction::Creating, ctx, out, {
                let draft = trimmed_draft(draft);
                async move { ctx.ports.tourney.create(&draft).await.map(Some) }
            })
            .await;
        }

        TourneyCommand::EditInfo {
            tournament_id,
            draft,
        } => {
            write(TourneyAction::Editing, ctx, out, {
                let tournament_id = tournament_id.clone();
                let draft = trimmed_draft(draft);
                async move { ctx.ports.tourney.edit_info(&tournament_id, &draft).await }
            })
            .await;
        }

        TourneyCommand::Publish { tournament_id } => {
            write(TourneyAction::Publishing, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move { ctx.ports.tourney.publish(&tournament_id).await }
            })
            .await;
        }

        TourneyCommand::Advance {
            tournament_id,
            phase,
            config,
        } => {
            write(TourneyAction::Advancing { phase }, ctx, out, {
                let tournament_id = tournament_id.clone();
                let config = config.clone();
                async move {
                    ctx.ports
                        .tourney
                        .advance(&tournament_id, phase, config.as_ref())
                        .await
                }
            })
            .await;
        }

        TourneyCommand::Archive { tournament_id } => {
            write(TourneyAction::Archiving, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move { ctx.ports.tourney.archive(&tournament_id).await }
            })
            .await;
        }

        // Teams. Every one of these ends in the same reload, because forming a
        // team moves people between lists the response never mentions: a member
        // joining clears their outstanding requests everywhere, and the last
        // one leaving dissolves the team.
        TourneyCommand::CreateTeam {
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
                        .tourney
                        .create_team(&tournament_id, name.trim())
                        .await
                }
            })
            .await;
        }

        TourneyCommand::RequestJoin {
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
                        .tourney
                        .request_join(&tournament_id, &team_id)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::CancelJoin {
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
                        .tourney
                        .cancel_join(&tournament_id, &team_id)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::RespondJoin {
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
                        .tourney
                        .respond_join(&tournament_id, &team_id, &player_id, accept)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::InviteToTeam {
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
                        .tourney
                        .invite_to_team(&tournament_id, &team_id, &player_id)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::RespondInvite {
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
                        .tourney
                        .respond_invite(&tournament_id, &team_id, accept)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::LeaveTeam { tournament_id } => {
            write(TourneyAction::LeavingTeam, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move { ctx.ports.tourney.leave_team(&tournament_id).await }
            })
            .await;
        }

        TourneyCommand::DisbandTeam {
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
                        .tourney
                        .disband_team(&tournament_id, &team_id)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::RenameTeam {
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
                        .tourney
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
        TourneyCommand::AddPlayer {
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
                        .tourney
                        .add_player(&tournament_id, name.trim(), rating)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::RespondSignup {
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
                        .tourney
                        .respond_signup(&tournament_id, &player_id, accept)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::RemovePlayer {
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
                async move { ctx.ports.tourney.withdraw(&tournament_id, &player_id).await }
            })
            .await;
        }

        TourneyCommand::SetCaptain {
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
                        .tourney
                        .set_captain(&tournament_id, &team_id, &player_id)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::MovePlayer {
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
                        .tourney
                        .move_player(&tournament_id, &player_id, team_id.as_deref())
                        .await
                }
            })
            .await;
        }

        TourneyCommand::EditPlayer {
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
                        .tourney
                        .edit_player(&tournament_id, &player_id, &note, rating)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::InvitePlayer {
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
                        .tourney
                        .invite_player(&tournament_id, name.trim())
                        .await
                }
            })
            .await;
        }

        TourneyCommand::Uninvite {
            tournament_id,
            faf_id,
        } => {
            write(TourneyAction::Inviting, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move { ctx.ports.tourney.uninvite(&tournament_id, faf_id).await }
            })
            .await;
        }

        TourneyCommand::Reseed {
            tournament_id,
            order,
        } => {
            write(TourneyAction::Reseeding, ctx, out, {
                let tournament_id = tournament_id.clone();
                let order = tidy_order(order);
                async move { ctx.ports.tourney.reseed(&tournament_id, &order).await }
            })
            .await;
        }

        TourneyCommand::SplitDivisions {
            tournament_id,
            divisions,
        } => {
            write(TourneyAction::Dividing, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move {
                    ctx.ports
                        .tourney
                        .split_divisions(&tournament_id, divisions.clamp(1, 6))
                        .await
                }
            })
            .await;
        }

        TourneyCommand::SetDivision {
            tournament_id,
            team_id,
            division,
        } => {
            write(TourneyAction::Dividing, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move {
                    ctx.ports
                        .tourney
                        .set_division(&tournament_id, &team_id, division)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::PostNews {
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
                        .tourney
                        .post_news(&tournament_id, body.trim(), important)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::DeleteNews {
            tournament_id,
            news_id,
        } => {
            write(TourneyAction::PostingNews, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move {
                    ctx.ports
                        .tourney
                        .delete_news(&tournament_id, &news_id)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::LoadArticles => match ctx.ports.tourney.articles().await {
            Ok(articles) => out.emit(TourneyEvent::ArticlesLoaded { articles }),
            // Silent: the rules pages are supporting text, and an error banner
            // over a working bracket because a FAQ did not load would be noise.
            Err(error) => tracing::warn!(%error, "could not load the tournament rules pages"),
        },

        TourneyCommand::AssignPool {
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
                        .tourney
                        .assign_pool(&tournament_id, &round_key, &pool_id)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::DraftPickPlayer {
            tournament_id,
            player_id,
        } => {
            write(TourneyAction::Drafting, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move {
                    ctx.ports
                        .tourney
                        .draft_pick(&tournament_id, &player_id)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::DraftUndo { tournament_id } => {
            write(TourneyAction::Drafting, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move { ctx.ports.tourney.draft_undo(&tournament_id).await }
            })
            .await;
        }

        TourneyCommand::SetCaptains {
            tournament_id,
            player_ids,
        } => {
            write(TourneyAction::Drafting, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move {
                    ctx.ports
                        .tourney
                        .set_captains(&tournament_id, &player_ids)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::ReportFfa {
            tournament_id,
            report,
        } => {
            let action = TourneyAction::ReportingFfa {
                match_id: report.match_id.clone(),
            };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move { ctx.ports.tourney.report_ffa(&tournament_id, &report).await }
            })
            .await;
        }

        TourneyCommand::VetoAct {
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
                        .tourney
                        .veto_act(&tournament_id, &match_id, &map_id)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::VetoSetSides {
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
                        .tourney
                        .veto_set_sides(&tournament_id, &match_id, &team_a)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::VetoUndo {
            tournament_id,
            match_id,
        } => {
            let action = TourneyAction::Vetoing {
                match_id: match_id.clone(),
            };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move { ctx.ports.tourney.veto_undo(&tournament_id, &match_id).await }
            })
            .await;
        }

        TourneyCommand::SaveMap { tournament_id, map } => {
            write(TourneyAction::SavingMap, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move { ctx.ports.tourney.save_map(&tournament_id, &map).await }
            })
            .await;
        }

        TourneyCommand::PublishMap {
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
                        .tourney
                        .publish_map(&tournament_id, &map_id, published)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::DeleteMap {
            tournament_id,
            map_id,
        } => {
            let action = TourneyAction::DeletingMap {
                map_id: map_id.clone(),
            };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move { ctx.ports.tourney.delete_map(&tournament_id, &map_id).await }
            })
            .await;
        }

        TourneyCommand::PublishPool {
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
                        .tourney
                        .publish_pool(&tournament_id, &pool_id, published)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::DeletePool {
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
                        .tourney
                        .delete_pool(&tournament_id, &pool_id)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::SavePool {
            tournament_id,
            pool,
        } => {
            write(TourneyAction::SavingPool, ctx, out, {
                let tournament_id = tournament_id.clone();
                let pool = trimmed(pool);
                async move { ctx.ports.tourney.save_pool(&tournament_id, &pool).await }
            })
            .await;
        }

        TourneyCommand::LoadSeries => load_series(ctx, out).await,

        TourneyCommand::OpenSeries { series_id } => open_series(&series_id, ctx, out).await,

        TourneyCommand::CloseSeries => out.emit(TourneyEvent::SeriesClosed),

        TourneyCommand::SaveSeries { draft } => {
            let draft = trimmed_series(draft);
            write_series(TourneyAction::SavingSeries, ctx, out, {
                let draft = draft.clone();
                async move { ctx.ports.tourney.save_series(&draft).await }
            })
            .await;
        }

        TourneyCommand::DeleteSeries { series_id } => {
            let action = TourneyAction::DeletingSeries {
                series_id: series_id.clone(),
            };
            // The open series is the one being deleted more often than not, so
            // it is closed before the reload rather than after: a detail pane
            // showing a series the next list will not contain is a flicker of
            // something that no longer exists.
            write_series(action, ctx, out, {
                let series_id = series_id.clone();
                async move { ctx.ports.tourney.delete_series(&series_id).await }
            })
            .await;
        }

        TourneyCommand::SetSeries {
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
                        .tourney
                        .set_series(&tournament_id, series_id.as_deref())
                        .await
                }
            })
            .await;
            load_series(ctx, out).await;
        }

        TourneyCommand::AddQualifier {
            tournament_id,
            qualifier_id,
            rule,
        } => {
            write(TourneyAction::AddingQualifier, ctx, out, {
                let tournament_id = tournament_id.clone();
                let qualifier_id = qualifier_id.clone();
                async move {
                    ctx.ports
                        .tourney
                        .add_qualifier(&tournament_id, &qualifier_id, rule)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::RemoveQualifier {
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
                        .tourney
                        .remove_qualifier(&tournament_id, &link_id)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::EditFormat {
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
                        .tourney
                        .edit_format(&tournament_id, &format, structural)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::MuteChat {
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
                        .tourney
                        .mute_chat(&tournament_id, faf_id, &name, muted)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::DeleteChatPost {
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
                        .tourney
                        .delete_chat_post(&tournament_id, &room_id, &post_id)
                        .await
                }
            })
            .await;
            // A deleted post is only gone once the room is read again: the
            // event reload above does not carry the conversation.
            read_room(&tournament_id, &room_id, ctx, out).await;
        }

        TourneyCommand::AddOrganiser {
            tournament_id,
            faf_id,
            name,
        } => {
            write(TourneyAction::AddingOrganiser, ctx, out, {
                let tournament_id = tournament_id.clone();
                let name = name.clone();
                async move {
                    ctx.ports
                        .tourney
                        .add_organiser(&tournament_id, faf_id, &name)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::SetCaster {
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
                        .tourney
                        .set_caster(&tournament_id, faf_id, &name, casting)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::SetOrganiserVisibility {
            tournament_id,
            faf_id,
            hidden,
        } => {
            let action = TourneyAction::SettingOrganiserVisibility { faf_id };
            write(action, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move {
                    ctx.ports
                        .tourney
                        .set_organiser_visibility(&tournament_id, faf_id, hidden)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::Abandon {
            tournament_id,
            abandoned,
        } => {
            write(TourneyAction::Abandoning, ctx, out, {
                let tournament_id = tournament_id.clone();
                async move { ctx.ports.tourney.abandon(&tournament_id, abandoned).await }
            })
            .await;
        }

        TourneyCommand::EditNews {
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
                        .tourney
                        .edit_news(&tournament_id, &news_id, &body, important)
                        .await
                }
            })
            .await;
        }

        TourneyCommand::MarkNewsRead { tournament_id } => {
            // Deliberately not a `write`: nothing on screen changes except a
            // badge, and announcing it would blank the pane and reload the list
            // for an act the reader did not ask for. A failure is logged rather
            // than shown, for the same reason: the badge staying is not worth an
            // error banner over the announcements it belongs to.
            if let Err(error) = ctx.ports.tourney.mark_news_read(&tournament_id).await {
                tracing::warn!(%error, "could not mark the tournament news as read");
                return;
            }
            load_detail(&tournament_id, ctx, out).await;
        }

        TourneyCommand::DismissActionError => out.emit(TourneyEvent::ActionErrorDismissed),
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
fn clean(report: MatchReport) -> MatchReport {
    MatchReport {
        replay_ids: usable(report.replay_ids),
        draw_replay_ids: usable(report.draw_replay_ids),
        winner: None,
        forfeit: None,
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

async fn load(ctx: &ServiceCtx, out: &EventSink) {
    out.emit(TourneyEvent::Loading);
    match ctx.ports.tourney.list().await {
        Ok(mut events) => {
            // Sorted here rather than in the view, because ordering is part of
            // the state every consumer shares. Signups come first, being the
            // one thing a player can still act on, then running, then the rest,
            // newest first within each group.
            events.sort_by(|left, right| {
                rank(left.status)
                    .cmp(&rank(right.status))
                    .then_with(|| right.event_date.cmp(&left.event_date))
                    .then_with(|| right.created_at.cmp(&left.created_at))
            });
            out.emit(TourneyEvent::Loaded { events });
        }
        Err(error) => out.emit(TourneyEvent::LoadFailed {
            reason: error.to_string(),
            kind: error.kind(),
        }),
    }
}

/// Sort order for the list: what a player can still do something about first.
fn rank(status: faf_domain::state::TourneyStatus) -> u8 {
    use faf_domain::state::TourneyStatus::*;
    match status {
        Signup => 0,
        Running => 1,
        Drafted => 2,
        Draft => 3,
        Finished => 4,
        Unknown => 5,
    }
}

async fn load_detail(tournament_id: &str, ctx: &ServiceCtx, out: &EventSink) {
    let generation = ctx.tourney_detail_generation.begin();
    out.emit(TourneyEvent::DetailLoading);

    let loaded = ctx.ports.tourney.detail(tournament_id).await;
    if !ctx.tourney_detail_generation.is_current(generation) {
        // A newer selection is already in flight; emitting now would overwrite
        // its state with an older event's bracket.
        return;
    }
    match loaded {
        Ok(event) => {
            let accounts: Vec<i32> = event
                .players
                .iter()
                .filter_map(|player| player.faf_id)
                .collect();
            out.emit(TourneyEvent::DetailLoaded {
                event: Box::new(event),
            });
            load_entrant_profiles(&accounts, generation, ctx, out).await;
        }
        Err(error) => out.emit(TourneyEvent::DetailLoadFailed {
            reason: error.to_string(),
            kind: error.kind(),
        }),
    }
}

/// Fetch the FAF accounts behind the entrants that carry one.
///
/// A second request after the detail rather than part of it, because the two
/// come from different services: the tournament service owns the entry, FAF
/// owns the player. A failure here is silent on purpose: the bracket is
/// complete without avatars, and an error banner over a working tournament
/// because a decoration did not load would be noise.
async fn load_entrant_profiles(
    accounts: &[i32],
    generation: u64,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    if accounts.is_empty() {
        out.emit(TourneyEvent::EntrantProfilesLoaded { profiles: vec![] });
        return;
    }
    match ctx.ports.player_card.players_by_id(accounts).await {
        Ok(profiles) => {
            if ctx.tourney_detail_generation.is_current(generation) {
                out.emit(TourneyEvent::EntrantProfilesLoaded { profiles });
            }
        }
        Err(error) => tracing::warn!(%error, "could not load the entrants' FAF profiles"),
    }
}

/// The shortest query worth asking the API about.
///
/// One letter matches a large share of the player base, and the list it returns
/// is useless to pick from while costing a full request per keystroke.
const MIN_ACCOUNT_QUERY: usize = 2;

/// FAF accounts whose name starts with what the organiser typed.
///
/// Deliberately the *same* lookup the player card's picker uses
/// (`PlayerCardPort::search_players`), not a tournament-specific one: an entrant
/// is a FAF account, and the client already knows how to find and show one. The
/// tournament service has no player search of its own worth using: it matches
/// names exactly and answers "no such player", which is the refusal this
/// removes.
async fn search_accounts(query: &str, ctx: &ServiceCtx, out: &EventSink) {
    let trimmed = query.trim();
    if trimmed.chars().count() < MIN_ACCOUNT_QUERY {
        // Bump the generation too, so an answer for a longer query typed a
        // moment ago cannot land on the now-cleared field.
        ctx.tourney_account_search_generation.begin();
        out.emit(TourneyEvent::AccountSearchCleared);
        return;
    }
    let generation = ctx.tourney_account_search_generation.begin();
    out.emit(TourneyEvent::AccountSearchStarted {
        query: trimmed.to_string(),
    });

    let found = ctx
        .ports
        .player_card
        .search_players(trimmed, ACCOUNT_SEARCH_LIMIT)
        .await;
    if !ctx.tourney_account_search_generation.is_current(generation) {
        return;
    }
    match found {
        Ok(matches) => out.emit(TourneyEvent::AccountSearchLoaded {
            query: trimmed.to_string(),
            matches,
        }),
        // Said out loud rather than swallowed: unlike the avatars, this one is
        // the answer to something the organiser just did, and an empty list that
        // means "your session expired" would send them hunting for a typo.
        Err(error) => out.emit(TourneyEvent::AccountSearchFailed {
            query: trimmed.to_string(),
            reason: error.to_string(),
            kind: error.kind(),
        }),
    }
}

/// Enough rows to recognise the right person among similar names, few enough to
/// scan without scrolling.
const ACCOUNT_SEARCH_LIMIT: i32 = 8;

/// The rooms of the open event.
///
/// Silent on failure for the same reason as the profiles: chat is beside the
/// bracket, not the point of it.
async fn load_rooms(tournament_id: &str, ctx: &ServiceCtx, out: &EventSink) {
    match ctx.ports.tourney.chat_rooms(tournament_id).await {
        Ok(rooms) => out.emit(TourneyEvent::ChatRoomsLoaded { rooms }),
        Err(error) => tracing::warn!(%error, "could not load the tournament chat rooms"),
    }
}

async fn read_room(tournament_id: &str, room_id: &str, ctx: &ServiceCtx, out: &EventSink) {
    let generation = ctx.tourney_chat_generation.begin();
    out.emit(TourneyEvent::ChatLoading);

    let read = ctx.ports.tourney.chat_read(tournament_id, room_id).await;
    if !ctx.tourney_chat_generation.is_current(generation) {
        return;
    }
    match read {
        Ok(posts) => out.emit(TourneyEvent::ChatLoaded {
            room_id: room_id.to_string(),
            posts,
        }),
        Err(error) => out.emit(TourneyEvent::ChatFailed {
            reason: error.to_string(),
            kind: error.kind(),
        }),
    }
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
async fn write_selecting(
    action: TourneyAction,
    ctx: &ServiceCtx,
    out: &EventSink,
    operation: impl std::future::Future<Output = Result<Option<String>, RequestError>>,
) {
    out.emit(TourneyEvent::ActionStarted {
        action: action.clone(),
    });
    let _guard = ctx.tourney_mutation.acquire().await;

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

async fn load_series(ctx: &ServiceCtx, out: &EventSink) {
    out.emit(TourneyEvent::SeriesLoading);
    match ctx.ports.tourney.series().await {
        Ok(series) => out.emit(TourneyEvent::SeriesLoaded { series }),
        Err(error) => out.emit(TourneyEvent::SeriesFailed {
            reason: error.to_string(),
            kind: error.kind(),
        }),
    }
}

async fn open_series(series_id: &str, ctx: &ServiceCtx, out: &EventSink) {
    match ctx.ports.tourney.series_detail(series_id).await {
        Ok(detail) => out.emit(TourneyEvent::SeriesOpened {
            detail: Box::new(detail),
        }),
        // Reported through the list's own status rather than swallowed: the
        // pane it would have filled stays empty otherwise, with nothing saying
        // why.
        Err(error) => out.emit(TourneyEvent::SeriesFailed {
            reason: error.to_string(),
            kind: error.kind(),
        }),
    }
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
    out.emit(TourneyEvent::ActionStarted {
        action: action.clone(),
    });
    let _guard = ctx.tourney_mutation.acquire().await;

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

fn failed(action: TourneyAction, error: &RequestError) -> TourneyEvent {
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
    use faf_domain::state::TourneyStatus;

    #[test]
    fn the_list_puts_what_a_player_can_still_join_first() {
        let mut order = [
            TourneyStatus::Finished,
            TourneyStatus::Draft,
            TourneyStatus::Signup,
            TourneyStatus::Running,
            TourneyStatus::Drafted,
        ];
        order.sort_by_key(|status| rank(*status));
        assert_eq!(
            order,
            [
                TourneyStatus::Signup,
                TourneyStatus::Running,
                TourneyStatus::Drafted,
                TourneyStatus::Draft,
                TourneyStatus::Finished,
            ]
        );
    }

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
