//! Clan orchestration: read who you are, then change what you are allowed to.
//!
//! Every write ends by reloading, for the same reason the tournament service
//! does it: the answer to a clan write is not the new state of the clan.
//! Founding one creates a membership the response never mentions, handing one
//! over changes who may do anything at all, and removing a member changes a
//! roster held three relationships deep. A local simulation of any of those
//! would be wrong within one action.
//!
//! Writes are serialised (`clan_mutation`) because command order is not
//! response order, and two overlapping edits would otherwise reload in the
//! wrong order and leave the older answer standing.

use faf_domain::state::{ClanAction, ClanCommand, ClanEvent, ClanIdentity, ClanInvitation};

use crate::ports::RequestError;
use crate::runtime::{EventSink, ServiceCtx};

/// Below this, a candidate search would return the first page of every account
/// on FAF. The same floor the tournament entrant picker uses.
const MIN_CANDIDATE_QUERY: usize = 2;
const MAX_CANDIDATES: i32 = 12;

pub async fn handle(cmd: ClanCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        ClanCommand::Load => load(ctx, out).await,

        ClanCommand::Create { draft } => {
            let draft = draft.trimmed();
            write(ClanAction::Creating, ctx, out, {
                let draft = draft.clone();
                async move { ctx.ports.clan.create(&draft).await.map(|_| ()) }
            })
            .await;
        }

        ClanCommand::Edit { draft } => {
            let Some(clan_id) = open_clan(out) else {
                return;
            };
            let draft = draft.trimmed();
            write(ClanAction::Editing, ctx, out, async move {
                ctx.ports.clan.edit(&clan_id, &draft).await
            })
            .await;
        }

        ClanCommand::SearchCandidates { query } => search_candidates(&query, ctx, out).await,

        ClanCommand::Invite { player_id, login } => {
            let Some(clan_id) = open_clan(out) else {
                return;
            };
            // Not a `write`: an invitation changes nothing on the server, so
            // there is nothing to reload, and the token has to be *kept* rather
            // than confirmed. Nobody is in the clan until they redeem it.
            out.emit(ClanEvent::ActionStarted {
                action: ClanAction::Inviting,
            });
            match ctx.ports.clan.invite(&clan_id, player_id).await {
                Ok(token) => {
                    out.emit(ClanEvent::InvitationReady {
                        invitation: ClanInvitation {
                            token,
                            player_id,
                            login,
                        },
                    });
                    out.emit(ClanEvent::ActionSucceeded {
                        action: ClanAction::Inviting,
                    });
                }
                Err(error) => out.emit(failure(ClanAction::Inviting, &error)),
            }
        }

        ClanCommand::ClearInvitation => out.emit(ClanEvent::InvitationCleared),

        ClanCommand::AcceptInvitation { token } => {
            // Whole links are pasted at least as often as bare tokens, because
            // a link is what the leader was given to send.
            let token = invitation_token(&token);
            write(ClanAction::Joining, ctx, out, async move {
                ctx.ports.clan.accept_invitation(&token).await
            })
            .await;
        }

        ClanCommand::Remove { player_id } => {
            let Some(membership_id) = membership_of(player_id, out) else {
                return;
            };
            write(ClanAction::Removing, ctx, out, async move {
                ctx.ports.clan.remove_membership(&membership_id).await
            })
            .await;
        }

        ClanCommand::Leave => {
            // Leaving is removing your own membership: the server treats the
            // two as one write and refuses the leader's, which is why the view
            // offers a hand-over instead.
            let player_id = out.with_state(|state| state.clan.identity.player_id);
            let Some(membership_id) = membership_of(player_id, out) else {
                return;
            };
            write(ClanAction::Leaving, ctx, out, async move {
                ctx.ports.clan.remove_membership(&membership_id).await
            })
            .await;
        }

        ClanCommand::HandOver { player_id } => {
            let Some(clan_id) = open_clan(out) else {
                return;
            };
            write(ClanAction::HandingOver, ctx, out, async move {
                ctx.ports.clan.hand_over(&clan_id, player_id).await
            })
            .await;
        }

        ClanCommand::Disband => {
            let Some(clan_id) = open_clan(out) else {
                return;
            };
            write(ClanAction::Disbanding, ctx, out, async move {
                ctx.ports.clan.disband(&clan_id).await
            })
            .await;
        }
    }
}

/// Read `/clans/me`, then the clan itself when there is one.
///
/// Two requests rather than one because they answer different questions and
/// only the first is cheap: `me` is the identity every screen needs, and the
/// roster is only wanted by the screen that draws it.
async fn load(ctx: &ServiceCtx, out: &EventSink) {
    out.emit(ClanEvent::Loading);
    let identity = match ctx.ports.clan.me().await {
        Ok(identity) => identity,
        Err(error) => {
            out.emit(ClanEvent::LoadFailed {
                reason: error.to_string(),
            });
            return;
        }
    };

    if !identity.in_a_clan() {
        out.emit(ClanEvent::Loaded {
            identity,
            clan: None,
        });
        return;
    }

    match ctx.ports.clan.clan(identity.player_id).await {
        Ok(clan) => {
            // Resolved here rather than by the adapter, because it is a join
            // between two answers: `/clans/me` names the clan and the clan
            // document names its leader. The value only decides which controls
            // are drawn; the server authorises every write regardless.
            let identity = ClanIdentity {
                is_leader: clan.leader.eq_ignore_ascii_case(&identity.login)
                    && !identity.login.is_empty(),
                ..identity
            };
            out.emit(ClanEvent::Loaded {
                identity,
                clan: Some(Box::new(clan)),
            });
        }
        // The identity is worth having even when the roster is not: it is what
        // tells the screen there is a clan at all, and a failed roster read is
        // a reason to show the clan without its members rather than nothing.
        Err(error) => {
            out.emit(ClanEvent::Loaded {
                identity,
                clan: None,
            });
            out.emit(ClanEvent::LoadFailed {
                reason: error.to_string(),
            });
        }
    }
}

