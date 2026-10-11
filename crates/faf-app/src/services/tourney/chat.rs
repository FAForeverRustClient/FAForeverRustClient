//! Tournament chat: the rooms of the open event, reading, pinning and polling
//! them, and posting. Moderation (muting, deleting a post) is a write and runs
//! in `writes`.

use faf_domain::state::{TourneyAction, TourneyEvent};

use crate::runtime::{EventSink, ServiceCtx};

use super::writes::failed;

/// Open a room and read it: `TourneyRead::OpenRoom`.
pub(super) async fn open_room(
    tournament_id: String,
    room_id: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    out.emit(TourneyEvent::RoomOpened {
        room_id: room_id.clone(),
    });
    read_room(&tournament_id, &room_id, ctx, out).await;
}

/// Keep a room open beside the section on screen: `TourneyRead::PinRoom`.
pub(super) async fn pin_room(
    tournament_id: String,
    room_id: Option<String>,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    out.emit(TourneyEvent::RoomPinned {
        room_id: room_id.clone(),
    });
    // Read straight away and silently: the open room's loading state
    // is not this room's to change.
    if let Some(room_id) = room_id {
        match ctx
            .ports
            .tourney_chat
            .chat_read(&tournament_id, &room_id)
            .await
        {
            Ok(posts) => out.emit(TourneyEvent::ChatLoaded { room_id, posts }),
            Err(error) => {
                tracing::debug!(%error, "a pinned tournament chat could not be read");
            }
        }
    }
}

/// Poll a room and the room list: `TourneyRead::RefreshChat`.
pub(super) async fn refresh_chat(
    tournament_id: String,
    room_id: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    // Both halves, because they answer different questions: the room
    // is what is being read, and the list carries the unread counts,
    // the `@` marks and the organiser bells for every other room.
    //
    // Silent throughout. A failed poll is logged and dropped rather
    // than shown: the room on screen is still the last good one, and a
    // banner every few seconds on a flaky connection would be worse
    // than the gap it reports.
    match ctx
        .ports
        .tourney_chat
        .chat_read(&tournament_id, &room_id)
        .await
    {
        Ok(posts) => out.emit(TourneyEvent::ChatLoaded { room_id, posts }),
        Err(error) => {
            tracing::debug!(%error, "a tournament chat poll came back empty-handed");
            return;
        }
    }
    if let Ok(rooms) = ctx.ports.tourney_chat.chat_rooms(&tournament_id).await {
        out.emit(TourneyEvent::ChatRoomsLoaded { rooms });
    }
}

/// Post to a room: `TourneyWrite::PostChat`.
pub(super) async fn post_chat(
    tournament_id: String,
    room_id: String,
    body: String,
    reply_to: Option<String>,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    crate::runtime::expect_admitted(crate::runtime::Key::TourneyWrite);
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
    match ctx
        .ports
        .tourney_chat
        .chat_post(&tournament_id, &room_id, body.trim(), reply_to.as_deref())
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

/// The rooms of the open event.
///
/// Silent on failure for the same reason as the profiles: chat is beside the
/// bracket, not the point of it.
pub(super) async fn load_rooms(tournament_id: &str, ctx: &ServiceCtx, out: &EventSink) {
    match ctx.ports.tourney_chat.chat_rooms(tournament_id).await {
        Ok(rooms) => out.emit(TourneyEvent::ChatRoomsLoaded { rooms }),
        Err(error) => tracing::warn!(%error, "could not load the tournament chat rooms"),
    }
}

pub(super) async fn read_room(
    tournament_id: &str,
    room_id: &str,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let generation = ctx.tourney.chat_generation.begin();
    out.emit(TourneyEvent::ChatLoading);

    let read = ctx
        .ports
        .tourney_chat
        .chat_read(tournament_id, room_id)
        .await;
    if !ctx.tourney.chat_generation.is_current(generation) {
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
