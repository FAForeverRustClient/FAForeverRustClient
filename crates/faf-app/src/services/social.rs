//! Social service.
//!
//! Owns the friend/foe commands. The transport is the lobby socket (that is
//! where `social_add`/`social_remove` live), but the state they change belongs
//! to the social slice, so the command lives here rather than in
//! [`services::lobby`](crate::services::lobby): same split as the slices.
//!
//! The emit-then-send order matters: the server acknowledges neither command
//! and does not echo a fresh `social` message, so the optimistic event *is* the
//! state change as far as this client is concerned. Both reference clients
//! update their local relation set at the point of action for the same reason
//! (`py-client`'s `IrcRelationController.add`). If the socket is down the send
//! is dropped and the optimistic state is wrong until the next `social`
//! snapshot on reconnect: which is exactly when the server's view arrives and
//! replaces it wholesale.

use faf_domain::state::{SocialCommand, SocialEvent};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: SocialCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        SocialCommand::SetRelation {
            player_id,
            login,
            relation,
            member,
        } => {
            out.emit(SocialEvent::RelationSet {
                login,
                relation,
                member,
            });
            ctx.ports.lobby.set_relation(player_id, relation, member);
        }
    }
}
