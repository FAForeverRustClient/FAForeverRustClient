//! Chat moderation: muting an account in the event's chat, and deleting a
//! post. Posting is a write as well, but `chat` runs it, as it owns the room
//! a post reloads.

use faf_domain::state::TourneyAction;

use crate::runtime::{EventSink, ServiceCtx};
use crate::services::tourney::chat::read_room;

use super::write;

pub(super) async fn mute_chat(
    tournament_id: String,
    faf_id: i32,
    name: String,
    muted: bool,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
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

pub(super) async fn delete_chat_post(
    tournament_id: String,
    room_id: String,
    post_id: String,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
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
