//! Clan management: the half of a clan that lives on the website today.
//!
//! The client has always been able to *read* a clan, as part of a player card.
//! Everything that changes one has been a trip to faforever.com. This slice is
//! the other half: founding a clan, editing it, inviting and removing members,
//! handing it on, leaving it, and closing it down.
//!
//! ## What the API actually offers, and what follows from it
//!
//! Two shapes, because `faf-java-api` uses two. `ClansController` (`/clans/...`)
//! handles the three things JSON:API cannot express: `me`, because "who am I
//! and which clan am I in" is one question rather than a resource; `create`,
//! because founding a clan writes the clan and the leader's membership at the
//! same time and each needs the other's id; and the invitation pair, because an
//! invitation is a signed token rather than a row. Everything else is ordinary
//! Elide: `PATCH /data/clan/{id}` edits, `DELETE /data/clan/{id}` disbands, and
//! `DELETE /data/clanMembership/{id}` removes one member.
//!
//! ## Authorisation is the server's, as everywhere else here
//!
//! [`ClanIdentity::is_leader`] decides which controls are *drawn*. It is not a
//! permission: `Clan` is owned by its leader (`IsEntityOwner`) and
//! `ClanMembership` carries `IsClanMembershipDeletable`, so the server answers
//! 403 to anything else no matter what this client believes. That is the same
//! rule the tournament roles follow, and the reason the leader is read from the
//! clan the server sent rather than worked out here.
//!
//! Three of the server's refusals are worth knowing because they are ordinary
//! rather than exceptional, and the client shows them verbatim: a founder who
//! is already in a clan, a name or tag somebody else has, and an invitation
//! that has expired.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::player_card::PlayerClan;
use super::PlayerSummary;
use crate::state::failure::RequestFailureKind;

/// The API's own cap. `Clan.tag` is `@Size(max = 3)`, so a longer tag is
/// refused by the server; the form says so before the request is spent.
pub const MAX_CLAN_TAG: usize = 3;

/// Who this account is, in clan terms: the answer to `GET /clans/me`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClanIdentity {
    pub player_id: i32,
    pub login: String,
    /// The clan id, or empty when this account is in none.
    pub clan_id: String,
    pub clan_name: String,
    pub clan_tag: String,
    /// Whether this account leads that clan.
    ///
    /// Resolved by the service from the clan document rather than sent by
    /// `/clans/me`, which reports only id, name and tag.
    pub is_leader: bool,
}

impl ClanIdentity {
    pub fn in_a_clan(&self) -> bool {
        !self.clan_id.is_empty()
    }
}

/// What a clan is being changed to. One shape for founding and for editing,
/// because the server takes the same three fields either way.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClanDraft {
    pub name: String,
    pub tag: String,
    pub description: String,
}

impl ClanDraft {
    /// Why this draft cannot be sent, in the words the form shows.
    ///
    /// Only what is knowable here. Whether the name is *taken* is the server's
    /// answer and is not guessed at: this checks the shape the API declares,
    /// so a request that would certainly be refused is not spent.
    pub fn problem(&self) -> Option<ClanDraftProblem> {
        if self.name.trim().is_empty() {
            return Some(ClanDraftProblem::NameMissing);
        }
        if self.tag.trim().is_empty() {
            return Some(ClanDraftProblem::TagMissing);
        }
        if self.tag.trim().chars().count() > MAX_CLAN_TAG {
            return Some(ClanDraftProblem::TagTooLong);
        }
        None
    }

    pub fn trimmed(&self) -> Self {
        Self {
            name: self.name.trim().to_string(),
            tag: self.tag.trim().to_string(),
            description: self.description.trim().to_string(),
        }
    }
}

/// A reason a draft is not ready, as a value rather than a sentence: the
/// wording is the frontend's, and this crate does not hold translations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ClanDraftProblem {
    NameMissing,
    TagMissing,
    TagTooLong,
}

/// An invitation the leader generated, ready to be sent to its recipient.
///
/// The token *is* the invitation: `ClansController.generateInvitationLink`
/// returns a signed JWT naming the clan, the invitee and an expiry, and
/// `joinClan` takes it back. Nothing is stored server side, so the leader has
/// to actually deliver this, which is why it is held here to be copied rather
/// than fired off and forgotten.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClanInvitation {
    pub token: String,
    pub player_id: i32,
    pub login: String,
}

