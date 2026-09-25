//! The people in a tournament: players, teams, captains, organisers and
//! casters, the invitations that bring them in, and the player draft.

use super::*;

/// One organiser of an event, as an organiser sees the list.
///
/// Distinct from `organisers`, which is the public list and carries names only:
/// this one names FAF accounts and says which of them chose to stay off the
/// public list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Organiser {
    pub faf_id: i32,
    pub name: String,
    /// Hidden from the public organiser list, but still an organiser.
    pub hidden: bool,
}

/// Somebody allowed to watch the whole event in order to cast it.
///
/// A caster sees every match chat, not only the ones they are in, which is the
/// point: they are commentating on matches they are not playing. The website
/// did this with a secret link carrying a token; it is an account role now, so
/// the client gets it from the session like everything else.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Caster {
    pub faf_id: i32,
    pub name: String,
}

/// Somebody an organiser silenced in the event's chat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatMute {
    /// Sent as a *string*, because the service builds this list out of
    /// `Object.keys`, and object keys are strings whatever went in.
    pub faf_id: i32,
    pub name: String,
    /// Unix seconds.
    pub at: Option<u32>,
}

/// How far a team got: the side and round its last match was in.
///
/// The service writes this when a match is decided, and clears it again when a
/// result is corrected. It is what the standings are built from: a bracket says
/// who beat whom, but only this says where each run ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamExit {
    pub bracket: BracketSide,
    pub round: i32,
}

/// A captains draft in progress.
///
/// The order is worked out once, when the draft starts, and then walked. It is
/// team ids repeated: a 2v2 with four teams is eight entries long, and a snake
/// order reverses on every other pass. The client never rebuilds it, because
/// captains pick concurrently and a locally computed turn would disagree.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    /// Team ids, in the order they pick.
    pub order: Vec<String>,
    /// How far along it is: the index into `order`.
    pub current: i32,
    /// The pick that can still be taken back.
    pub last_pick: Option<DraftPick>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DraftPick {
    pub player_id: String,
    pub team_id: String,
    /// Where in the order it was, which is what decides whether a captain may
    /// still undo it: only if nobody has picked since.
    pub at_index: i32,
}

impl Draft {
    /// The team whose pick is due, or `None` once the order is walked.
    pub fn turn(&self) -> Option<&str> {
        let at = usize::try_from(self.current).ok()?;
        self.order.get(at).map(String::as_str)
    }

    /// How many picks are left, for the "3 to go" line.
    pub fn remaining(&self) -> i32 {
        (self.order.len() as i32 - self.current).max(0)
    }
}

/// One entrant, as a person rather than a name.
///
/// `faf_id` is a first-class field here. Under Challonge the account had to be
/// hidden in a 255-character `misc` field, and half the client's features hung
/// on that trick.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TourneyPlayer {
    pub id: String,
    pub name: String,
    pub faf_id: Option<i32>,
    /// Rating as of the tournament's own rating date, after any cap the
    /// organiser set.
    pub rating: Option<i32>,
    /// The same rating before the cap, so the UI can show what was capped.
    pub rating_actual: Option<i32>,
    pub team_id: Option<String>,
    /// Entered by an organiser rather than by signing up.
    pub manual: bool,
    /// Signed up after signups closed.
    pub late: bool,
    /// Waiting on an organiser to accept the signup.
    pub pending: bool,
    /// A note the organiser attached, shown beside the name. Renaming is not
    /// possible: identity comes from FAF, so this is how a substitute or a
    /// late arrival gets labelled.
    pub note: String,
    /// Unix seconds.
    pub signed_at: Option<u32>,
}

/// A team, which for a 1v1 event is one player.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TourneyTeam {
    pub id: String,
    pub name: String,
    pub seed: i32,
    pub captain_id: Option<String>,
    pub player_ids: Vec<String>,
    pub division: i32,
    pub checked_in: bool,
    pub eliminated: bool,
    /// Where the run ended. `None` for a team still in it, and for every team
    /// while the bracket has not produced a loser yet.
    pub out: Option<TeamExit>,
    pub final_rank: Option<i32>,
    /// Whether the captain has already used their one rename.
    ///
    /// The server counts it and refuses a second, so the control is withdrawn
    /// rather than offered and then refused. An organiser is not limited.
    pub captain_renamed: bool,
    /// Players who asked to join, awaiting the captain.
    ///
    /// The only way onto a team: the server retired instant self-joining and
    /// answers `join_team` with "send a join request, the captain approves it".
    pub join_requests: Vec<TeamRequest>,
    /// Players the captain asked, awaiting their answer. The same thing in the
    /// other direction.
    pub invites: Vec<TeamRequest>,
}

