//! The slice's reducer.

use super::*;

pub fn reduce(state: &mut TourneyState, event: &TourneyEvent) {
    match event {
        TourneyEvent::Loading => state.status = TourneyLoadStatus::Loading,
        TourneyEvent::AssetBase { base } => {
            state.asset_base = base.trim_end_matches('/').to_string()
        }
        TourneyEvent::Loaded { events } => {
            // Keep the open event selected across a refresh: a reload should
            // not throw the reader back to the top of the list. But a selection
            // pointing at an event that has gone has to be dropped, or the
            // detail pane keeps showing a tournament nobody can reach.
            let still_present = state
                .selected_id
                .as_deref()
                .is_some_and(|id| events.iter().any(|event| event.id == id));
            state.events = events.clone();
            state.status = TourneyLoadStatus::Ready;
            if !still_present {
                state.selected_id = events.first().map(|event| event.id.clone());
                clear_open_event(state);
            }
        }
        TourneyEvent::LoadFailed { reason, kind } => {
            state.status = TourneyLoadStatus::Failed {
                reason: reason.clone(),
                kind: *kind,
            }
        }
        TourneyEvent::Selected { tournament_id } => {
            if state.selected_id.as_deref() != Some(tournament_id.as_str()) {
                // Drop the previous event's bracket and conversation at once,
                // rather than letting them linger under the new heading until
                // the reload lands.
                clear_open_event(state);
            }
            state.selected_id = Some(tournament_id.clone());
        }
        TourneyEvent::DetailLoading => state.detail_status = TourneyLoadStatus::Loading,
        TourneyEvent::DetailLoaded { event } => {
            // A detail for an event the reader has already moved on from is
            // discarded. The service's newest-wins policy makes this rare, but
            // a reload racing a selection can still produce it.
            if state.selected_id.as_deref() == Some(event.id.as_str()) {
                state.detail = Some((**event).clone());
                state.detail_status = TourneyLoadStatus::Ready;
                // The row and the detail must not disagree about the entrant
                // count or the status.
                if let Some(row) = state.events.iter_mut().find(|row| row.id == event.id) {
                    // The list row never carried people; taking the detail
                    // wholesale would be an improvement, not a loss.
                    *row = (**event).clone();
                }
            }
        }
        TourneyEvent::DetailLoadFailed { reason, kind } => {
            state.detail_status = TourneyLoadStatus::Failed {
                reason: reason.clone(),
                kind: *kind,
            }
        }
        TourneyEvent::ActionStarted { action } => {
            state.pending = Some(action.clone());
            state.action_error = None;
        }
        TourneyEvent::ActionSucceeded { select, .. } => {
            state.pending = None;
            state.action_error = None;
            if let Some(tournament_id) = select {
                // A newly created event. Its detail has not been fetched yet,
                // so the previous one has to go with the selection or it would
                // sit under the new name until the reload lands.
                state.selected_id = Some(tournament_id.clone());
                clear_open_event(state);
            }
        }
        TourneyEvent::ActionFailed { failure } => {
            state.pending = None;
            state.action_error = Some(failure.clone());
        }
        TourneyEvent::ActionErrorDismissed => state.action_error = None,
        TourneyEvent::EntrantProfilesLoaded { profiles } => {
            state.entrant_profiles = profiles.clone()
        }
        TourneyEvent::ChatRoomsLoaded { rooms } => {
            state.chat_rooms = rooms.clone();
            // An open room that no longer exists would leave posts on screen
            // with nothing to reload them from.
            if !state
                .open_room_id
                .as_deref()
                .is_some_and(|open| rooms.iter().any(|room| room.id == open))
            {
                state.open_room_id = None;
                state.chat_posts.clear();
            }
        }
        TourneyEvent::RoomOpened { room_id } => {
            if state.open_room_id.as_deref() != Some(room_id.as_str()) {
                state.chat_posts.clear();
            }
            state.open_room_id = Some(room_id.clone());
        }
        TourneyEvent::ChatLoading => state.chat_status = TourneyLoadStatus::Loading,
        TourneyEvent::ChatLoaded { room_id, posts } => {
            if state.open_room_id.as_deref() == Some(room_id.as_str()) {
                state.chat_posts = posts.clone();
                state.chat_status = TourneyLoadStatus::Ready;
                // Reading a room is what clears its unread marker server-side,
                // so the badge goes here too rather than waiting for the next
                // room list.
                if let Some(room) = state.chat_rooms.iter_mut().find(|room| room.id == *room_id) {
                    room.unread = 0;
                }
            }
        }
        TourneyEvent::ChatFailed { reason, kind } => {
            state.chat_status = TourneyLoadStatus::Failed {
                reason: reason.clone(),
                kind: *kind,
            }
        }
        TourneyEvent::ArticlesLoaded { articles } => state.articles = articles.clone(),
        TourneyEvent::HostingLoaded { hosting } => state.hosting = hosting.clone(),
        TourneyEvent::DiscordLoaded { discord } => state.discord = discord.clone(),

        // A search's own query moves with it. Starting one claims the field, so
        // the results already on screen belong to the older word and go: showing
        // matches for what was typed three letters ago is worse than showing
        // none, because they are clickable.
        TourneyEvent::AccountSearchStarted { query } => {
            state.account_search = AccountSearch {
                query: query.clone(),
                matches: Vec::new(),
                status: TourneyLoadStatus::Loading,
            };
        }
        // Answers can overtake each other, so one for an abandoned query is
        // dropped rather than replacing the current one's.
        TourneyEvent::AccountSearchLoaded { query, matches } => {
            if state.account_search.is_current(query) {
                state.account_search.matches = matches.clone();
                state.account_search.status = TourneyLoadStatus::Ready;
            }
        }
        TourneyEvent::AccountSearchFailed {
            query,
            reason,
            kind,
        } => {
            if state.account_search.is_current(query) {
                state.account_search.matches = Vec::new();
                state.account_search.status = TourneyLoadStatus::Failed {
                    reason: reason.clone(),
                    kind: *kind,
                };
            }
        }
        TourneyEvent::AccountSearchCleared => state.account_search = AccountSearch::default(),

        TourneyEvent::SeriesLoading => state.series_status = TourneyLoadStatus::Loading,
        TourneyEvent::SeriesLoaded { series } => {
            state.series = series.clone();
            state.series_status = TourneyLoadStatus::Ready;
            // A series that has been deleted while its page was open leaves the
            // page showing editions nobody can reach from anywhere else.
            if !state
                .open_series
                .as_ref()
                .is_none_or(|open| series.iter().any(|row| row.id == open.id))
            {
                state.open_series = None;
            }
        }
        TourneyEvent::SeriesFailed { reason, kind } => {
            state.series_status = TourneyLoadStatus::Failed {
                reason: reason.clone(),
                kind: *kind,
            }
        }
        TourneyEvent::SeriesOpened { detail } => state.open_series = Some((**detail).clone()),
        TourneyEvent::SeriesClosed => state.open_series = None,
    }
}

/// Forget everything that belonged to the event that was open.
///
/// One place, because these five fields going out of step is exactly how a
/// bracket ends up captioned with another tournament's chat.
fn clear_open_event(state: &mut TourneyState) {
    state.detail = None;
    state.detail_status = TourneyLoadStatus::Idle;
    state.entrant_profiles.clear();
    state.chat_rooms.clear();
    state.chat_posts.clear();
    state.open_room_id = None;
    state.chat_status = TourneyLoadStatus::Idle;
}
