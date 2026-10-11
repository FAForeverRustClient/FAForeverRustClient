//! Tournament chat: the rooms of the open event, reading, pinning and polling
//! them, and posting. Moderation (muting, deleting a post) is a write and runs
//! in `writes`.
//!
//! Every read of a room, and of the room list, takes a ticket from
//! `chat_answers` immediately before it asks, and its answer lands only if no
//! answer from a later ticket about the same room has landed first. A poll is
//! the same read as any other, so a poll sent before a post and answered after
//! the post's own re-read is dropped instead of hiding the post until the next
//! poll. Not a generation: polls overlap by design, and under one a room whose
//! server answers slower than the poll interval would never update at all.

use faf_domain::state::{TourneyAction, TourneyEvent};

use crate::runtime::{EventSink, ServiceCtx};

use super::writes::failed;

/// What one chat answer is about, for ordering them.
///
/// Keyed by the room alone, because that is all a [`TourneyEvent::ChatLoaded`]
/// names and so all the reducer files it under. The room list is one more
/// thing to order, apart from every room.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) enum ChatAnswer {
    Room(String),
    RoomList,
}

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
        poll_room(&tournament_id, room_id, ctx, out).await;
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
    if poll_room(&tournament_id, room_id, ctx, out).await {
        load_rooms(&tournament_id, ctx, out).await;
    }
}

/// Read a room without touching the open room's loading state, for a poll or
/// the pinned room. False when the read failed, which is logged and nothing
/// else.
async fn poll_room(
    tournament_id: &str,
    room_id: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) -> bool {
    let ticket = ctx.tourney.chat_answers.ticket();
    match ctx
        .ports
        .tourney_chat
        .chat_read(tournament_id, &room_id)
        .await
    {
        Ok(posts) => {
            ctx.tourney
                .chat_answers
                .land(ChatAnswer::Room(room_id.clone()), ticket, || {
                    out.emit(TourneyEvent::ChatLoaded { room_id, posts });
                    true
                });
            true
        }
        Err(error) => {
            tracing::debug!(%error, room = %room_id, "a quiet tournament chat read came back empty-handed");
            false
        }
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
            // Both re-reads take their tickets now, after the post was
            // accepted, so they outrank every read sent before it: a poll
            // still out from before the post cannot land over them.
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
    let ticket = ctx.tourney.chat_answers.ticket();
    match ctx.ports.tourney_chat.chat_rooms(tournament_id).await {
        Ok(rooms) => {
            ctx.tourney
                .chat_answers
                .land(ChatAnswer::RoomList, ticket, || {
                    out.emit(TourneyEvent::ChatRoomsLoaded { rooms });
                    true
                });
        }
        Err(error) => tracing::warn!(%error, "could not load the tournament chat rooms"),
    }
}

/// Read a room and say so: the open room's own read, and the re-read after a
/// write in a room.
pub(super) async fn read_room(
    tournament_id: &str,
    room_id: &str,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    // Loading first, then the generation and the ticket. An answer from a
    // read that asks after this one lands after this `ChatLoading` and
    // settles the pane; taken the other way round, a newer poll could land
    // in between, and this read's answer, dropped as the older one, would
    // leave the pane loading until the next poll.
    out.emit(TourneyEvent::ChatLoading);
    let generation = ctx.tourney.chat_generation.begin();
    let ticket = ctx.tourney.chat_answers.ticket();

    let read = ctx
        .ports
        .tourney_chat
        .chat_read(tournament_id, room_id)
        .await;
    // A refusal is an answer too, and it lands under the same two checks: a
    // newer read of this room that already landed outranks it, and so does
    // a newer opening of any room, whose pane the refusal would otherwise
    // fail.
    ctx.tourney
        .chat_answers
        .land(ChatAnswer::Room(room_id.to_string()), ticket, || {
            if !ctx.tourney.chat_generation.is_current(generation) {
                return false;
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
            true
        });
}
