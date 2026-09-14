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
//!
//! The connection keeps a second copy of the same fact, because it re-sends
//! the relation lists whenever a `player_info` names an account they were
//! waiting on: see `PlayerDirectory::note_local_relation`. Without it that
//! re-send undid whatever the user had just done.

use faf_domain::state::{Relation, SocialCommand, SocialEvent};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: SocialCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        SocialCommand::SetRelation {
            player_id,
            login,
            relation,
            member,
        } => {
            // The slice treats friend and foe as mutually exclusive, and the
            // server does not: `social_add` writes a row per list, so marking
            // a friend as a foe left the account on both and the next login
            // read them back as both. The reducer drops the opposite entry, so
            // the opposite row is dropped on the server too.
            let opposite = match relation {
                Relation::Friend => Relation::Foe,
                Relation::Foe => Relation::Friend,
            };
            let was_opposite = member
                && out.with_state(|state| {
                    let list = match opposite {
                        Relation::Friend => &state.social.friends,
                        Relation::Foe => &state.social.foes,
                    };
                    list.iter().any(|known| known == &login)
                });

            out.emit(SocialEvent::RelationSet {
                login,
                relation,
                member,
            });
            if was_opposite {
                ctx.ports.lobby.set_relation(player_id, opposite, false);
            }
            ctx.ports.lobby.set_relation(player_id, relation, member);
        }
    }
}