/// One side asking the other about a team place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamRequest {
    pub player_id: String,
    /// The name as it was at the time, so a list reads without a second lookup.
    pub name: String,
    /// Unix seconds.
    pub at: Option<u32>,
}

impl TourneyTeam {
    /// What to call this team on screen.
    ///
    /// Falls back to the first player added, which is what an organiser expects
    /// for a team that never named itself, and is much better than an id.
    pub fn display_name(&self, players: &[TourneyPlayer]) -> String {
        let named = self.name.trim();
        if !named.is_empty() {
            return named.to_string();
        }
        self.player_ids
            .first()
            .and_then(|id| players.iter().find(|player| &player.id == id))
            .map(|player| player.name.clone())
            .unwrap_or_default()
    }
}

/// What the service says this account may do in one tournament.
///
/// `GET /api/t/{id}` sets a `viewer` block on the response after `publicView`
/// builds the document, which is why it is invisible when reading `publicView`
/// alone. Taken as given rather than worked out client-side: the same session
/// check produces it and authorises every write, so a second opinion here could
/// only ever disagree with the one that counts.
///
/// None of it is an authorisation decision. The service re-checks every write;
/// being wrong here shows a control that is then refused, which is a cosmetic
/// fault, not a hole.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TourneyViewer {
    pub logged_in: bool,
    pub organiser: bool,
    pub faf_id: Option<i32>,
    pub faf_name: String,
    /// This account's entry, when it has signed up. The handle every player
    /// action is addressed with.
    pub signed_up_player_id: Option<String>,
    /// The team this account plays in.
    pub member_team_id: Option<String>,
    /// Whether this account casts this event.
    ///
    /// A caster is shown every match chat rather than only their own. The
    /// service decides it and sends every room accordingly, so this is read to
    /// *say* so rather than to filter: a list that silently held more rooms
    /// than a player's would look like a bug.
    pub caster: bool,
    /// The newest announcement this account has read, in Unix seconds.
    ///
    /// Kept by the service rather than locally, which is the point of it: the
    /// badge clears on every device rather than once per machine. `None` for a
    /// reader who is not signed in, where nothing is remembered at all.
    pub news_read_at: Option<u32>,
}

impl TourneyViewer {
    pub fn is_signed_up(&self) -> bool {
        self.signed_up_player_id.is_some()
    }
}

/// Somebody the organiser asked to enter.
///
/// Only organisers see these; the server leaves the field out otherwise.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TourneyInvite {
    pub faf_id: i32,
    pub name: String,
    pub status: InviteStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum InviteStatus {
    #[default]
    Pending,
    Accepted,
    Declined,
}

impl InviteStatus {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "accepted" => Self::Accepted,
            "declined" => Self::Declined,
            _ => Self::Pending,
        }
    }
}

/// How the organiser wants the bracket seeded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum SeedOrder {
    /// Shuffle. The server does the shuffling, so nobody can claim the client
    /// picked a favourable draw.
    Randomise,
    /// An explicit order, best seed first. Must name every team exactly once,
    /// which the server checks and so does [`Self::is_complete`].
    Explicit { team_ids: Vec<String> },
}

impl SeedOrder {
    /// Whether an explicit order names every team exactly once.
    ///
    /// The server refuses anything else with "seed order must include every
    /// team exactly once", so the control is disabled rather than the organiser
    /// finding out after a drag.
    pub fn is_complete(&self, teams: &[TourneyTeam]) -> bool {
        let Self::Explicit { team_ids } = self else {
            return true;
        };
        if team_ids.len() != teams.len() {
            return false;
        }
        teams
            .iter()
            .all(|team| team_ids.iter().filter(|id| *id == &team.id).count() == 1)
    }
}
