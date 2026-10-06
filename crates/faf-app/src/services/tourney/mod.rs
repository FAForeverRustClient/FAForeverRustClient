//! Tournament orchestration: reading the list, entering an event, playing it.
//!
//! Reads and writes have different shapes. A read is fire-and-forget with a
//! generation token, so only the newest answer lands. A write is serialised and
//! always ends by reloading from the server rather than patching the local
//! copy: confirming a score moves the winner into the next match, eliminates
//! the loser and can finish the tournament outright, and none of that is in the
//! response. Any local simulation of it would drift within one round.
//!
//! Split by lifecycle, one module each:
//!
//! - `reads`: the list, an event's detail, templates, copy sources, presets,
//!   the account search and the series, each read under its own generation.
//! - `eligibility`: whether this account may enter, one entrant's ratings, and
//!   which entrants' accounts were renamed.
//! - `chat`: the rooms, reading, pinning and polling them, and posting.
//! - `site`: the site's own pages and the account behind them.
//! - `writes`: every serialised write and the reload that ends it.

mod chat;
mod eligibility;
mod reads;
mod site;
mod writes;

use faf_domain::state::{TourneyCommand, TourneyEvent, TourneyRead};

use crate::runtime::{EventSink, LatestRequest, ServiceCtx};

/// The tournament service's request generations, one per kind of read.
/// Owned by this service.
#[derive(Default)]
pub struct TourneyContext {
    /// Only the newest detail response may land: opening three events in a row
    /// must not leave the first one's bracket on screen because it answered
    /// last.
    detail_generation: LatestRequest,
    /// The same, for reading a chat room.
    chat_generation: LatestRequest,
    /// The same, for the organiser's account search: it fires per keystroke, so
    /// answers overtaking each other is the normal case rather than the rare one.
    account_search_generation: LatestRequest,
    /// The same, for the entry-eligibility check. Moving to another event
    /// invalidates it as well, so a verdict about the event just left cannot
    /// land under the one now open.
    rating_check_generation: LatestRequest,
    /// The same, for one entrant's ratings table. Asking for another entrant,
    /// or again from FAF, supersedes the answer in flight, and moving to
    /// another event invalidates it like the eligibility check.
    player_ratings_generation: LatestRequest,
    /// The same, for the create form's "Fill from this": only the template
    /// asked for last may fill the form, success or refusal.
    template_generation: LatestRequest,
}

pub async fn handle(cmd: TourneyCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        // Every write, the chat post included: serial in the command policy
        // (`Key::TourneyWrite`), and run by `writes` through its helpers.
        TourneyCommand::Write(write) => writes::handle(write, ctx, out).await,
        TourneyCommand::Read(read) => handle_read(read, ctx, out).await,
    }
}

async fn handle_read(cmd: TourneyRead, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        TourneyRead::Load => reads::load(ctx, out).await,

        TourneyRead::Select { tournament_id } => {
            // Moving to another event ends the eligibility check and the
            // entrant ratings read of the one being left. Re-selecting the
            // open event does not: the reducer keeps both then, and dropping
            // the answer in flight would leave them loading for good.
            let moving = out.with_state(|state| {
                state.tourney.selected_id.as_deref() != Some(tournament_id.as_str())
            });
            if moving {
                ctx.tourney.rating_check_generation.invalidate();
                ctx.tourney.player_ratings_generation.invalidate();
            }
            out.emit(TourneyEvent::Selected {
                tournament_id: tournament_id.clone(),
            });
            // Selecting is what makes a detail worth having; requiring the UI to
            // dispatch both would let the two drift apart.
            reads::load_detail(&tournament_id, ctx, out).await;
        }

        TourneyRead::RefreshDetail { tournament_id } => {
            reads::refresh_detail(tournament_id, ctx, out).await
        }

        TourneyRead::CheckRating { tournament_id } => {
            eligibility::check_rating(tournament_id, ctx, out).await
        }

        TourneyRead::LoadPlayerRatings {
            tournament_id,
            player_id,
            refresh,
        } => eligibility::load_player_ratings(tournament_id, player_id, refresh, ctx, out).await,

        TourneyRead::LoadCopySources => reads::load_copy_sources(ctx, out).await,

        TourneyRead::LoadSite { read } => site::load_site(read, ctx, out).await,

        TourneyRead::LoadPresets => reads::load_presets(ctx, out).await,

        // Read like a map source, without opening it: the form fills from it
        // while whatever event is open stays open.
        //
        // Newest wins, refusals included. The form matches a filled template
        // against the source it asked for, but a refusal carries no source,
        // so an older request's failure landing last would read as the newer
        // one's. Not tied to the selection: the template is the create form's,
        // and moving between events leaves that form as it is.
        TourneyRead::LoadTemplate { tournament_id } => {
            reads::load_template(tournament_id, ctx, out).await
        }

        // The source's own detail, read without opening it: the open event
        // stays the one the maps are imported into.
        TourneyRead::LoadCopySource { tournament_id } => {
            reads::load_copy_source(tournament_id, ctx, out).await
        }

        TourneyRead::LoadChat { tournament_id } => chat::load_rooms(&tournament_id, ctx, out).await,

        TourneyRead::OpenRoom {
            tournament_id,
            room_id,
        } => chat::open_room(tournament_id, room_id, ctx, out).await,

        TourneyRead::PinRoom {
            tournament_id,
            room_id,
        } => chat::pin_room(tournament_id, room_id, ctx, out).await,

        TourneyRead::RefreshChat {
            tournament_id,
            room_id,
        } => chat::refresh_chat(tournament_id, room_id, ctx, out).await,

        TourneyRead::LoadHosting => site::load_hosting(ctx, out).await,

        TourneyRead::LoadProfile => site::load_profile(ctx, out).await,

        TourneyRead::SetDiscord { handle } => site::set_discord(handle, ctx, out).await,

        TourneyRead::SearchAccounts { query } => reads::search_accounts(&query, ctx, out).await,

        TourneyRead::ClearAccountSearch => reads::clear_account_search(ctx, out),

        TourneyRead::LoadArticles => site::load_articles(ctx, out).await,

        TourneyRead::CheckRenames { tournament_id } => {
            eligibility::check_renames(tournament_id, ctx, out).await
        }

        TourneyRead::LoadSeries => reads::load_series(ctx, out).await,

        TourneyRead::OpenSeries { series_id } => reads::open_series(&series_id, ctx, out).await,

        TourneyRead::CloseSeries => out.emit(TourneyEvent::SeriesClosed),

        TourneyRead::MarkNewsRead { tournament_id } => {
            reads::mark_news_read(tournament_id, ctx, out).await
        }

        TourneyRead::DismissActionError => out.emit(TourneyEvent::ActionErrorDismissed),
    }
}
