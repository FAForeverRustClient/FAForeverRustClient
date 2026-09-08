//! Clan boundary: the writes the website used to be the only home for.
//!
//! Two families behind one trait, because `faf-java-api` splits them. Reading
//! and editing a clan is ordinary Elide JSON:API; founding one, inviting to one
//! and joining one go through `ClansController`, which exists precisely because
//! those three cannot be expressed as a single resource write.
//!
//! Typed errors throughout ([`RequestError`]) rather than a sentence, because
//! every refusal here has an action attached: a name that is taken means "pick
//! another", an expired invitation means "ask for a new link", and 403 means
//! the leader changed while the screen was open.

use async_trait::async_trait;
use faf_domain::state::{ClanDraft, ClanIdentity, PlayerClan};

use super::RequestError;

#[async_trait]
pub trait ClanPort: Send + Sync {
    /// Who this account is and which clan it is in, from `GET /clans/me`.
    ///
    /// `is_leader` is *not* filled in here: the endpoint reports only the
    /// clan's id, name and tag, so the service resolves it from the clan
    /// document rather than this adapter inventing an answer.
    async fn me(&self) -> Result<ClanIdentity, RequestError>;

    /// The full clan this account belongs to, roster included.
    ///
    /// By player rather than by clan id, because it is read out of the player
    /// document: `joined_at` is a fact about a membership, and reusing the
    /// player card's parser is what stops the roster differing between the two
    /// screens that draw it.
    async fn clan(&self, player_id: i32) -> Result<PlayerClan, RequestError>;

    /// Found a clan, returning its new id.
    ///
    /// `POST /clans/create`, not a resource write: the clan and the founder's
    /// membership are created together and each needs the other's id.
    async fn create(&self, draft: &ClanDraft) -> Result<String, RequestError>;

    /// Change name, tag and description. Leader only, enforced server side.
    async fn edit(&self, clan_id: &str, draft: &ClanDraft) -> Result<(), RequestError>;

    /// Hand the clan to another of its members.
    async fn hand_over(&self, clan_id: &str, player_id: i32) -> Result<(), RequestError>;

    /// A signed invitation for one player, which the leader then delivers.
    async fn invite(&self, clan_id: &str, player_id: i32) -> Result<String, RequestError>;

    /// Redeem an invitation token.
    async fn accept_invitation(&self, token: &str) -> Result<(), RequestError>;

    /// Delete one membership: a removal by the leader, or a member leaving.
    /// The server treats both as the same write and refuses the leader's own.
    async fn remove_membership(&self, membership_id: &str) -> Result<(), RequestError>;

    /// Close the clan down. Leader only, enforced server side.
    async fn disband(&self, clan_id: &str) -> Result<(), RequestError>;
}
