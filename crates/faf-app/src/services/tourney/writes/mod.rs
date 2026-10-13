//! Tournament writes: every command that changes an event, its entrants, its
//! teams, maps, pools and news, or the series, and the helpers that announce
//! each one, run it under the shared write serialisation and reload from the
//! server afterwards. The chat post comes through here like every other write
//! and is run by `chat`, which owns the room it reloads.
//!
//! `handle` routes each write to the module for its area, and the helpers
//! every one of them runs through stay here, so a write has the same shape
//! whichever module it is in:
//!
//! - `entry`: signing up, withdrawing, checking in, and the organiser's
//!   changes to who has entered.
//! - `teams`: forming and leaving teams, captains, and the draft.
//! - `matches`: the event's phase and its results.
//! - `maps`: the map database, pools and their rounds, and the vetoes.
//! - `organiser`: creating and editing an event, its format, publishing,
//!   seeding, the admin console, staff, news and qualifiers.
//! - `series`: the series, and which one an event is filed under.
//! - `moderation`: muting in chat, and deleting a post.
//! - `site`: the site's own pages and consoles.

mod entry;
mod maps;
mod matches;
mod moderation;
mod organiser;
mod series;
mod site;
mod teams;

use faf_domain::state::{TourneyAction, TourneyActionFailure, TourneyEvent, TourneyWrite};

use crate::ports::RequestError;
use crate::runtime::{EventSink, ServiceCtx};

use super::chat::post_chat;
use super::reads::{load, load_detail, load_series, open_series};