/// Which mutation is in flight, so the view can name what it is waiting for
/// and disable the right control rather than all of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ClanAction {
    Creating,
    Editing,
    Inviting,
    Joining,
    Removing,
    Leaving,
    HandingOver,
    Disbanding,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ClanStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClanActionStatus {
    #[default]
    Idle,
    Working {
        action: ClanAction,
    },
    /// The server's own sentence. `faf-java-api` answers a refused clan write
    /// with a written reason ("the clan name Foo is already taken"), and that
    /// is worth more than any category this client could map it to.
    Failed {
        action: ClanAction,
        reason: String,
        kind: RequestFailureKind,
    },
    Succeeded {
        action: ClanAction,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClanState {
    pub identity: ClanIdentity,
    pub status: ClanStatus,
    /// The full clan this account belongs to, once loaded.
    ///
    /// The same type the player card shows, because it is the same document:
    /// one parser, and a roster that cannot disagree with itself depending on
    /// which screen drew it.
    pub clan: Option<PlayerClan>,
    pub action: ClanActionStatus,
    /// Accounts matching what was typed into the invite field.
    pub candidates: Vec<PlayerSummary>,
    pub invitation: Option<ClanInvitation>,
}

impl ClanState {
    /// The membership row for one member, which is what a removal addresses.
    pub fn membership_of(&self, player_id: i32) -> Option<&str> {
        self.clan
            .as_ref()?
            .members
            .iter()
            .find(|member| member.player_id == player_id)
            .map(|member| member.membership_id.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClanEvent {
    Loading,
    Loaded {
        identity: ClanIdentity,
        clan: Option<Box<PlayerClan>>,
    },
    LoadFailed {
        reason: String,
    },
    ActionStarted {
        action: ClanAction,
    },
    ActionFailed {
        action: ClanAction,
        reason: String,
        kind: RequestFailureKind,
    },
    ActionSucceeded {
        action: ClanAction,
    },
    CandidatesLoaded {
        candidates: Vec<PlayerSummary>,
    },
    /// A generated invitation, waiting to be delivered.
    InvitationReady {
        invitation: ClanInvitation,
    },
    InvitationCleared,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClanCommand {
    /// Read who this account is and, if it is in a clan, that clan.
    Load,
    Create {
        draft: ClanDraft,
    },
    /// Edit name, tag and description. Leader only, server side.
    Edit {
        draft: ClanDraft,
    },
    /// Accounts to offer in the invite field.
    SearchCandidates {
        query: String,
    },
    Invite {
        player_id: i32,
        login: String,
    },
    ClearInvitation,
    /// Accept an invitation somebody sent, as a token or as the whole link.
    AcceptInvitation {
        token: String,
    },
    /// Remove another member. Leader only, server side.
    Remove {
        player_id: i32,
    },
    /// Leave the clan. The leader cannot: the server refuses to delete the
    /// leader's own membership, so the control hands over first.
    Leave,
    HandOver {
        player_id: i32,
    },
    Disband,
}

pub fn reduce(state: &mut ClanState, event: &ClanEvent) {
    match event {
        ClanEvent::Loading => state.status = ClanStatus::Loading,
        ClanEvent::Loaded { identity, clan } => {
            state.identity = identity.clone();
            state.clan = clan.as_deref().cloned();
            state.status = ClanStatus::Ready;
            // A reload follows every write, so this is also where a finished
            // action stops being announced: leaving the banner up over the
            // result it produced reads as though it were still happening.
            if matches!(state.action, ClanActionStatus::Succeeded { .. }) {
                state.action = ClanActionStatus::Idle;
            }
            if !identity.in_a_clan() {
                // Nothing to invite anybody to any more.
                state.invitation = None;
                state.candidates.clear();
            }
        }
        ClanEvent::LoadFailed { reason } => {
            state.status = ClanStatus::Failed {
                reason: reason.clone(),
            }
        }
        ClanEvent::ActionStarted { action } => {
            state.action = ClanActionStatus::Working { action: *action }
        }
        ClanEvent::ActionFailed {
            action,
            reason,
            kind,
        } => {
            state.action = ClanActionStatus::Failed {
                action: *action,
                reason: reason.clone(),
                kind: *kind,
            }
        }
        ClanEvent::ActionSucceeded { action } => {
            state.action = ClanActionStatus::Succeeded { action: *action }
        }
        ClanEvent::CandidatesLoaded { candidates } => state.candidates = candidates.clone(),
        ClanEvent::InvitationReady { invitation } => {
            state.invitation = Some(invitation.clone());
            // The field has done its job; leaving the list open invites a
            // second click that would replace the token just generated.
            state.candidates.clear();
        }
        ClanEvent::InvitationCleared => state.invitation = None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(clan_id: &str, is_leader: bool) -> ClanIdentity {
        ClanIdentity {
            player_id: 7,
            login: "Me".into(),
            clan_id: clan_id.into(),
            clan_name: "Clan".into(),
            clan_tag: "CLN".into(),
            is_leader,
        }
    }

    #[test]
    fn a_draft_is_checked_only_for_what_is_knowable_here() {
        assert_eq!(
            ClanDraft::default().problem(),
            Some(ClanDraftProblem::NameMissing)
        );
        assert_eq!(
            ClanDraft {
                name: "Brotherhood".into(),
                ..ClanDraft::default()
            }
            .problem(),
            Some(ClanDraftProblem::TagMissing)
        );
        // The API declares `@Size(max = 3)`, so this one is certain to be
        // refused and is worth saying before the request is spent.
        assert_eq!(
            ClanDraft {
                name: "Brotherhood".into(),
                tag: "BROS".into(),
                ..ClanDraft::default()
            }
            .problem(),
            Some(ClanDraftProblem::TagTooLong)
        );
        // Whether the name is taken is the server's answer, not ours.
        assert_eq!(
            ClanDraft {
                name: "Brotherhood".into(),
                tag: "BRO".into(),
                description: "  hello  ".into(),
            }
            .problem(),
            None
        );
    }

    #[test]
    fn a_reload_retires_the_banner_for_the_action_that_caused_it() {
        let mut state = ClanState::default();
        reduce(
            &mut state,
            &ClanEvent::ActionStarted {
                action: ClanAction::Creating,
            },
        );
        assert_eq!(
            state.action,
            ClanActionStatus::Working {
                action: ClanAction::Creating
            }
        );
        reduce(
            &mut state,
            &ClanEvent::ActionSucceeded {
                action: ClanAction::Creating,
            },
        );
        reduce(
            &mut state,
            &ClanEvent::Loaded {
                identity: identity("4", true),
                clan: None,
            },
        );
        assert_eq!(state.action, ClanActionStatus::Idle);
        assert!(state.identity.in_a_clan());
        assert!(state.identity.is_leader);
    }

    #[test]
    fn a_failure_stays_up_across_the_reload_that_follows_it() {
        // The reload happens either way, and a refusal the player never read
        // is a refusal that did not happen as far as they are concerned.
        let mut state = ClanState::default();
        reduce(
            &mut state,
            &ClanEvent::ActionFailed {
                action: ClanAction::Creating,
                reason: "the clan name Brotherhood is already taken".into(),
                kind: RequestFailureKind::Rejected,
            },
        );
        reduce(
            &mut state,
            &ClanEvent::Loaded {
                identity: identity("", false),
                clan: None,
            },
        );
        assert!(matches!(state.action, ClanActionStatus::Failed { .. }));
    }

    #[test]
    fn leaving_a_clan_takes_the_pending_invitation_with_it() {
        let mut state = ClanState {
            invitation: Some(ClanInvitation {
                token: "jwt".into(),
                player_id: 9,
                login: "Recruit".into(),
            }),
            ..ClanState::default()
        };
        reduce(
            &mut state,
            &ClanEvent::Loaded {
                identity: identity("", false),
                clan: None,
            },
        );
        assert!(
            state.invitation.is_none(),
            "an invitation to a clan you left is not an invitation"
        );
    }
}