/// Run one mutation, then reload.
///
/// The reload happens on failure too. A refused write is not proof that
/// nothing changed: a 403 usually means somebody else already changed the
/// thing being refused, and leaving the old answer on screen is how a player
/// ends up pressing a button that cannot work any more.
async fn write<F>(action: ClanAction, ctx: &ServiceCtx, out: &EventSink, effect: F)
where
    F: std::future::Future<Output = Result<(), RequestError>>,
{
    let _guard = ctx.clan_mutation.acquire().await;
    out.emit(ClanEvent::ActionStarted { action });
    match effect.await {
        Ok(()) => out.emit(ClanEvent::ActionSucceeded { action }),
        Err(error) => out.emit(failure(action, &error)),
    }
    load(ctx, out).await;
}

async fn search_candidates(query: &str, ctx: &ServiceCtx, out: &EventSink) {
    let query = query.trim();
    if query.chars().count() < MIN_CANDIDATE_QUERY {
        out.emit(ClanEvent::CandidatesLoaded {
            candidates: Vec::new(),
        });
        return;
    }
    let generation = ctx.clan_candidate_generation.begin();
    let found = ctx
        .ports
        .player_card
        .search_players(query, MAX_CANDIDATES)
        .await;
    if !ctx.clan_candidate_generation.is_current(generation) {
        // A later keystroke is already in flight; this answer is for a prefix
        // the field no longer holds.
        return;
    }
    let members: Vec<i32> = out.with_state(|state| {
        state
            .clan
            .clan
            .as_ref()
            .map(|clan| clan.members.iter().map(|member| member.player_id).collect())
            .unwrap_or_default()
    });
    // Somebody already in the clan cannot be invited to it, and the server
    // would refuse the token at redemption rather than at generation, which is
    // the worst possible moment to find out.
    let candidates = found
        .unwrap_or_default()
        .into_iter()
        .filter(|player| !members.contains(&player.id))
        .collect();
    out.emit(ClanEvent::CandidatesLoaded { candidates });
}

/// The clan currently open, or nothing to act on.
fn open_clan(out: &EventSink) -> Option<String> {
    out.with_state(|state| {
        let id = state.clan.identity.clan_id.clone();
        (!id.is_empty()).then_some(id)
    })
}

fn membership_of(player_id: i32, out: &EventSink) -> Option<String> {
    out.with_state(|state| state.clan.membership_of(player_id).map(str::to_string))
}

fn failure(action: ClanAction, error: &RequestError) -> ClanEvent {
    ClanEvent::ActionFailed {
        action,
        reason: error.to_string(),
        kind: error.kind(),
    }
}

/// The token out of whatever was pasted.
///
/// The leader is handed a link to send, so a link is what arrives: the website
/// spells it `.../clans/join?token=<jwt>`. Taking the last `token=` parameter
/// rather than requiring a bare token saves the one step a recipient is most
/// likely to get wrong, and a bare token still passes through untouched.
fn invitation_token(pasted: &str) -> String {
    let pasted = pasted.trim();
    match pasted.rsplit_once("token=") {
        Some((_, tail)) => tail
            .split(['&', '#', ' '])
            .next()
            .unwrap_or(tail)
            .trim()
            .to_string(),
        None => pasted.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use faf_domain::state::ClanDraft;

    #[test]
    fn an_invitation_is_read_out_of_the_link_it_arrived_in() {
        let jwt = "eyJhbGciOi.eyJjbGFuIjo.signature";
        assert_eq!(invitation_token(jwt), jwt, "a bare token passes through");
        assert_eq!(
            invitation_token(&format!("https://www.faforever.com/clans/join?token={jwt}")),
            jwt
        );
        assert_eq!(
            invitation_token(&format!("  https://x/join?a=1&token={jwt}&b=2  ")),
            jwt,
            "and stops at the next parameter"
        );
        assert_eq!(invitation_token("   "), "");
    }

    #[test]
    fn a_draft_is_trimmed_before_it_is_sent() {
        // The name is what the uniqueness check runs against, so " BRO " and
        // "BRO" being different requests is a difference nobody wants.
        let draft = ClanDraft {
            name: "  Brotherhood  ".into(),
            tag: " BRO ".into(),
            description: "  We play together.  ".into(),
        }
        .trimmed();
        assert_eq!(draft.name, "Brotherhood");
        assert_eq!(draft.tag, "BRO");
        assert_eq!(draft.description, "We play together.");
    }
}