/// Every write. Exhaustive over [`TourneyWrite`], so a new write does not
/// compile until it has an arm here.
pub(super) async fn handle(cmd: TourneyWrite, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        TourneyWrite::SignUp {
            tournament_id,
            rating,
        } => entry::sign_up(tournament_id, rating, ctx, out).await,
        TourneyWrite::DeclineInvite { tournament_id } => {
            entry::decline_invite(tournament_id, ctx, out).await
        }
        TourneyWrite::Withdraw { tournament_id } => entry::withdraw(tournament_id, ctx, out).await,
        TourneyWrite::CheckIn {
            tournament_id,
            checked_in,
        } => entry::check_in(tournament_id, checked_in, ctx, out).await,
        TourneyWrite::AddPlayer {
            tournament_id,
            name,
            rating,
        } => entry::add_player(tournament_id, name, rating, ctx, out).await,
        TourneyWrite::RespondSignup {
            tournament_id,
            player_id,
            accept,
        } => entry::respond_signup(tournament_id, player_id, accept, ctx, out).await,
        TourneyWrite::RemovePlayer {
            tournament_id,
            player_id,
        } => entry::remove_player(tournament_id, player_id, ctx, out).await,
        TourneyWrite::BanPlayer {
            tournament_id,
            player_id,
            faf_id,
            name,
            reason,
            expires,
            remove,
        } => {
            entry::ban_player(
                tournament_id,
                player_id,
                faf_id,
                name,
                reason,
                expires,
                remove,
                ctx,
                out,
            )
            .await
        }
        TourneyWrite::EditPlayer {
            tournament_id,
            player_id,
            note,
            rating,
        } => entry::edit_player(tournament_id, player_id, note, rating, ctx, out).await,
        TourneyWrite::InvitePlayer {
            tournament_id,
            name,
        } => entry::invite_player(tournament_id, name, ctx, out).await,
        TourneyWrite::Uninvite {
            tournament_id,
            faf_id,
        } => entry::uninvite(tournament_id, faf_id, ctx, out).await,

        TourneyWrite::CreateTeam {
            tournament_id,
            name,
        } => teams::create_team(tournament_id, name, ctx, out).await,
        TourneyWrite::RequestJoin {
            tournament_id,
            team_id,
        } => teams::request_join(tournament_id, team_id, ctx, out).await,
        TourneyWrite::CancelJoin {
            tournament_id,
            team_id,
        } => teams::cancel_join(tournament_id, team_id, ctx, out).await,
        TourneyWrite::RespondJoin {
            tournament_id,
            team_id,
            player_id,
            accept,
        } => teams::respond_join(tournament_id, team_id, player_id, accept, ctx, out).await,
        TourneyWrite::InviteToTeam {
            tournament_id,
            team_id,
            player_id,
        } => teams::invite_to_team(tournament_id, team_id, player_id, ctx, out).await,
        TourneyWrite::RespondInvite {
            tournament_id,
            team_id,
            accept,
        } => teams::respond_invite(tournament_id, team_id, accept, ctx, out).await,
        TourneyWrite::LeaveTeam { tournament_id } => {
            teams::leave_team(tournament_id, ctx, out).await
        }
        TourneyWrite::DisbandTeam {
            tournament_id,
            team_id,
        } => teams::disband_team(tournament_id, team_id, ctx, out).await,
        TourneyWrite::RenameTeam {
            tournament_id,
            team_id,
            name,
        } => teams::rename_team(tournament_id, team_id, name, ctx, out).await,
        TourneyWrite::SetCaptain {
            tournament_id,
            team_id,
            player_id,
        } => teams::set_captain(tournament_id, team_id, player_id, ctx, out).await,
        TourneyWrite::MovePlayer {
            tournament_id,
            player_id,
            team_id,
        } => teams::move_player(tournament_id, player_id, team_id, ctx, out).await,
        TourneyWrite::DraftPickPlayer {
            tournament_id,
            player_id,
        } => teams::draft_pick_player(tournament_id, player_id, ctx, out).await,
        TourneyWrite::DraftUndo { tournament_id } => {
            teams::draft_undo(tournament_id, ctx, out).await
        }
        TourneyWrite::SetCaptains {
            tournament_id,
            player_ids,
        } => teams::set_captains(tournament_id, player_ids, ctx, out).await,

        TourneyWrite::Advance {
            tournament_id,
            phase,
            config,
        } => matches::advance(tournament_id, phase, config, ctx, out).await,
        TourneyWrite::AnswerReport {
            tournament_id,
            match_id,
            accept,
        } => matches::answer_report(tournament_id, match_id, accept, ctx, out).await,
        TourneyWrite::DecideReport {
            tournament_id,
            report,
        } => matches::decide_report(tournament_id, report, ctx, out).await,
        TourneyWrite::SubmitReport {
            tournament_id,
            report,
        } => matches::submit_report(tournament_id, report, ctx, out).await,
        TourneyWrite::ReportFfa {
            tournament_id,
            report,
        } => matches::report_ffa(tournament_id, report, ctx, out).await,

        TourneyWrite::SaveMap { tournament_id, map } => {
            maps::save_map(tournament_id, map, ctx, out).await
        }
        TourneyWrite::PublishMap {
            tournament_id,
            map_id,
            published,
        } => maps::publish_map(tournament_id, map_id, published, ctx, out).await,
        TourneyWrite::DeleteMap {
            tournament_id,
            map_id,
        } => maps::delete_map(tournament_id, map_id, ctx, out).await,
        TourneyWrite::SavePool {
            tournament_id,
            pool,
        } => maps::save_pool(tournament_id, pool, ctx, out).await,
        TourneyWrite::PublishPool {
            tournament_id,
            pool_id,
            published,
        } => maps::publish_pool(tournament_id, pool_id, published, ctx, out).await,
        TourneyWrite::DeletePool {
            tournament_id,
            pool_id,
        } => maps::delete_pool(tournament_id, pool_id, ctx, out).await,
        TourneyWrite::AssignPool {
            tournament_id,
            round_key,
            pool_id,
        } => maps::assign_pool(tournament_id, round_key, pool_id, ctx, out).await,
        TourneyWrite::VetoAct {
            tournament_id,
            match_id,
            map_id,
        } => maps::veto_act(tournament_id, match_id, map_id, ctx, out).await,
        TourneyWrite::VetoSetSides {
            tournament_id,
            match_id,
            team_a,
        } => maps::veto_set_sides(tournament_id, match_id, team_a, ctx, out).await,
        TourneyWrite::VetoUndo {
            tournament_id,
            match_id,
        } => maps::veto_undo(tournament_id, match_id, ctx, out).await,
        TourneyWrite::FactionVeto {
            tournament_id,
            match_id,
            game,
            faction,
        } => maps::faction_veto(tournament_id, match_id, game, faction, ctx, out).await,
        TourneyWrite::SetFactionVeto {
            tournament_id,
            config,
        } => maps::set_faction_veto(tournament_id, config, ctx, out).await,

        TourneyWrite::Create { draft } => organiser::create(draft, ctx, out).await,
        TourneyWrite::UploadDescImage {
            tournament_id,
            data_url,
            request_id,
        } => organiser::upload_desc_image(tournament_id, data_url, request_id, ctx, out).await,
        TourneyWrite::EditInfo {
            tournament_id,
            draft,
        } => organiser::edit_info(tournament_id, draft, ctx, out).await,
        TourneyWrite::EditFormat {
            tournament_id,
            format,
        } => organiser::edit_format(tournament_id, format, ctx, out).await,
        TourneyWrite::Publish { tournament_id } => {
            organiser::publish(tournament_id, ctx, out).await
        }
        TourneyWrite::Archive { tournament_id } => {
            organiser::archive(tournament_id, ctx, out).await
        }
        TourneyWrite::Abandon {
            tournament_id,
            abandoned,
        } => organiser::abandon(tournament_id, abandoned, ctx, out).await,
        TourneyWrite::Reseed {
            tournament_id,
            order,
        } => organiser::reseed(tournament_id, order, ctx, out).await,
        TourneyWrite::SplitDivisions {
            tournament_id,
            divisions,
        } => organiser::split_divisions(tournament_id, divisions, ctx, out).await,
        TourneyWrite::SetDivision {
            tournament_id,
            team_id,
            division,
        } => organiser::set_division(tournament_id, team_id, division, ctx, out).await,
        TourneyWrite::Administer {
            tournament_id,
            change,
        } => organiser::administer(tournament_id, change, ctx, out).await,
        TourneyWrite::AddOrganiser {
            tournament_id,
            faf_id,
            name,
        } => organiser::add_organiser(tournament_id, faf_id, name, ctx, out).await,
        TourneyWrite::SetCaster {
            tournament_id,
            faf_id,
            name,
            casting,
        } => organiser::set_caster(tournament_id, faf_id, name, casting, ctx, out).await,
        TourneyWrite::SetOrganiserVisibility {
            tournament_id,
            faf_id,
            hidden,
        } => organiser::set_organiser_visibility(tournament_id, faf_id, hidden, ctx, out).await,
        TourneyWrite::PostNews {
            tournament_id,
            body,
            important,
        } => organiser::post_news(tournament_id, body, important, ctx, out).await,
        TourneyWrite::EditNews {
            tournament_id,
            news_id,
            body,
            important,
        } => organiser::edit_news(tournament_id, news_id, body, important, ctx, out).await,
        TourneyWrite::DeleteNews {
            tournament_id,
            news_id,
        } => organiser::delete_news(tournament_id, news_id, ctx, out).await,
        TourneyWrite::AddQualifier {
            tournament_id,
            qualifier_id,
            rule,
        } => organiser::add_qualifier(tournament_id, qualifier_id, rule, ctx, out).await,
        TourneyWrite::RemoveQualifier {
            tournament_id,
            link_id,
        } => organiser::remove_qualifier(tournament_id, link_id, ctx, out).await,

        TourneyWrite::SaveSeries { draft } => series::save_series(draft, ctx, out).await,
        TourneyWrite::DeleteSeries { series_id } => {
            series::delete_series(series_id, ctx, out).await
        }
        TourneyWrite::SetSeries {
            tournament_id,
            series_id,
        } => series::set_series(tournament_id, series_id, ctx, out).await,

        TourneyWrite::MuteChat {
            tournament_id,
            faf_id,
            name,
            muted,
        } => moderation::mute_chat(tournament_id, faf_id, name, muted, ctx, out).await,
        TourneyWrite::DeleteChatPost {
            tournament_id,
            room_id,
            post_id,
        } => moderation::delete_chat_post(tournament_id, room_id, post_id, ctx, out).await,

        // A write like the rest, serial under the same key, but its own shape:
        // it reloads the room it posted in rather than the event.
        TourneyWrite::PostChat {
            tournament_id,
            room_id,
            body,
            reply_to,
        } => post_chat(tournament_id, room_id, body, reply_to, ctx, out).await,

        TourneyWrite::SiteWrite { write } => site::site_write(write, ctx, out).await,
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
