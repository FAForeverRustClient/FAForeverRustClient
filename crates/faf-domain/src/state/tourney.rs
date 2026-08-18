//! The faf-tournaments model: FAF's own tournament service.
//!
//! Replaces the Challonge bridge in `state::tournaments`, which stays in place
//! until this path is complete. Challonge modelled a tournament, its entrants
//! and its matches, and nothing else; everything FAF events actually need had
//! to be smuggled into free-text fields or left out. This service models it
//! properly: teams of 1–6, map pools per round with their own map database,
//! vetoes, drafts, divisions, check-in windows and rating gates.
//!
//! Two differences from the Challonge types drive most of the work here:
//!
//! 1. **Ids are strings** (`p1a2b`, `m1a2b`), not database serials. Nothing may
//!    parse them or assume ordering: they are opaque handles.
//! 2. **The bracket is an explicit graph.** A match names where its winner and
//!    loser go ([`TourneyMatch::winner_to`]), so the tree is read rather than
//!    inferred from round numbers. Challonge left that to be guessed at, which
//!    is why drawing connectors was ever a geometry problem.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::{PlayerSummary, RequestFailureKind};

/// Where a match sends the player it produces.
///
/// The edge that makes the bracket a real graph: `slot` is which side of the
/// destination match this feeds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MatchLink {
    pub match_id: String,
    /// 1 or 2, matching `team1` / `team2` on the destination.
    pub slot: i32,
}

/// How far a single match has got.
///
/// The server's own five values (`lib/match.js`). A series that has been played
/// but not decided sits at [`Self::Live`] with a running score, which is why
/// "reported" is not a status here: a submitted-but-unconfirmed result is a
/// separate field, [`TourneyMatch::pending_report`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MatchStatus {
    /// Waiting on a feeder match to produce an entrant.
    #[default]
    Waiting,
    /// Both sides known; it can be played and reported.
    Ready,
    /// Under way: some games of the series are in, none has clinched it.
    Live,
    /// Walkover. One side advances without a game being played.
    Bye,
    Done,
}

impl MatchStatus {
    /// Read leniently: an unknown value means "not playable yet" rather than a
    /// parse failure. Erring towards `Waiting` only hides a control; erring
    /// towards `Ready` would offer a report the server then rejects.
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "ready" => Self::Ready,
            "live" => Self::Live,
            "bye" => Self::Bye,
            "done" => Self::Done,
            _ => Self::Waiting,
        }
    }
}

/// Which part of the event a match belongs to.
///
/// An explicit field here, where Challonge used the sign of the round number.
/// The server writes `wb` / `lb` / `gf` / `sw` / `ffa`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BracketSide {
    #[default]
    Winners,
    Losers,
    /// The bout between the two bracket winners.
    GrandFinal,
    /// A Swiss round, which has no elimination tree at all.
    Swiss,
    /// A free-for-all round: many entrants, no two sides.
    FreeForAll,
}

impl BracketSide {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "l" | "lb" | "losers" | "lower" => Self::Losers,
            "gf" | "grandfinal" | "grand_final" => Self::GrandFinal,
            "sw" | "swiss" => Self::Swiss,
            "ffa" => Self::FreeForAll,
            _ => Self::Winners,
        }
    }

    /// The service's own spelling, which is also the first half of a pool
    /// assignment key (`wb:1`).
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Winners => "wb",
            Self::Losers => "lb",
            Self::GrandFinal => "gf",
            Self::Swiss => "sw",
            Self::FreeForAll => "ffa",
        }
    }
}

/// One row of the standings table.
///
/// Deliberately one shape for every format rather than three: the pane draws a
/// table, and which columns carry meaning is the format's business, not the
/// table's. `wins`, `losses` and `game_diff` are Swiss's; everywhere else they
/// are zero and the pane leaves those columns out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Standing {
    pub team_id: String,
    /// The place as shown, or `None` for a team whose run has not ended.
    ///
    /// Ties share a place: two teams knocked out in the same round are both
    /// third, which is what an elimination bracket actually decided.
    pub place: Option<i32>,
    pub outcome: StandingOutcome,
    pub wins: i32,
    pub losses: i32,
    pub game_diff: i32,
}

/// Why a team sits where it does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum StandingOutcome {
    Champion,
    /// Not knocked out, and not the champion: still playing.
    StillIn,
    LostFinal,
    #[serde(rename_all = "camelCase")]
    OutIn {
        bracket: BracketSide,
        round: i32,
    },
    /// An imported event's own placing, with no match history behind it.
    Placed,
    /// A Swiss row, where the record is the whole story.
    Swiss,
}

/// Which table the standings are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum StandingsKind {
    /// Nothing to show: the bracket has not been drawn.
    #[default]
    None,
    /// Wins, losses and game difference.
    Swiss,
    /// Places, with how far each run got.
    Elimination,
    /// Places an import brought with it.
    Imported,
    /// A running points total over the free-for-all rounds.
    Points,
}

/// One line of a tournament's audit log.
///
/// Organiser-only: the service withholds `tlog` from everybody else, and sends
/// at most the last three hundred lines, newest first. Every organiser write
/// leaves one, which makes it the only place a co-organiser can see what
/// somebody else changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    /// Unix seconds. The service stores milliseconds.
    pub at: Option<u32>,
    /// Who did it, already rendered by the service: an organiser's name, or a
    /// phrase like "Organizer link" for a token holder with no account.
    pub by: String,
    /// What they did, as a sentence the service composed.
    pub text: String,
}

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

/// The ban/pick run of one match.
///
/// Built by the service from the round's pool when the match becomes playable,
/// and then walked one step at a time. Every field here is state the service
/// keeps: nothing is worked out client-side, because two captains act on it
/// concurrently and a client that guessed would show one of them a stale turn.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MatchVeto {
    /// Map ids still in play, in no meaningful order.
    pub remaining: Vec<String>,
    pub banned: Vec<VetoChoice>,
    /// Picked maps, in the order the games are played.
    pub picks: Vec<VetoChoice>,
    /// The order being walked, copied from the pool at the time it started, so
    /// editing the pool afterwards cannot change a run already under way.
    pub sequence: Vec<PoolStep>,
    /// How far along it is: the index into `sequence`.
    pub step_index: i32,
    /// Which team is A. Empty until an organiser says, and the run cannot start
    /// before they do.
    pub team_a: Option<String>,
    pub team_b: Option<String>,
    pub done: bool,
    /// The map left over once the order is walked, played as the last game.
    pub decider: Option<VetoDecider>,
}

/// One ban or pick that has been made.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VetoChoice {
    /// The map id, which is a key into the event's own map database.
    pub map: String,
    /// The team that made it.
    pub by: String,
    /// Which game of the series it is. Only picks carry one.
    pub game: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VetoDecider {
    pub map: String,
    pub game: i32,
}

/// Whose turn it is, and what they owe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VetoTurn {
    pub team_id: String,
    pub action: PoolAction,
    /// Which side of the sequence it is, which is what the service checks
    /// against rather than the team id.
    pub side: PoolSide,
}

/// Whether an event runs vetoes at all, and how.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VetoConfig {
    pub enabled: bool,
    pub mode: VetoMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum VetoMode {
    /// The whole order is walked before the first game.
    #[default]
    Upfront,
    /// One step between games.
    Continuous,
}

impl VetoMode {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "continuous" => Self::Continuous,
            _ => Self::Upfront,
        }
    }
}

impl MatchVeto {
    /// Whose turn it is, or `None` when the run is finished, has not been given
    /// its sides, or has walked off the end of its order.
    ///
    /// Twin of `lib/match.js::vetoCurrentStep`, and the rule the whole panel
    /// gates on: acting out of turn is refused with "Not your turn".
    pub fn current_turn(&self) -> Option<VetoTurn> {
        if self.done {
            return None;
        }
        let (team_a, team_b) = (self.team_a.as_ref()?, self.team_b.as_ref()?);
        let step = self.sequence.get(usize::try_from(self.step_index).ok()?)?;
        let team = match step.team {
            PoolSide::A => team_a,
            PoolSide::B => team_b,
        };
        Some(VetoTurn {
            team_id: team.clone(),
            action: step.action,
            side: step.team,
        })
    }

    /// Whether an organiser may still say which team is A.
    ///
    /// Only before the first step: the order is written in terms of A and B, so
    /// swapping them afterwards would reassign bans that have already been made.
    pub fn may_set_sides(&self) -> bool {
        self.step_index == 0 && !self.done
    }
}

/// How a free-for-all event is run.
///
/// A free-for-all has no two sides: a round is a set of lobbies, each with
/// several entrants, and what carries forward is either the top few of each
/// lobby or a running points total. Everything the bracket takes for granted
/// (two teams, a winner, a loser) is absent, which is why it is configured
/// rather than inferred.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FfaConfig {
    /// Entrants per lobby.
    pub per_match: i32,
    /// How many of each lobby go through, in elimination mode.
    pub advance: i32,
    pub mode: FfaMode,
    pub rounds: i32,
    /// Cut the field to this many before the last rounds. Zero for no cut.
    pub cut_to: i32,
    /// Entrants in the final. Zero to let it fall out of the format.
    pub final_size: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FfaMode {
    /// The top few of each lobby go through; the rest are out.
    #[default]
    Elimination,
    /// Everybody plays every round and the points decide.
    Points,
}

impl FfaMode {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "points" => Self::Points,
            _ => Self::Elimination,
        }
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Elimination => "elim",
            Self::Points => "points",
        }
    }
}

/// One entrant's score in one free-for-all lobby.
///
/// A list rather than a map: the service sends an object keyed by team id, and
/// an ordered list is what the table needs anyway.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamPoints {
    pub team_id: String,
    pub points: i32,
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

/// One match.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TourneyMatch {
    pub id: String,
    pub bracket: BracketSide,
    pub round: i32,
    /// Position within the round, as the server ordered it.
    pub index: i32,
    /// Best-of for this match. Can differ per round, and an organiser may
    /// override a single one.
    pub best_of: i32,
    /// Handicap games granted to one side, used by lower-bracket rules.
    pub handicap: i32,
    pub division: i32,
    /// Team ids. `None` while the slot waits on a feeder.
    pub team1: Option<String>,
    pub team2: Option<String>,
    pub score1: Option<i32>,
    pub score2: Option<i32>,
    pub status: MatchStatus,
    pub winner: Option<String>,
    pub loser: Option<String>,
    pub winner_to: Option<MatchLink>,
    pub loser_to: Option<MatchLink>,
    /// A score one side submitted, waiting for the other to agree.
    pub pending_report: Option<PendingReport>,
    /// The ban/pick run, when the event has vetoes and this match has reached
    /// the point of having one.
    pub veto: Option<MatchVeto>,
    /// Everyone in this free-for-all lobby. Empty for a two-sided match, which
    /// uses `team1`/`team2` instead.
    pub entrants: Vec<String>,
    /// Who went through. One entrant in a final, `advance` of them otherwise.
    pub winners: Vec<String>,
    /// Points per entrant, in points mode. Empty until the lobby is reported.
    pub points: Vec<TeamPoints>,
    /// Whether this lobby decides the event.
    pub is_final: bool,
    /// FAF replay ids for the games played so far, in the order they were
    /// confirmed. The server insists on one per newly reported game, which is
    /// what makes a bracket auditable after the fact.
    pub replay_ids: Vec<String>,
}

impl TourneyMatch {
    /// Whether this match can be played and reported now.
    ///
    /// `Live` counts: a series at 1-1 is still being played, and the next game
    /// is reported onto it.
    pub fn is_playable(&self) -> bool {
        matches!(self.status, MatchStatus::Ready | MatchStatus::Live)
            && self.team1.is_some()
            && self.team2.is_some()
    }

    /// The side that gets the win when `team_id` forfeits.
    ///
    /// `None` when the forfeiting team is not in this match, or when the other
    /// slot is still waiting on a feeder: the server refuses both, and it cannot
    /// award a walkover to nobody.
    pub fn forfeit_opponent(&self, team_id: &str) -> Option<&str> {
        let other = self.opponent_of(team_id)?;
        (other != "BYE").then_some(other)
    }

    /// The other side of the match from `team_id`, if it is in it at all.
    pub fn opponent_of(&self, team_id: &str) -> Option<&str> {
        match (self.team1.as_deref(), self.team2.as_deref()) {
            (Some(one), other) if one == team_id => other,
            (other, Some(two)) if two == team_id => other,
            _ => None,
        }
    }
}

/// A result one team submitted, which the other has to confirm.
///
/// Modelled because it is the whole point of player reporting: until the
/// opposing team agrees, the bracket has not moved, and both sides need to see
/// that in the same place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingReport {
    pub score1: i32,
    pub score2: i32,
    /// The team that submitted it.
    pub by_team: String,
    /// Who submitted it, for the "waiting on X" line.
    pub by_name: String,
    pub replay_ids: Vec<String>,
    /// Unix seconds.
    pub at: Option<u32>,
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

/// One map in a tournament's own map database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TourneyMap {
    pub id: String,
    pub name: String,
    /// Preview image served by the tournament server, when it has one.
    ///
    /// Usually empty, and that is fine: the client prefers FAF's own vault
    /// preview anyway (see [`match_vault_map`]). The tournament server's copy
    /// exists for maps that are not in the vault at all.
    pub image_url: String,
    /// The organiser's note about it: a spawn count, a mod requirement, why it
    /// is in the pool at all.
    pub description: String,
    /// Whether players can see it.
    ///
    /// The service hides an unpublished map from everyone but the organisers,
    /// with one exception it makes itself: a map already on screen in a live
    /// veto or an assigned round keeps its name, or players would be looking at
    /// a raw id.
    pub published: bool,
}

/// Reduce a map name to something two spellings of it can be compared by.
///
/// Tournament organisers type map names by hand: `Seton's Clutch`,
/// `setons clutch`, `SCMP_009`, `Seton's Clutch.v0001`. The vault's own
/// `display_name` and `folder_name` are a third and fourth spelling again.
/// Comparing on letters and digits alone is what makes those the same map,
/// without needing a lookup table nobody would maintain.
pub fn map_key(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Strip a version suffix like `.v0001` before comparing.
fn without_version(folder: &str) -> &str {
    folder.split(".v").next().unwrap_or(folder)
}

/// Find the vault map a tournament map refers to.
///
/// Preferred over the tournament server's own image: the vault preview is the
/// picture players already recognise from the maps tab, it is served by FAF,
/// and it is there for every map in the vault whether or not an organiser
/// uploaded one.
///
/// Matches the display name first and the folder name second, so
/// `Seton's Clutch` and `scmp_009` both resolve. `None` when nothing matches,
/// which is a real case: a tournament may run a map that was never uploaded.
pub fn match_vault_map<'a, M>(
    tourney_map: &TourneyMap,
    vault: &'a [M],
    display_name: impl Fn(&M) -> &str,
    folder_name: impl Fn(&M) -> &str,
) -> Option<&'a M> {
    let wanted = map_key(&tourney_map.name);
    if wanted.is_empty() {
        return None;
    }
    // The version has to come off *both* sides for the folder comparison: an
    // organiser who copied `scmp_009.v0001` out of their maps directory is
    // naming the same map as the vault's `scmp_009.v0002`.
    let wanted_folder = map_key(without_version(tourney_map.name.trim()));
    vault
        .iter()
        .find(|candidate| map_key(display_name(candidate)) == wanted)
        .or_else(|| {
            vault
                .iter()
                .find(|candidate| map_key(without_version(folder_name(candidate))) == wanted_folder)
        })
}

/// A named set of maps, with the ban/pick order it is played in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MapPool {
    pub id: String,
    pub name: String,
    pub map_ids: Vec<String>,
    /// The ban/pick order, as the organiser arranged it.
    ///
    /// One step short of the pool's map count: every map but one is consumed,
    /// and the survivor is the decider.
    pub sequence: Vec<PoolStep>,
    pub best_of: Option<i32>,
    /// Whether players can see this pool. Publishing one also publishes every
    /// map in it, because a visible pool of invisible maps is a list of ids.
    pub published: bool,
    /// A scheduled reveal, in Unix seconds. Cleared once it fires, and ignored
    /// outright for a pool that is already out.
    pub publish_at: Option<u32>,
}

/// One step of a pool's ban/pick order.
///
/// Objects on the wire, not strings. Read as a flat list of names until a
/// recorded response showed otherwise, which silently emptied every sequence:
/// `lib/match.js::cleanSequence` keeps only `{action, team}` pairs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolStep {
    pub action: PoolAction,
    /// Which side takes the step. The service decides which team is A per
    /// match, from the pool's `abMode`.
    pub team: PoolSide,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PoolAction {
    #[default]
    Ban,
    Pick,
}

impl PoolAction {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "pick" => Self::Pick,
            _ => Self::Ban,
        }
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Ban => "ban",
            Self::Pick => "pick",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PoolSide {
    #[default]
    A,
    B,
}

impl PoolSide {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_uppercase().as_str() {
            "B" => Self::B,
            _ => Self::A,
        }
    }

    /// Upper case, and that is not cosmetic: `lib/match.js::cleanSequence`
    /// compares against `'A'` and `'B'` exactly and drops any step that matches
    /// neither, so a lower-case side loses the step without an error.
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::A => "A",
            Self::B => "B",
        }
    }
}

/// Team size and shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Competition {
    #[default]
    Team,
    FreeForAll,
}

impl Competition {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "ffa" | "freeforall" => Self::FreeForAll,
            _ => Self::Team,
        }
    }
}

/// How teams come together.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Formation {
    /// One player per team.
    #[default]
    Solo,
    /// Players create teams and invite each other.
    Open,
    /// Captains pick in turn.
    Draft,
}

impl Formation {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "draft" => Self::Draft,
            "open" | "premade" => Self::Open,
            _ => Self::Solo,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BracketKind {
    #[default]
    Single,
    Double,
    Swiss,
}

impl BracketKind {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "double" => Self::Double,
            "swiss" => Self::Swiss,
            _ => Self::Single,
        }
    }
}

/// Where an event stands in its own lifecycle.
///
/// The server's own five values, not Challonge's. Anything unrecognised is
/// [`Self::Unknown`] rather than a guess, because the UI gates real actions on
/// this.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TourneyStatus {
    /// A captains draft is running: the teams exist, their captains are taking
    /// turns picking, and nobody else can do anything yet.
    ///
    /// Not "announced but not open", which is what this said until the draft was
    /// built and `lib/teams.js:53` was read: the service moves an event here
    /// from `signup` when `start_draft` runs.
    #[default]
    Draft,
    /// Taking signups.
    Signup,
    /// Signups closed and teams formed; seeds can still change, the bracket has
    /// not been drawn. A player can do nothing here but check in.
    Drafted,
    /// Bracket drawn, matches being played.
    Running,
    Finished,
    Unknown,
}

impl TourneyStatus {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "draft" => Self::Draft,
            "signup" => Self::Signup,
            "drafted" => Self::Drafted,
            "running" => Self::Running,
            "finished" => Self::Finished,
            _ => Self::Unknown,
        }
    }

    /// Whether the bracket exists and is being played or has been.
    pub fn has_bracket(self) -> bool {
        matches!(self, Self::Running | Self::Finished)
    }
}

/// Who runs the event, which decides whether FAF's rules articles apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TourneyCategory {
    /// Run by FAF itself; the site-wide rules pages apply.
    Official,
    #[default]
    Community,
}

impl TourneyCategory {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "official" => Self::Official,
            _ => Self::Community,
        }
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

/// Rating limits an organiser set on entry.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RatingGate {
    pub min: Option<i32>,
    pub max: Option<i32>,
    /// Ceiling on a whole team's combined rating.
    pub max_team: Option<i32>,
    /// Individual ratings are counted as at most this when summing a team.
    pub cap: Option<i32>,
}

/// A complete tournament, as `GET /api/t/{id}` returns it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Tourney {
    pub id: String,
    pub name: String,
    /// The rules, as the organiser wrote them. Reduced to plain text on the way
    /// in: it is third-party markup and must never reach the document.
    pub description: String,
    pub status: TourneyStatus,
    pub category: TourneyCategory,
    pub competition: Competition,
    pub formation: Formation,
    pub bracket_kind: BracketKind,
    /// 1 to 6.
    pub team_size: i32,
    pub divisions: i32,
    /// The entrant cap the organiser set, or 0 for none.
    ///
    /// Read because the round projection needs it: before anybody has entered,
    /// a cap is the only thing that says how large the bracket will be, and
    /// preparing map pools during signups turns on knowing that.
    pub max_teams: i32,
    /// Whether players may report their own results, or only organisers can.
    ///
    /// Read but never written as true: the client has no player reporting path,
    /// and both write bodies say so explicitly. It still matters on the way in,
    /// because a report raised on the *website* has to be answerable here.
    pub player_reporting: bool,
    /// How entrants get in.
    ///
    /// Sent with every answer and read for a concrete reason: the edit form
    /// resends it, so an event whose mode the client could not see would be
    /// reopened to everyone the first time somebody corrected its name.
    pub signup_mode: SignupMode,
    pub veto_enabled: bool,
    pub rating: RatingGate,
    /// Which FAF rating the event seeds and gates on, or [`RatingKind::None`].
    ///
    /// Sent with every answer, and worth reading for one concrete reason: an
    /// unrated event has no rating to fetch, so the organiser supplies one when
    /// adding an entrant. Without this the client cannot tell the two apart, and
    /// the field it needs stays hidden.
    pub rating_kind: RatingKind,
    /// The instant ratings were frozen at, in Unix seconds.
    ///
    /// What stops an entrant signing up on a peak rating and playing weeks later
    /// on a lower one: every rating in the event is the value as of this date.
    /// Shown rather than acted on: the server does the freezing.
    pub rating_date: Option<u32>,
    /// Unix seconds.
    pub created_at: Option<u32>,
    pub event_date: Option<u32>,
    pub signup_opens_at: Option<u32>,
    pub signup_closes_at: Option<u32>,
    pub check_in_opens_at: Option<u32>,
    pub check_in_deadline: Option<u32>,
    /// Whether posting is closed. Reading an old event's chat stays possible;
    /// the server locks writing two days after the event ends.
    pub chat_locked: bool,
    /// Whether this event bans and picks its maps, and how.
    pub veto: VetoConfig,
    /// How the free-for-all is run. `None` for a team event.
    pub ffa: Option<FfaConfig>,
    /// The captains draft, while one is running. `None` for every other
    /// formation and before it starts.
    pub draft: Option<Draft>,
    /// The entrants an organiser marked as captains before starting a draft.
    /// They become the captains of the teams the service creates.
    pub pending_captains: Vec<String>,
    /// Whether the draft order snakes back on every other pass, rather than
    /// running the same way each time.
    pub draft_snakes: bool,
    /// Whether this event's results came from somewhere else.
    ///
    /// An imported bracket carries its source's own final placings and often
    /// nothing else, so the standings are read off `final_rank` rather than
    /// worked out from the matches.
    pub imported: bool,
    /// Whether anyone but the organiser can see this event.
    ///
    /// `POST /api/tournaments` creates with this false, and the list endpoint
    /// then shows the row to its organisers alone. An event that is missing
    /// from the list for everybody else is not a bug in the list: it was never
    /// published, and only `publish` changes that.
    pub published: bool,
    /// When publication is scheduled for, in Unix seconds, or `None` for an
    /// event that is either already out or has no date set.
    pub publish_at: Option<u32>,
    /// How many have entered, and how many teams they formed.
    ///
    /// Held separately because the list endpoint sends only these numbers while
    /// the detail sends the people. One row type for both means the list can
    /// say "14 entrants" without a second request per tournament.
    pub player_count: i32,
    pub team_count: i32,
    pub players: Vec<TourneyPlayer>,
    pub teams: Vec<TourneyTeam>,
    pub matches: Vec<TourneyMatch>,
    pub map_db: Vec<TourneyMap>,
    pub map_pools: Vec<MapPool>,
    /// Which pool is played in which round, keyed by the server's round label.
    pub pool_assign: Vec<PoolAssignment>,
    pub organisers: Vec<String>,
    /// The organiser's announcements, newest first.
    pub news: Vec<NewsPost>,
    /// People the organiser invited. Empty for anyone who is not one: the
    /// server omits the field rather than trimming it.
    pub invites: Vec<TourneyInvite>,
    /// The organiser-only audit log, newest first. Empty for everyone else,
    /// because the service does not send it to them.
    pub audit_log: Vec<AuditEntry>,
    /// Every organiser, including any who hid themselves from the public list.
    /// Organiser-only, like the log.
    pub organiser_accounts: Vec<Organiser>,
    /// Accounts silenced in this event's chat. Organiser-only.
    pub chat_mutes: Vec<ChatMute>,
    /// Who is casting this event. Organiser-only, like the lists above.
    pub casters: Vec<Caster>,
    /// Called off rather than played: too few signups, usually.
    ///
    /// Distinct from archived, which hides the event. An abandoned one stays
    /// visible and finished-looking, and saying so is the whole point: an event
    /// with an empty bracket and no explanation reads as broken.
    pub abandoned: bool,
    /// Whether this account has been silenced in the event's chat.
    ///
    /// Read for one reason: a muted player's post is refused with a sentence
    /// they see only after typing it. Knowing beforehand turns that into a
    /// closed composer with a reason.
    pub chat_muted_me: bool,
    /// The series this edition belongs to, where it belongs to one.
    ///
    /// Three fields for one relationship because the service resolves it for
    /// us: the id is what `set_series` writes, and the name and colour are the
    /// series' own, sent alongside so a row can be labelled without a second
    /// request per tournament.
    pub series_id: Option<String>,
    pub series_name: String,
    pub series_colour: SeriesColour,
    /// Events whose results feed entrants into this one. Organiser-facing, but
    /// sent to everybody: who qualifies for a final is public information.
    pub qualifiers: Vec<Qualifier>,
    /// The event this one feeds, where it feeds one. Derived by the service
    /// from every other tournament's links, never stored on this side.
    pub feeds_into: Option<FeedsInto>,
    pub champion_team_id: Option<String>,
    /// What this account may do here, as the server sees it.
    pub viewer: TourneyViewer,
}

/// A chat room this account is allowed to see.
///
/// Visibility is decided server-side by permission, so the client shows what it
/// is given rather than filtering: an organisers-only room simply never arrives.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatRoom {
    pub id: String,
    pub name: String,
    /// Messages posted since this account last opened the room.
    pub unread: i32,
    /// Whether the match this room belongs to has been played.
    ///
    /// A room per match adds up fast, and a finished one is a conversation
    /// nobody is having any more. The service says which, and the list folds
    /// them into a group that starts collapsed rather than leaving a bracket's
    /// worth of dead rooms above the live ones.
    pub done: bool,
    /// Whether this account was named with `@` in this room and has not opened
    /// it since.
    ///
    /// Louder than the unread count and shown instead of it: being addressed
    /// by name is a different thing from a room having moved on, and it is the
    /// one a player is scanning for.
    pub mentioned: bool,
    /// Whether somebody typed `!organizer` here and no organiser has read it.
    ///
    /// Organiser-facing: it exists so they can find the room that wants them
    /// without skimming every one. The service clears it when an organiser
    /// opens the room.
    pub needs_organiser: bool,
    /// How many messages the room holds in total.
    pub count: i32,
}

impl ChatRoom {
    /// The badge this room shows, if any.
    ///
    /// One at a time, in the order a reader cares about them: being named
    /// beats a room having moved on, and both beat nothing. The organiser bell
    /// is not in here because it is drawn alongside rather than instead, and
    /// only for organisers.
    pub fn badge(&self) -> RoomBadge {
        if self.mentioned {
            RoomBadge::Mentioned
        } else if self.unread > 0 {
            RoomBadge::Unread
        } else {
            RoomBadge::None
        }
    }
}

/// What a room's list entry marks itself with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RoomBadge {
    #[default]
    None,
    Unread,
    Mentioned,
}

/// One post in a tournament chat room.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatPost {
    pub id: String,
    pub author: String,
    /// The FAF account behind the name, where there is one. `None` for a
    /// system line and for anyone posting through a token rather than a login.
    ///
    /// Read so an organiser can silence the author of the post in front of
    /// them: `chat_mute` is addressed by account, and the name beside a post is
    /// free text with nothing to resolve it against.
    pub faf_id: Option<i32>,
    pub body: String,
    /// Unix seconds.
    pub at: Option<u32>,
    /// The server's own announcements, such as dice rolls and organiser pings, which the
    /// room shows differently from something a person typed.
    pub system: bool,
}

/// A rules or FAQ page.
///
/// Site-wide rather than per-tournament: the tournament team writes them once
/// and every official event points at the same text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Article {
    pub id: String,
    pub title: String,
    /// Reduced to plain text on the way in, like every other field somebody
    /// else's editor produced.
    pub body: String,
    /// Set on a sub-page, so the list can be shown as the two levels it is.
    pub parent_id: Option<String>,
}

/// A result the organiser sets on a match.
///
/// The replay id lists stay on the type because `report` accepts them and an
/// archive is worth keeping, but nothing is required to fill them: they are
/// mandatory only on `report_submit`, the *player* path, and that path is not
/// used. `report` guards them with `if (Array.isArray(b.replayIds))`, so an
/// empty list simply stores none.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MatchReport {
    pub match_id: String,
    pub score1: i32,
    pub score2: i32,
    pub replay_ids: Vec<String>,
    /// Replays of games that ended in a draw. They score nothing and were
    /// replayed, but the recordings are still worth keeping.
    pub draw_replay_ids: Vec<String>,
    /// The team to declare the winner, whatever the score says.
    ///
    /// The organiser's override: it finalises a match even when neither side
    /// reached the wins the series needs: a 1-1 that ended in a walkover, or any
    /// inconclusive result that has to be resolved so the bracket can move.
    pub winner: Option<String>,
    /// The team that forfeited.
    ///
    /// On its own, with no score and no winner, this is the shorthand: the other
    /// side is awarded the win and the forfeiting team is recorded at -1. Given
    /// alongside a score, it marks *how* a played series ended.
    pub forfeit: Option<String>,
}

impl MatchReport {
    /// How many games this report adds to what is already confirmed.
    ///
    /// Still worth knowing, since an organiser correcting a series wants to see it,
    /// but no longer a gate on submitting.
    pub fn new_games(&self, entry: &TourneyMatch) -> i32 {
        let confirmed = entry
            .score1
            .unwrap_or(if entry.handicap > 0 { 1 } else { 0 })
            + entry.score2.unwrap_or(0);
        (self.score1 + self.score2 - confirmed).max(0)
    }

    /// Whether the server will take this.
    ///
    /// `report`'s own arithmetic, and nothing more: both scores between zero and
    /// the wins the series needs, and not both sides reaching it. A handicapped
    /// grand final starts the upper-bracket side at 1-0, so its first score
    /// cannot be zero.
    ///
    /// Two conditions were removed here on purpose, because they belonged to the
    /// player path this client no longer uses:
    ///
    /// - **One replay id per new game.** Only `report_submit` insists on that.
    ///   Requiring it stopped an organiser entering a score they already knew.
    /// - **That the score went up.** `report` is also the *correction* path: it
    ///   undoes a finished match and sets it again, so a lower score is
    ///   legitimate and refusing it blocked the only way a wrong result is fixed.
    pub fn is_submittable(&self, entry: &TourneyMatch) -> bool {
        // A bare forfeit needs no score at all: the server derives the winner and
        // records the forfeiting side at -1.
        if self.is_bare_forfeit() {
            return entry
                .forfeit_opponent(self.forfeit.as_deref().unwrap_or_default())
                .is_some();
        }
        let needed = (entry.best_of + 1) / 2;
        let scores_fit = self.score1 >= 0
            && self.score2 >= 0
            && self.score1 <= needed
            && self.score2 <= needed
            && !(self.score1 == needed && self.score2 == needed)
            && !(entry.handicap > 0 && self.score1 < 1);
        // A named winner has to be one of the two sides, or the server refuses it.
        let winner_fits = match self.winner.as_deref() {
            None => true,
            Some(team) => {
                entry.team1.as_deref() == Some(team) || entry.team2.as_deref() == Some(team)
            }
        };
        scores_fit && winner_fits
    }

    /// Whether this is the forfeit shorthand: a forfeiting team and nothing else.
    ///
    /// The server takes that on its own (`{forfeit: loserId}` with no score and no
    /// winner) and works the rest out, which is the fastest way to record a
    /// no-show, the commonest reason a bracket stalls.
    pub fn is_bare_forfeit(&self) -> bool {
        self.forfeit.is_some() && self.winner.is_none() && self.score1 == 0 && self.score2 == 0
    }
}

/// A map pool as the organiser assembled it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolDraft {
    /// Empty to create a new pool; an existing id replaces that pool.
    pub id: String,
    pub name: String,
    /// Map ids from the tournament's own map database, in play order.
    pub map_ids: Vec<String>,
    /// The series length this pool is built for. The server welds the ban/pick
    /// order to it, so a pool saved without one is a plain list of maps.
    pub best_of: Option<i32>,
    /// The ban/pick order. Either empty, or exactly one step short of the map
    /// count with `best_of - 1` picks among them: the service refuses anything
    /// else, naming the numbers it wanted.
    pub sequence: Vec<PoolStep>,
}

/// A free-for-all lobby's result.
///
/// One shape for the two ways the service takes it, because a lobby is one or
/// the other and never both: a scored round sends `points`, everything else
/// sends `winners`. `Tourney::ffa_is_scored` says which.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FfaReport {
    pub match_id: String,
    /// Who went through. Empty in a scored round.
    pub winners: Vec<String>,
    /// Points per entrant. Empty in an elimination round.
    pub points: Vec<TeamPoints>,
}

impl FfaReport {
    /// Whether the service would accept it.
    ///
    /// Scored rounds want a number from 0 to 1000 for *every* entrant, and the
    /// service names the range in its refusal. Elimination rounds want exactly
    /// the number of winners the format calls for, no more and no fewer.
    pub fn is_submittable(&self, entry: &TourneyMatch, scored: bool, winners_needed: i32) -> bool {
        if scored {
            let covered = entry
                .entrants
                .iter()
                .all(|id| self.points.iter().any(|scored| &scored.team_id == id));
            return covered
                && !entry.entrants.is_empty()
                && self
                    .points
                    .iter()
                    .all(|scored| (0..=1_000).contains(&scored.points));
        }
        // Winners have to be in the lobby, and there is no sense in naming one
        // twice: the service filters to the lobby and then counts.
        let inside = self.winners.iter().all(|id| entry.entrants.contains(id));
        let mut seen = self.winners.clone();
        seen.sort();
        seen.dedup();
        inside && seen.len() == self.winners.len() && self.winners.len() as i32 == winners_needed
    }
}

/// A map being added to or edited in a tournament's own map database.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MapDraft {
    /// Empty to add a new map; an existing id edits that one.
    pub id: String,
    pub name: String,
    pub description: String,
    pub published: bool,
}

impl MapDraft {
    /// Whether the service would accept it. It insists on a name and nothing
    /// else, so this is the whole rule.
    pub fn is_submittable(&self) -> bool {
        !self.name.trim().is_empty()
    }
}

impl PoolDraft {
    /// Why the service would refuse this pool.
    ///
    /// Its two rules read as arithmetic but are a real constraint: every map but
    /// one is consumed by a step, and every pick is a game, so a Bo3 needs four
    /// maps and three steps of which two are picks. Checked here because the
    /// refusal names numbers the organiser then has to work backwards from.
    pub fn rejection(&self) -> Option<PoolRejection> {
        if self.name.trim().is_empty() {
            return Some(PoolRejection::NameRequired);
        }
        if self.map_ids.is_empty() {
            return Some(PoolRejection::MapsRequired);
        }
        if self.sequence.is_empty() {
            // A pool without an order is legal: it is a plain list of maps.
            return None;
        }
        if self.sequence.len() != self.map_ids.len() - 1 {
            return Some(PoolRejection::StepCountWrong {
                wanted: self.map_ids.len() as i32 - 1,
                got: self.sequence.len() as i32,
            });
        }
        let picks = self
            .sequence
            .iter()
            .filter(|step| step.action == PoolAction::Pick)
            .count() as i32;
        let wanted = self.best_of.unwrap_or(1) - 1;
        if picks != wanted {
            return Some(PoolRejection::PickCountWrong { wanted, got: picks });
        }
        None
    }
}

/// Why a pool cannot be saved, in the order the service checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PoolRejection {
    NameRequired,
    MapsRequired,
    #[serde(rename_all = "camelCase")]
    StepCountWrong {
        wanted: i32,
        got: i32,
    },
    #[serde(rename_all = "camelCase")]
    PickCountWrong {
        wanted: i32,
        got: i32,
    },
}

/// One round of the draw, as the key a map pool is bound by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RoundKey {
    /// The service's own grammar, `{bracket}:{round}`, e.g. `wb:1`.
    pub key: String,
    pub bracket: BracketSide,
    pub round: i32,
    /// The deepest round this bracket has, so a label can say "Final" rather
    /// than "Round 4" without counting the list again.
    pub last_round: i32,
}

/// Which rounds this event will have, and whether that is known or expected.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RoundPlan {
    pub keys: Vec<RoundKey>,
    /// `true` while these are worked out from the expected entrant count rather
    /// than read off a bracket that exists.
    ///
    /// Worth saying out loud in the UI: the projection is what lets an
    /// organiser prepare map pools during signups, and it can gain or lose a
    /// round if the field changes before the draw.
    pub projected: bool,
    /// The team count the projection was made from. Zero once real.
    pub teams: i32,
}

/// One announcement from the organiser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewsPost {
    pub id: String,
    pub body: String,
    /// Who wrote it.
    pub by: String,
    /// Unix seconds.
    pub at: Option<u32>,
    /// When it was last corrected, in Unix seconds, or `None` for a post that
    /// stands as written. Shown rather than acted on: a schedule change that
    /// has itself been changed is worth flagging.
    pub edited_at: Option<u32>,
    /// Marked urgent by the organiser: a schedule change rather than a note.
    pub important: bool,
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

/// A map pool bound to a round.
///
/// A list rather than a map because the state crosses into TypeScript, where an
/// object with server-chosen keys is far more awkward to iterate than an array.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolAssignment {
    /// The server's own key for the round or stage.
    pub round: String,
    pub pool_id: String,
}

impl Tourney {
    pub fn team(&self, id: &str) -> Option<&TourneyTeam> {
        self.teams.iter().find(|team| team.id == id)
    }

    /// The team this account plays for, if any.
    pub fn my_team(&self) -> Option<&TourneyTeam> {
        self.team(self.viewer.member_team_id.as_deref()?)
    }

    /// Whether this account captains `team`.
    ///
    /// Captaincy is what the server checks for answering join requests and
    /// sending invites, and it moves on its own: when a captain leaves, the
    /// next member inherits it.
    pub fn is_captain_of(&self, team: &TourneyTeam) -> bool {
        let Some(mine) = self.viewer.signed_up_player_id.as_deref() else {
            return false;
        };
        team.captain_id.as_deref() == Some(mine)
    }

    pub fn team_is_full(&self, team: &TourneyTeam) -> bool {
        i32::try_from(team.player_ids.len()).unwrap_or(i32::MAX) >= self.team_size
    }

    /// A team's combined rating, which is what `maxTeamRating` is measured
    /// against.
    pub fn team_rating(&self, team: &TourneyTeam) -> i32 {
        team.player_ids
            .iter()
            .filter_map(|id| self.player(id))
            .filter_map(|player| player.rating)
            .sum()
    }

    /// Whether adding this account would put `team` over the organiser's
    /// combined-rating ceiling.
    ///
    /// Checked before offering the request, because the server's refusal is
    /// specific and a little humiliating to read after the fact: it names the
    /// number the team would reach.
    pub fn would_exceed_team_cap(&self, team: &TourneyTeam) -> bool {
        let (Some(cap), Some(mine)) = (self.rating.max_team, self.my_rating()) else {
            return false;
        };
        self.team_rating(team) + mine > cap
    }

    /// This account's rating in this tournament, as the server fetched it.
    pub fn my_rating(&self) -> Option<i32> {
        let mine = self.viewer.signed_up_player_id.as_deref()?;
        self.player(mine)?.rating
    }

    /// Whether the tab should offer forming a team at all.
    ///
    /// Only for events that have teams to form: a solo event's teams are made
    /// by the organiser at the phase change, and a draft event's by the
    /// captains, so in both a "create team" button would be a trap.
    pub fn teams_are_self_organised(&self) -> bool {
        self.formation == Formation::Open
            && self.team_size > 1
            && self.status == TourneyStatus::Signup
    }

    /// Whether this account may start a team of its own.
    pub fn may_create_team(&self) -> bool {
        self.teams_are_self_organised()
            && self.viewer.is_signed_up()
            && self.viewer.member_team_id.is_none()
    }

    /// Whether this account may ask to join `team`.
    pub fn may_request_join(&self, team: &TourneyTeam) -> bool {
        self.may_create_team()
            && !self.team_is_full(team)
            && !self.has_asked_to_join(team)
            && !self.would_exceed_team_cap(team)
    }

    pub fn has_asked_to_join(&self, team: &TourneyTeam) -> bool {
        let Some(mine) = self.viewer.signed_up_player_id.as_deref() else {
            return false;
        };
        team.join_requests
            .iter()
            .any(|asking| asking.player_id == mine)
    }

    /// The teams that have invited this account, newest last.
    ///
    /// Surfaced rather than buried in the team list: an invite is the one thing
    /// in this pane that is waiting on *you*.
    pub fn my_invites(&self) -> Vec<&TourneyTeam> {
        let Some(mine) = self.viewer.signed_up_player_id.as_deref() else {
            return Vec::new();
        };
        self.teams
            .iter()
            .filter(|team| team.invites.iter().any(|invite| invite.player_id == mine))
            .collect()
    }

    /// Signups waiting on the organiser, in request mode.
    ///
    /// The server shows a pending entry only to organisers and to the person
    /// who asked, so this is already the right list for whoever is looking.
    pub fn pending_signups(&self) -> Vec<&TourneyPlayer> {
        self.players
            .iter()
            .filter(|player| player.pending)
            .collect()
    }

    /// Whether seeds can still be changed.
    ///
    /// Only between forming teams and drawing the bracket. Before that there
    /// are no teams; after it the draw is fixed.
    pub fn may_reseed(&self) -> bool {
        self.status == TourneyStatus::Drafted && !self.teams.is_empty()
    }

    /// Entrants with no team yet, which is who a captain can invite.
    pub fn unteamed(&self) -> Vec<&TourneyPlayer> {
        self.players
            .iter()
            .filter(|player| player.team_id.is_none() && !player.pending)
            .collect()
    }

    pub fn player(&self, id: &str) -> Option<&TourneyPlayer> {
        self.players.iter().find(|player| player.id == id)
    }

    /// Everyone on a team, in the order they joined.
    pub fn members(&self, team: &TourneyTeam) -> Vec<&TourneyPlayer> {
        team.player_ids
            .iter()
            .filter_map(|id| self.player(id))
            .collect()
    }

    /// The pool played in `round`, if the organiser bound one.
    pub fn pool_for_round(&self, round: &str) -> Option<&MapPool> {
        let assignment = self
            .pool_assign
            .iter()
            .find(|assignment| assignment.round == round)?;
        self.map_pools
            .iter()
            .find(|pool| pool.id == assignment.pool_id)
    }

    /// The maps in a pool, in the pool's own order.
    pub fn pool_maps(&self, pool: &MapPool) -> Vec<&TourneyMap> {
        pool.map_ids
            .iter()
            .filter_map(|id| self.map_db.iter().find(|map| &map.id == id))
            .collect()
    }

    /// Whether this account may record the result of `entry`.
    ///
    /// The organiser, and nobody else. That is a decision about this client, not
    /// a limit of the service: `report_submit` lets the two players agree a score
    /// between them, but it insists on one FAF replay id per game, and this client
    /// keeps result-entry with the person running the event.
    ///
    /// The server's own conditions for `report`, in its order: the bracket has to
    /// be running or finished, the caller has to be an organiser, and the match
    /// has to have two sides. A finished match stays reportable, because `report` is also
    /// the correction path, and it undoes the old result first.
    pub fn may_report(&self, entry: &TourneyMatch) -> bool {
        self.viewer.organiser
            && self.status.has_bracket()
            && entry.bracket != BracketSide::FreeForAll
            && entry.team1.is_some()
            && entry.team2.is_some()
    }

    /// Which standings table this event has, if any.
    ///
    /// An imported bracket answers with its source's placings even when it has
    /// no matches at all, which is the case `Elimination` cannot serve.
    pub fn standings_kind(&self) -> StandingsKind {
        if self.imported {
            return StandingsKind::Imported;
        }
        if !self.status.has_bracket() {
            return StandingsKind::None;
        }
        if self
            .ffa
            .as_ref()
            .is_some_and(|ffa| ffa.mode == FfaMode::Points)
        {
            return StandingsKind::Points;
        }
        if self.bracket_kind == BracketKind::Swiss {
            return StandingsKind::Swiss;
        }
        StandingsKind::Elimination
    }

    /// The standings, in the order they are shown.
    ///
    /// Worked out here rather than read from the service, because the service
    /// sends no table: the website recomputes it in the browser from the matches
    /// and each team's exit, and so does this. One implementation is what stops
    /// the bracket and the table disagreeing.
    ///
    /// Free-for-all points are not covered. That table is summed from a per
    /// match `points` object the client does not model yet, and inventing an
    /// order without it would be worse than showing none.
    pub fn standings(&self) -> Vec<Standing> {
        match self.standings_kind() {
            StandingsKind::None => Vec::new(),
            StandingsKind::Swiss => self.swiss_standings(),
            StandingsKind::Imported => self.imported_standings(),
            StandingsKind::Points => self.points_standings(),
            StandingsKind::Elimination => self.elimination_standings(),
        }
    }

    /// Wins, losses and game difference over the Swiss rounds.
    ///
    /// A bye counts as a win worth one game, as the service's own table does: a
    /// team that drew the odd number should not sit behind one that played.
    fn swiss_standings(&self) -> Vec<Standing> {
        let mut rows: Vec<Standing> = self
            .teams
            .iter()
            .map(|team| Standing {
                team_id: team.id.clone(),
                place: None,
                outcome: StandingOutcome::Swiss,
                wins: 0,
                losses: 0,
                game_diff: 0,
            })
            .collect();

        for entry in self
            .matches
            .iter()
            .filter(|entry| entry.bracket == BracketSide::Swiss)
        {
            match entry.status {
                MatchStatus::Bye => {
                    // The absent side is a placeholder rather than a team, so
                    // whichever of the two names a real one is who advanced.
                    let advanced = [entry.team1.as_deref(), entry.team2.as_deref()]
                        .into_iter()
                        .flatten()
                        .find_map(|id| rows.iter().position(|row| row.team_id == id));
                    if let Some(at) = advanced {
                        rows[at].wins += 1;
                        rows[at].game_diff += 1;
                    }
                }
                MatchStatus::Done => {
                    let (Some(winner), Some(loser)) = (&entry.winner, &entry.loser) else {
                        continue;
                    };
                    let won_by_first = Some(winner.as_str()) == entry.team1.as_deref();
                    let (high, low) = if won_by_first {
                        (entry.score1, entry.score2)
                    } else {
                        (entry.score2, entry.score1)
                    };
                    let margin = high.unwrap_or(0) - low.unwrap_or(0);
                    if let Some(at) = rows.iter().position(|row| &row.team_id == winner) {
                        rows[at].wins += 1;
                        rows[at].game_diff += margin;
                    }
                    if let Some(at) = rows.iter().position(|row| &row.team_id == loser) {
                        rows[at].losses += 1;
                        rows[at].game_diff -= margin;
                    }
                }
                _ => {}
            }
        }

        rows.sort_by(|left, right| {
            right
                .wins
                .cmp(&left.wins)
                .then(right.game_diff.cmp(&left.game_diff))
                .then(
                    self.seed_of(&left.team_id)
                        .cmp(&self.seed_of(&right.team_id)),
                )
        });
        for (position, row) in rows.iter_mut().enumerate() {
            row.place = Some(position as i32 + 1);
            if Some(row.team_id.as_str()) == self.champion_team_id.as_deref() {
                row.outcome = StandingOutcome::Champion;
            }
        }
        rows
    }

    /// Points summed over every free-for-all lobby.
    ///
    /// The champion is pinned to the top regardless of the total, because the
    /// final decides the event and a points lead going into it does not.
    fn points_standings(&self) -> Vec<Standing> {
        let mut rows: Vec<Standing> = self
            .teams
            .iter()
            .map(|team| Standing {
                team_id: team.id.clone(),
                place: None,
                outcome: if Some(team.id.as_str()) == self.champion_team_id.as_deref() {
                    StandingOutcome::Champion
                } else if team.out.is_some() {
                    StandingOutcome::OutIn {
                        bracket: BracketSide::FreeForAll,
                        round: team.out.as_ref().map_or(0, |exit| exit.round),
                    }
                } else {
                    StandingOutcome::StillIn
                },
                wins: 0,
                losses: 0,
                game_diff: 0,
            })
            .collect();

        for entry in self
            .matches
            .iter()
            .filter(|entry| entry.bracket == BracketSide::FreeForAll)
        {
            for scored in &entry.points {
                if let Some(row) = rows.iter_mut().find(|row| row.team_id == scored.team_id) {
                    // `wins` carries the total: one shape for every table, and
                    // the pane labels the column by the format.
                    row.wins += scored.points;
                }
            }
        }

        let champion = self.champion_team_id.as_deref();
        rows.sort_by(|left, right| {
            let crowned = |row: &Standing| i32::from(Some(row.team_id.as_str()) == champion);
            crowned(right)
                .cmp(&crowned(left))
                .then(right.wins.cmp(&left.wins))
                .then(
                    self.seed_of(&left.team_id)
                        .cmp(&self.seed_of(&right.team_id)),
                )
        });
        for (position, row) in rows.iter_mut().enumerate() {
            row.place = Some(position as i32 + 1);
        }
        rows
    }

    /// The placings an import brought with it. Unplaced teams sort last.
    fn imported_standings(&self) -> Vec<Standing> {
        let mut teams: Vec<&TourneyTeam> = self.teams.iter().collect();
        teams.sort_by_key(|team| (team.final_rank.unwrap_or(i32::MAX), team.seed));
        teams
            .into_iter()
            .map(|team| Standing {
                team_id: team.id.clone(),
                place: team.final_rank,
                outcome: if Some(team.id.as_str()) == self.champion_team_id.as_deref() {
                    StandingOutcome::Champion
                } else {
                    StandingOutcome::Placed
                },
                wins: 0,
                losses: 0,
                game_diff: 0,
            })
            .collect()
    }

    /// Rank by how far each run got, champion first.
    ///
    /// Teams knocked out at the same depth share a place, so a four-team double
    /// elimination reads 1, 2, 3, 3 rather than inventing an order between two
    /// teams that never played each other.
    fn elimination_standings(&self) -> Vec<Standing> {
        let mut teams: Vec<&TourneyTeam> = self.teams.iter().collect();
        teams.sort_by(|left, right| {
            self.depth_of(right)
                .cmp(&self.depth_of(left))
                .then(left.seed.cmp(&right.seed))
        });

        let mut rows = Vec::with_capacity(teams.len());
        let mut previous: Option<i64> = None;
        let mut place = 0;
        for (position, team) in teams.iter().enumerate() {
            let depth = self.depth_of(team);
            if previous != Some(depth) {
                place = position as i32 + 1;
                previous = Some(depth);
            }
            let champion = Some(team.id.as_str()) == self.champion_team_id.as_deref();
            let outcome = match (champion, &team.out) {
                (true, _) => StandingOutcome::Champion,
                (false, None) => StandingOutcome::StillIn,
                (false, Some(exit)) if exit.bracket == BracketSide::GrandFinal => {
                    StandingOutcome::LostFinal
                }
                (false, Some(exit)) => StandingOutcome::OutIn {
                    bracket: exit.bracket,
                    round: exit.round,
                },
            };
            rows.push(Standing {
                team_id: team.id.clone(),
                // Still in it means no place yet: calling somebody fourth while
                // they might still win it is worse than leaving it blank.
                place: if champion {
                    Some(1)
                } else if team.out.is_none() {
                    None
                } else {
                    Some(place)
                },
                outcome,
                wins: 0,
                losses: 0,
                game_diff: 0,
            });
        }
        rows
    }

    /// How far a run got, as one comparable number. Bigger is further.
    ///
    /// The bands sit far apart on purpose: losing the grand final beats any
    /// number of lower-bracket rounds, and being alive beats having lost at all.
    fn depth_of(&self, team: &TourneyTeam) -> i64 {
        if Some(team.id.as_str()) == self.champion_team_id.as_deref() {
            return 1_000_000_000;
        }
        let Some(exit) = &team.out else {
            return 100_000_000;
        };
        match exit.bracket {
            BracketSide::GrandFinal => 1_000_000,
            BracketSide::Losers => 1_000 + i64::from(exit.round),
            _ => i64::from(exit.round),
        }
    }

    fn seed_of(&self, team_id: &str) -> i32 {
        self.team(team_id).map_or(i32::MAX, |team| team.seed)
    }

    /// Whether this account may take the veto step that is due.
    ///
    /// The service allows two people: the captain of the team whose turn it is,
    /// and an organiser acting on their behalf. Everyone else is refused, and a
    /// map grid offered to them would be a grid of buttons that all fail.
    pub fn may_veto(&self, entry: &TourneyMatch) -> bool {
        let Some(veto) = &entry.veto else {
            return false;
        };
        if !self.veto.enabled || entry.status == MatchStatus::Done {
            return false;
        }
        let Some(turn) = veto.current_turn() else {
            return false;
        };
        if self.viewer.organiser {
            return true;
        }
        // Captaincy, not membership: the service checks the captain token or the
        // captain's own session, and a team-mate is refused.
        self.team(&turn.team_id)
            .is_some_and(|team| self.is_captain_of(team))
    }

    /// Whether an organiser may still choose which team is A for this match.
    pub fn may_set_veto_sides(&self, entry: &TourneyMatch) -> bool {
        self.viewer.organiser
            && self.veto.enabled
            && entry
                .veto
                .as_ref()
                .is_some_and(|veto| veto.may_set_sides() && veto.team_a.is_none())
    }

    /// How many winners the service wants for this free-for-all lobby.
    ///
    /// One in a final, and otherwise the smaller of the configured `advance`
    /// and one short of the field: a lobby cannot advance everybody in it. The
    /// service refuses any other count with the number it wanted, so the form
    /// asks for exactly this many rather than finding out afterwards.
    pub fn ffa_winners_needed(&self, entry: &TourneyMatch) -> i32 {
        let Some(ffa) = &self.ffa else {
            return 0;
        };
        let in_lobby = entry.entrants.len() as i32;
        // A round with one lobby left is the final whether or not it says so.
        let only_lobby = self
            .matches
            .iter()
            .filter(|other| other.bracket == BracketSide::FreeForAll && other.round == entry.round)
            .count()
            == 1;
        if entry.is_final || only_lobby {
            return 1;
        }
        ffa.advance.min((in_lobby - 1).max(0))
    }

    /// Whether this lobby is scored rather than won.
    ///
    /// Points mode still decides its final by a winner, which is the one case
    /// where the two paths meet.
    pub fn ffa_is_scored(&self, entry: &TourneyMatch) -> bool {
        self.ffa
            .as_ref()
            .is_some_and(|ffa| ffa.mode == FfaMode::Points)
            && !entry.is_final
    }

    /// Whether this account may record a free-for-all lobby's result.
    ///
    /// Same answer as `may_report` for a two-sided match, and separate only
    /// because `may_report` excludes free-for-all rounds: their body is a
    /// different shape and the ordinary report dialog cannot build it.
    pub fn may_report_ffa(&self, entry: &TourneyMatch) -> bool {
        self.viewer.organiser
            && self.status.has_bracket()
            && entry.bracket == BracketSide::FreeForAll
            && !entry.entrants.is_empty()
    }

    /// The team whose draft pick is due.
    pub fn draft_turn(&self) -> Option<&str> {
        if self.status != TourneyStatus::Draft {
            return None;
        }
        self.draft.as_ref()?.turn()
    }

    /// Whether this account may make the pick that is due.
    ///
    /// The captain of the team on the clock, or an organiser picking for them.
    /// Same shape as `may_veto`, and for the same reason: the service checks
    /// captaincy, so offering the list to a team-mate is offering a refusal.
    pub fn may_pick(&self) -> bool {
        let Some(turn) = self.draft_turn() else {
            return false;
        };
        if self.viewer.organiser {
            return true;
        }
        self.team(turn).is_some_and(|team| self.is_captain_of(team))
    }

    /// Whether this account may take back the last pick.
    ///
    /// An organiser may, at any point. A captain may take back only their own,
    /// and only while nobody has picked after them: once the next captain has
    /// gone, undoing would rewrite somebody else's turn.
    pub fn may_undo_pick(&self) -> bool {
        if !matches!(self.status, TourneyStatus::Draft | TourneyStatus::Drafted) {
            return false;
        }
        let Some(draft) = &self.draft else {
            return false;
        };
        let Some(last) = &draft.last_pick else {
            return false;
        };
        if self.viewer.organiser {
            return true;
        }
        draft.current == last.at_index + 1
            && self
                .team(&last.team_id)
                .is_some_and(|team| self.is_captain_of(team))
    }

    /// Entrants still waiting to be picked.
    ///
    /// A pending signup is not in the pool: the organiser has not accepted them
    /// yet, and the service refuses a pick naming one.
    pub fn undrafted(&self) -> Vec<&TourneyPlayer> {
        self.players
            .iter()
            .filter(|player| !player.pending && player.team_id.is_none())
            .collect()
    }

    /// Whether this event is still waiting to be made visible.
    ///
    /// The one control an organiser cannot do without: the service creates every
    /// tournament unpublished, so an event created here and left alone is a
    /// draft that only its own organiser can find.
    pub fn may_publish(&self) -> bool {
        self.viewer.organiser && !self.published
    }

    /// Whether the organiser may still shuffle who is on which team.
    ///
    /// `move_player` and `set_captain` are refused once the bracket is drawn: the
    /// draw is made from the teams, so changing them afterwards would leave the
    /// bracket describing an event that no longer exists. Before that, while
    /// signups run and after teams are formed, it is the organiser's main tool
    /// for fixing a no-show or an uneven field.
    pub fn may_shuffle_teams(&self) -> bool {
        self.viewer.organiser && !self.status.has_bracket() && self.team_size > 1
    }

    /// Whether the organiser may type a rating for an entrant.
    ///
    /// Only an unrated event. Everywhere else the server fetches the rating as of
    /// the event's rating date and refuses a typed one with "Ratings are fetched
    /// from FAF for this tournament and cannot be edited", so the field is not
    /// offered rather than offered and refused.
    pub fn may_set_rating(&self) -> bool {
        self.viewer.organiser && self.rating_kind == RatingKind::None
    }

    /// Whether this account may rename or take apart `team`.
    ///
    /// An organiser may rename any team as often as needed. A captain gets one
    /// rename, and only where teams have more than one player: the server counts
    /// it in `captainRenamed` and refuses the second.
    pub fn may_rename(&self, team: &TourneyTeam) -> bool {
        if self.viewer.organiser {
            return true;
        }
        self.is_captain_of(team) && self.team_size > 1 && !team.captain_renamed
    }

    /// Whether this account is the side that has to agree to a pending result.
    ///
    /// Only the *other* team confirms: the submitting team agreeing with itself
    /// would make the second signature worthless.
    pub fn may_confirm(&self, entry: &TourneyMatch) -> bool {
        let (Some(mine), Some(pending)) = (
            self.viewer.member_team_id.as_deref(),
            entry.pending_report.as_ref(),
        ) else {
            return false;
        };
        self.status.has_bracket() && entry.opponent_of(mine).is_some() && pending.by_team != mine
    }

    /// Whether entering is worth offering: signups are open and this account is
    /// not in already.
    ///
    /// The rating gates and the entrant cap are deliberately *not* checked here.
    /// The server owns those and explains them far better than a hidden button
    /// would. "Your rating (1420) is below this tournament's minimum of 1500"
    /// is the answer a player needs, and they only get it by being allowed to
    /// try.
    pub fn may_sign_up(&self) -> bool {
        self.viewer.logged_in && !self.viewer.is_signed_up() && self.status == TourneyStatus::Signup
    }

    /// Whether withdrawing is possible: signed up, and signups still open.
    ///
    /// After that the organiser has to remove the entry, because a bracket that
    /// has been drawn cannot lose an entrant quietly.
    pub fn may_withdraw(&self) -> bool {
        self.viewer.is_signed_up() && self.status == TourneyStatus::Signup
    }

    /// Why a qualifier link to `candidate` would be refused.
    ///
    /// Three of the service's four checks can be made from what a list row
    /// carries; the fourth needs the candidate's own links and stays there. The
    /// last arm is not one of its checks at all: a points rule against an
    /// elimination bracket is *accepted* and then qualifies nobody, which is
    /// the one refusal worth adding rather than mirroring.
    pub fn qualifier_rejection(
        &self,
        candidate: &Tourney,
        rule: QualifierRule,
    ) -> Option<QualifierRejection> {
        if candidate.id == self.id {
            return Some(QualifierRejection::SameEvent);
        }
        if self
            .qualifiers
            .iter()
            .any(|link| link.tournament_id == candidate.id)
        {
            return Some(QualifierRejection::AlreadyLinked);
        }
        if rule.n < 1 {
            return Some(QualifierRejection::CutoffTooLow);
        }
        if !rule
            .kind
            .suits(candidate.competition, candidate.bracket_kind)
        {
            return Some(QualifierRejection::PointsWithoutScores);
        }
        None
    }

    /// Whether the format can still be changed at all.
    ///
    /// The service locks it once the bracket exists, and says so: "The format
    /// is locked once the bracket has started". The draw was made from the
    /// format, so changing it afterwards would leave a bracket describing an
    /// event that no longer exists.
    pub fn may_edit_format(&self) -> bool {
        self.viewer.organiser
            && matches!(
                self.status,
                TourneyStatus::Signup | TourneyStatus::Draft | TourneyStatus::Drafted
            )
    }

    /// Whether the *structural* half of the format can still be changed.
    ///
    /// Narrower again: the competition, the team size, the formation and the
    /// draft order decide what a team is, so the service takes them only while
    /// signups are open. Offering them later produces "Reopen signups to change
    /// the team setup", which reads as a broken control rather than a locked
    /// one.
    pub fn may_edit_team_setup(&self) -> bool {
        self.viewer.organiser && self.status == TourneyStatus::Signup
    }

    /// Whether this account can write in the event's chat.
    ///
    /// Two separate reasons it might not, and they are told apart because the
    /// composer has to say which: the room locks two days after the event, and
    /// an organiser can silence one account.
    pub fn may_post_chat(&self) -> bool {
        self.viewer.logged_in && !self.chat_locked && !self.chat_muted_me
    }

    /// Announcements posted since this account last read them.
    ///
    /// Zero for a reader who is not signed in: the service remembers nothing
    /// for them, and a badge that never cleared would be worse than none.
    pub fn unread_news(&self) -> i32 {
        if !self.viewer.logged_in {
            return 0;
        }
        let read_at = self.viewer.news_read_at.unwrap_or(0);
        self.news
            .iter()
            .filter(|post| post.at.unwrap_or(0) > read_at)
            .count() as i32
    }

    /// How many teams this event expects to draw with.
    ///
    /// The teams once they are formed; otherwise the entrant cap, if one was
    /// set; otherwise the signups divided by the team size. The service's own
    /// order, and the reason the middle one is there: an organiser who has set
    /// a cap has told us the answer before anybody has entered.
    pub fn projected_team_count(&self) -> i32 {
        if !self.teams.is_empty() {
            return self.teams.len() as i32;
        }
        if self.max_teams > 0 {
            return self.max_teams;
        }
        let size = if self.competition == Competition::FreeForAll {
            1
        } else {
            self.team_size.max(1)
        };
        self.players.len() as i32 / size
    }

    /// The rounds a map pool can be bound to.
    ///
    /// Read off the bracket once it exists; projected from the expected team
    /// count before that. The projection is the whole point: pools are prepared
    /// while signups run, and a client that offered nothing until the draw
    /// would force every organiser back to the website for the one step that
    /// has to happen first.
    ///
    /// A free-for-all has no ban/pick rounds at all, so it answers empty rather
    /// than projecting a bracket it will never draw.
    pub fn round_plan(&self) -> RoundPlan {
        let mut real: Vec<(BracketSide, i32)> = Vec::new();
        for entry in &self.matches {
            if entry.bracket == BracketSide::FreeForAll {
                continue;
            }
            let pair = (entry.bracket, entry.round);
            if !real.contains(&pair) {
                real.push(pair);
            }
        }
        if !real.is_empty() {
            return RoundPlan {
                keys: round_keys(&real),
                projected: false,
                teams: self.teams.len() as i32,
            };
        }

        let teams = self.projected_team_count();
        if teams < 2 || self.competition == Competition::FreeForAll {
            return RoundPlan {
                keys: Vec::new(),
                projected: true,
                teams,
            };
        }
        // `ceil(log2(teams))`: the number of rounds a bracket of this size
        // takes. The service picks a Swiss round count at start-up and defaults
        // to the same number.
        let rounds = rounds_for(teams);
        let mut pairs = Vec::new();
        if self.bracket_kind == BracketKind::Swiss {
            for round in 1..=rounds.max(1) {
                pairs.push((BracketSide::Swiss, round));
            }
            // A Swiss event plays a final unless its plan turns one off. The
            // plan is not modelled here, and its default is on.
            pairs.push((BracketSide::GrandFinal, 1));
        } else {
            for round in 1..=rounds {
                pairs.push((BracketSide::Winners, round));
            }
            if self.bracket_kind == BracketKind::Double {
                for round in 1..=(2 * rounds - 2).max(0) {
                    pairs.push((BracketSide::Losers, round));
                }
                pairs.push((BracketSide::GrandFinal, 1));
            }
        }
        RoundPlan {
            keys: round_keys(&pairs),
            projected: true,
            teams,
        }
    }

    /// Whether the organiser may attach this event to a series, or link a
    /// qualifier into it.
    ///
    /// Both are `canOrganize` writes with no status gate of their own: a
    /// finished event can still be filed under its series, and a parent can
    /// still take a late qualifier.
    pub fn may_edit_series(&self) -> bool {
        self.viewer.organiser
    }
}

/// Rounds needed for a single-elimination bracket of `teams`.
///
/// `ceil(log2(next power of two))`, which is the service's `log2i(nextPow2(n))`
/// written the way Rust spells it.
fn rounds_for(teams: i32) -> i32 {
    let mut size = 1i32;
    let mut rounds = 0;
    while size < teams {
        size = size.saturating_mul(2);
        rounds += 1;
    }
    rounds
}

/// Turn bracket/round pairs into the service's keys, with each bracket's
/// deepest round attached so a label can name a final without recounting.
fn round_keys(pairs: &[(BracketSide, i32)]) -> Vec<RoundKey> {
    pairs
        .iter()
        .map(|(bracket, round)| RoundKey {
            key: format!("{}:{round}", bracket.as_wire()),
            bracket: *bracket,
            round: *round,
            last_round: pairs
                .iter()
                .filter(|(side, _)| side == bracket)
                .map(|(_, deepest)| *deepest)
                .max()
                .unwrap_or(*round),
        })
        .collect()
}

/// How entrants get in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SignupMode {
    /// Anyone signed in may enter.
    #[default]
    Open,
    /// The organiser invites; nobody else can enter.
    Invite,
    /// Anyone may ask, and the organiser approves each one.
    Request,
}

impl SignupMode {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Invite => "invite",
            Self::Request => "request",
        }
    }

    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "invite" => Self::Invite,
            "request" => Self::Request,
            _ => Self::Open,
        }
    }
}

/// Which FAF rating decides seeding, and whether one is used at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RatingKind {
    #[default]
    Global,
    Ladder1v1,
    Team2v2,
    Team3v3,
    Team4v4,
    /// The combined figure the tournament team calls RC.
    Combined,
    /// Unrated: nobody's rating is fetched, and no gate can apply.
    None,
}

impl RatingKind {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Ladder1v1 => "1v1",
            Self::Team2v2 => "2v2",
            Self::Team3v3 => "3v3",
            Self::Team4v4 => "4v4",
            Self::Combined => "rc",
            Self::None => "none",
        }
    }

    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "1v1" => Self::Ladder1v1,
            "2v2" => Self::Team2v2,
            "3v3" => Self::Team3v3,
            "4v4" => Self::Team4v4,
            "rc" => Self::Combined,
            "none" => Self::None,
            _ => Self::Global,
        }
    }
}

/// How the bracket is seeded once teams are formed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Seeding {
    #[default]
    Rating,
    Random,
    Manual,
}

impl Seeding {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Rating => "rating",
            Self::Random => "random",
            Self::Manual => "manual",
        }
    }

    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "random" => Self::Random,
            "manual" => Self::Manual,
            _ => Self::Rating,
        }
    }
}

/// A tournament as the organiser filled it in.
///
/// Deliberately short of what `POST /api/tournaments` accepts. The server
/// defaults the best-of plan, the veto configuration and the free-text fields,
/// and those defaults are the tournament team's own. Asking an organiser for
/// six best-of numbers before their event has a single entrant is the wrong
/// first question; the plan is edited later, once the shape of the field is
/// known.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TourneyDraft {
    pub name: String,
    pub description: String,
    pub category: TourneyCategory,
    pub competition: Competition,
    /// 1 to 6. A size of one makes the formation solo whatever is asked for.
    pub team_size: i32,
    /// Only consulted above a team size of one.
    pub formation: Formation,
    pub bracket_kind: BracketKind,
    pub seeding: Seeding,
    pub rating_kind: RatingKind,
    pub signup_mode: SignupMode,
    /// Unix seconds; sent as an ISO instant, which is what the server stores.
    pub event_date: Option<u32>,
    pub signup_opens_at: Option<u32>,
    pub signup_closes_at: Option<u32>,
    /// The instant every entrant's rating is taken from, or `None` to use
    /// whatever it is when they sign up.
    ///
    /// The third date an event needs, and the one that is not about scheduling:
    /// it stops an entrant signing up on a peak rating and playing weeks later
    /// on a lower one. The service freezes against it when it fetches a rating
    /// from FAF, so it has to be set before signups open to mean anything.
    pub rating_date: Option<u32>,
    pub rating: RatingGate,
    /// Entrant cap. Zero means no cap, which is the server's own convention.
    pub max_teams: i32,
}

impl TourneyDraft {
    /// The defaults a new event starts from: a 2v2 community cup with open
    /// signups.
    pub fn new() -> Self {
        Self {
            team_size: 2,
            ..Self::default()
        }
    }

    /// The formation the server will actually use.
    ///
    /// A team of one is always solo, whatever the form said. Mirrored here so
    /// the form can stop offering a choice that has no effect rather than
    /// letting the organiser make one and quietly overriding it.
    pub fn effective_formation(&self) -> Formation {
        if self.team_size <= 1 || self.competition == Competition::FreeForAll {
            Formation::Solo
        } else {
            self.formation
        }
    }

    /// Why the server would refuse this, if it would.
    ///
    /// Checked here so the submit button can say what is missing, rather than
    /// the organiser filling in a long form and being told "Name required".
    pub fn rejection(&self) -> Option<DraftRejection> {
        if self.name.trim().is_empty() {
            return Some(DraftRejection::NameRequired);
        }
        if !(1..=6).contains(&self.team_size) {
            return Some(DraftRejection::TeamSizeOutOfRange);
        }
        if let (Some(min), Some(max)) = (self.rating.min, self.rating.max) {
            if min > max {
                return Some(DraftRejection::RatingRangeInverted);
            }
        }
        // A gate needs a rating to compare against, and an unrated event never
        // fetches one, so the two together can only ever refuse every signup.
        if self.rating_kind == RatingKind::None
            && (self.rating.min.is_some() || self.rating.max.is_some())
        {
            return Some(DraftRejection::RatingGateWithoutRating);
        }
        if let (Some(opens), Some(closes)) = (self.signup_opens_at, self.signup_closes_at) {
            if opens >= closes {
                return Some(DraftRejection::SignupWindowInverted);
            }
        }
        None
    }

    pub fn is_submittable(&self) -> bool {
        self.rejection().is_none()
    }
}

/// Why a [`TourneyDraft`] is not submittable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DraftRejection {
    NameRequired,
    TeamSizeOutOfRange,
    RatingRangeInverted,
    RatingGateWithoutRating,
    SignupWindowInverted,
}

/// The best-of plan, settled at the moment the bracket is drawn.
///
/// Asked once, here, rather than at creation: the number of rounds follows from
/// the entrant count, so before signups close there is nothing to ask about.
/// The service defaults every value from the event's stored `plan`, so an
/// absent config still draws a bracket; this is what lets the organiser say
/// otherwise without going to the website.
///
/// One variant per format because the shapes genuinely differ, and a single
/// flat struct would have three quarters of its fields inert at any time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum BracketConfig {
    /// A free-for-all is drawn from its own configuration and asks nothing.
    FreeForAll,
    /// One best-of per round, deepest last.
    Single { rounds: Vec<i32> },
    #[serde(rename_all = "camelCase")]
    Double {
        /// Winners rounds, `ceil(log2(teams))` of them.
        wb: Vec<i32>,
        /// Losers rounds, `2R - 2` of them.
        lb: Vec<i32>,
        gf: i32,
        /// Whether the winners finalist starts the grand final one game up.
        lb_handicap: bool,
    },
    #[serde(rename_all = "camelCase")]
    Swiss {
        /// 1 to 15.
        rounds: i32,
        /// 1 or 3; the service accepts nothing else here.
        best_of: i32,
        /// Whether the top two play a final after the last round.
        final_match: bool,
        final_best_of: i32,
        /// Whether a pairing starts as soon as two teams are free, rather than
        /// waiting for the round to finish.
        fast: bool,
    },
}

/// The best-of values the service accepts. Anything else becomes 3.
pub const BEST_OF_CHOICES: [i32; 4] = [1, 3, 5, 7];

impl BracketConfig {
    /// The configuration this event would draw with if nothing were changed.
    ///
    /// The service's own defaults, mirrored so the dialog opens on what would
    /// happen anyway rather than on a blank form. The per-round plan it would
    /// read from is not modelled here, so these are its fallbacks: 3 for an
    /// ordinary round, 5 for a final.
    pub fn of(event: &Tourney) -> Self {
        let teams = event.teams.len() as i32;
        let rounds = rounds_for(teams.max(2));
        match (event.competition, event.bracket_kind) {
            (Competition::FreeForAll, _) => Self::FreeForAll,
            (_, BracketKind::Swiss) => Self::Swiss {
                rounds: rounds.max(1),
                best_of: 3,
                final_match: true,
                final_best_of: 5,
                fast: false,
            },
            (_, BracketKind::Double) => Self::Double {
                // Every winners round defaults to 3, the final included: the
                // service's `wbFinal` and `wb` fall back to the same number,
                // and only the grand final is longer.
                wb: vec![3; rounds.max(0) as usize],
                lb: vec![3; (2 * rounds - 2).max(0) as usize],
                gf: 5,
                lb_handicap: true,
            },
            (_, BracketKind::Single) => Self::Single {
                rounds: (1..=rounds)
                    .map(|round| if round == rounds { 5 } else { 3 })
                    .collect(),
            },
        }
    }

    /// Why the service would refuse this, if it would.
    ///
    /// Only the counts: every value is clamped rather than rejected, so a bad
    /// best-of becomes 3 instead of an error. A wrong *number* of rounds is the
    /// one that silently loses a setting, because `cleanBoList` pads or trims
    /// to the length the bracket actually has.
    pub fn is_submittable(&self, teams: i32) -> bool {
        let rounds = rounds_for(teams.max(2));
        match self {
            Self::FreeForAll => true,
            Self::Single { rounds: list } => list.len() as i32 == rounds,
            Self::Double { wb, lb, .. } => {
                wb.len() as i32 == rounds && lb.len() as i32 == (2 * rounds - 2).max(0)
            }
            Self::Swiss {
                rounds: count,
                best_of,
                ..
            } => (1..=15).contains(count) && (*best_of == 1 || *best_of == 3),
        }
    }
}

/// A step the organiser takes to move the event along.
///
/// Named rather than a free string because each one is refused in its own way
/// and from its own status, and the UI has to offer exactly the one that is
/// legal now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TourneyPhase {
    /// Close signups and lock the entrants into teams.
    FormTeams,
    /// Draw the bracket. Legal only once teams exist.
    StartBracket,
    /// Undo both, back to taking signups. Destroys the teams, which is why the
    /// UI confirms before sending it.
    ReopenSignups,
    /// Fix the list of captains, before a draft starts.
    SetCaptains,
    /// Build the pick order and hand the first pick out.
    StartDraft,
}

impl TourneyPhase {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::FormTeams => "form_teams",
            Self::StartBracket => "start_bracket",
            Self::ReopenSignups => "reopen_signups",
            Self::SetCaptains => "set_captains",
            Self::StartDraft => "start_draft",
        }
    }

    /// Whether this step is legal from `status`.
    ///
    /// The server's own gate, mirrored so a button that will be refused is not
    /// drawn at all.
    pub fn is_legal_from(self, status: TourneyStatus) -> bool {
        match self {
            // Both draft steps run from signups: captains are marked while the
            // field is still open, and starting closes it.
            Self::SetCaptains | Self::StartDraft => status == TourneyStatus::Signup,
            Self::FormTeams => status == TourneyStatus::Signup,
            Self::StartBracket => status == TourneyStatus::Drafted,
            Self::ReopenSignups => matches!(
                status,
                TourneyStatus::Signup | TourneyStatus::Draft | TourneyStatus::Drafted
            ),
        }
    }
}

/// The shape of the competition, changed after the event was created.
///
/// A narrower set than the service's `edit_format` accepts. The best-of plan
/// per round stays on the website, being a dozen numbers whose meaning changes
/// with the bracket type; the seeding policy and the entrant cap are absent for
/// a harder reason, which is that the client never reads either off the event,
/// so it has nothing to put in the field but a guess.
///
/// What is here is what an organiser gets wrong at creation and then has to
/// undo: the wrong bracket, a team size of one where two was meant, an open
/// field where a draft was meant.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FormatDraft {
    pub competition: Competition,
    /// 1 to 6 for a team event, 1 to 3 for a free-for-all: the service clamps
    /// each to its own range.
    pub team_size: i32,
    pub formation: Formation,
    pub bracket_kind: BracketKind,
    /// Whether the draft order snakes back on every other pass.
    pub draft_snakes: bool,
}

impl FormatDraft {
    /// The event's current format, as the starting point for editing it.
    pub fn of(event: &Tourney) -> Self {
        Self {
            competition: event.competition,
            team_size: event.team_size,
            formation: event.formation,
            bracket_kind: event.bracket_kind,
            draft_snakes: event.draft_snakes,
        }
    }

    /// Whether this changes anything the service calls structural.
    ///
    /// Those four are refused outside signups, because they decide what a team
    /// *is*: everything already built out of teams would have to be thrown
    /// away. The bracket type and the seeding are not structural and can be
    /// changed right up to the draw.
    pub fn is_structural(&self, event: &Tourney) -> bool {
        self.competition != event.competition
            || self.team_size != event.team_size
            || self.formation != event.formation
            || self.draft_snakes != event.draft_snakes
    }
}

// ---------------------------------------------------------------------------
// Series and qualification: how one event relates to another.
// ---------------------------------------------------------------------------

/// A named grouping of tournaments.
///
/// Only a label, and worth saying plainly because the name invites a stronger
/// reading: editions of a series are fully independent events. There is no
/// qualification between them, no fixed cadence and no shared bracket. A series
/// links them for browsing, which is why it lives at `GET /api/series` rather
/// than inside any one tournament.
///
/// Qualification is the separate mechanism below ([`Qualifier`]), and the two
/// are unrelated: a qualifier link can cross series, and editions of one series
/// usually feed nothing at all.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TourneySeries {
    pub id: String,
    pub name: String,
    /// Reduced to plain text on the way in, like every other field somebody
    /// else's editor produced.
    pub description: String,
    pub colour: SeriesColour,
    /// `Some` only where the site admin tagged it; a community series has none.
    pub category: Option<TourneyCategory>,
    /// Published, unarchived editions.
    pub editions: i32,
    /// How many of those are still open or being played. The service sorts
    /// running series first, so a dormant one falls to the bottom rather than
    /// being mixed in with the live ones.
    pub active: i32,
    /// The most recent edition's date, in Unix seconds, or its creation stamp
    /// where it has none. The service's own sort key, kept so the client can
    /// show what the order is built on.
    pub last_at: Option<u32>,
    pub latest_id: Option<String>,
    pub latest_name: String,
    pub latest_date: Option<u32>,
}

/// A series' colour, from the service's fixed palette.
///
/// Six named values rather than free-form hex, so a series can never end up
/// unreadable against the dark theme. The service picks one from the name when
/// a series is created and lets its owner change it; [`Self::Plain`] is never
/// picked automatically, so it means somebody chose it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SeriesColour {
    Amber,
    Blue,
    Green,
    Red,
    Purple,
    #[default]
    Plain,
}

impl SeriesColour {
    /// Read leniently: an unknown colour is one we cannot draw, and
    /// [`Self::Plain`] draws correctly whatever the value was.
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "amber" => Self::Amber,
            "blue" => Self::Blue,
            "green" => Self::Green,
            "red" => Self::Red,
            "purple" => Self::Purple,
            _ => Self::Plain,
        }
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Amber => "amber",
            Self::Blue => "blue",
            Self::Green => "green",
            Self::Red => "red",
            Self::Purple => "purple",
            Self::Plain => "plain",
        }
    }

    /// The palette, in the service's own order, for a picker.
    pub const ALL: [Self; 6] = [
        Self::Amber,
        Self::Blue,
        Self::Green,
        Self::Red,
        Self::Purple,
        Self::Plain,
    ];
}

/// One tournament as a series lists it.
///
/// Deliberately not a [`Tourney`]: `GET /api/series/{id}` sends a dozen fields
/// per edition, not a whole event, and widening the tournament type to hold a
/// tenth of itself would leave every consumer asking which half is filled in.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SeriesEdition {
    pub id: String,
    pub name: String,
    pub status: TourneyStatus,
    pub category: Option<TourneyCategory>,
    /// Unpublished editions reach only their own organisers, site admins and
    /// directors: the service filters the list before sending it.
    pub published: bool,
    pub competition: Competition,
    pub bracket_kind: BracketKind,
    pub team_size: i32,
    pub player_count: i32,
    pub team_count: i32,
    pub event_date: Option<u32>,
    pub abandoned: bool,
    pub champion_team_id: Option<String>,
    /// The winning team's name, already resolved by the service.
    pub champion: String,
}

/// One series with its editions, from `GET /api/series/{id}`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SeriesDetail {
    pub id: String,
    pub name: String,
    pub description: String,
    pub colour: SeriesColour,
    pub category: Option<TourneyCategory>,
    /// Newest first.
    pub editions: Vec<SeriesEdition>,
    /// Whether this account may rename or delete it.
    ///
    /// Read from the service rather than worked out here, and that is the whole
    /// reason it is a field: the answer is "a site admin, a director, whoever
    /// created it, or an organiser of any edition in it", and the last of those
    /// needs every tournament in the database to decide. The client holds the
    /// list it was sent, not the database.
    pub can_edit: bool,
}

/// A series being created or renamed.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SeriesDraft {
    /// Empty to create; an existing id edits that one.
    pub id: String,
    pub name: String,
    pub description: String,
    pub colour: SeriesColour,
    pub category: Option<TourneyCategory>,
}

impl SeriesDraft {
    /// Whether the service would accept it. It insists on a name and nothing
    /// else; the duplicate-name check needs every series and stays server-side.
    pub fn is_submittable(&self) -> bool {
        !self.name.trim().is_empty()
    }
}

/// A tournament whose result feeds entrants into another one.
///
/// The link lives on the *parent* alone, and a child derives "feeds into X" by
/// lookup, so the two sides can never disagree. Qualifying does not sign anyone
/// up: the service sends each qualified account a normal invite, which they
/// still have to accept.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Qualifier {
    /// The link's own id, which is what removes it.
    pub id: String,
    /// The child event this draws from.
    pub tournament_id: String,
    /// Its name, or the service's placeholder where it has since been deleted.
    pub name: String,
    /// `None` where the child is gone.
    pub status: Option<TourneyStatus>,
    pub rule: QualifierRule,
    /// When the link was applied, in Unix seconds, or `None` while the child is
    /// still being played. The service sweeps lazily, on read, so a finished
    /// child can sit unapplied for as long as nobody asks for the list.
    pub applied: Option<u32>,
    /// The teams that qualified, by name, filled in once applied.
    pub qualified: Vec<String>,
    /// Teams that qualified and could not be invited, because no member has a
    /// FAF account: a manually added entrant has none, and an invite is
    /// addressed to an account. Worth showing rather than swallowing, since it
    /// is the organiser who then has to add them by hand.
    pub unreachable: Vec<String>,
}

/// How many of a child's entrants go through, and by what measure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QualifierRule {
    pub kind: QualifierKind,
    /// The cutoff: how many for [`QualifierKind::Top`], the lowest qualifying
    /// score for [`QualifierKind::Points`]. At least 1 either way.
    pub n: i32,
}

impl Default for QualifierRule {
    /// The service's own default, which it reaches by clamping: anything that
    /// is not `points` is `top`, and any count below 1 becomes 1.
    fn default() -> Self {
        Self {
            kind: QualifierKind::Top,
            n: 1,
        }
    }
}

/// Which measure a qualifier link ranks by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum QualifierKind {
    /// The best N, however the child's format ranks its entrants: champion
    /// first in an elimination bracket, standings order in Swiss, points order
    /// in a free-for-all.
    #[default]
    Top,
    /// Everyone who reached N points, which only Swiss and free-for-all can
    /// answer.
    Points,
}

impl QualifierKind {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "points" => Self::Points,
            _ => Self::Top,
        }
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Top => "top",
            Self::Points => "points",
        }
    }

    /// Whether a child in this format can be ranked by this measure.
    ///
    /// [`Self::Points`] needs a score per entrant, which only Swiss and
    /// free-for-all keep. Set against an elimination bracket the service takes
    /// the link and then qualifies nobody, silently: the organiser finds out
    /// when the invites they were waiting for never arrive. Caught here so the
    /// combination is never offered.
    pub fn suits(self, competition: Competition, bracket: BracketKind) -> bool {
        match self {
            Self::Top => true,
            Self::Points => competition == Competition::FreeForAll || bracket == BracketKind::Swiss,
        }
    }
}

/// The parent this tournament feeds, where it feeds one.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FeedsInto {
    pub parent_id: String,
    pub parent_name: String,
    pub rule: QualifierRule,
    /// Unix seconds, once the parent has taken its entrants.
    pub applied: Option<u32>,
}

/// Why the service would refuse a qualifier link, in the order it checks.
///
/// Its remaining check, "that tournament already draws its qualifiers from this
/// one", needs the *candidate's* own qualifier list, which a list row does not
/// carry. That one stays with the service.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum QualifierRejection {
    /// A tournament cannot qualify into itself.
    SameEvent,
    /// This child is already linked.
    AlreadyLinked,
    /// The cutoff has to be at least 1.
    CutoffTooLow,
    /// A points rule against a format that keeps no score. The service accepts
    /// this and then qualifies nobody, so it is refused here instead.
    PointsWithoutScores,
}

/// Whether this account may host a tournament at all.
///
/// Hosting is approval-only: the site admin grants it per account. Asked for
/// once and kept, because the alternative is offering a create button that
/// answers "your FAF account is not approved to host tournaments yet".
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HostingStatus {
    pub logged_in: bool,
    pub allowed: bool,
    /// A request is in with the site admin.
    pub pending: bool,
}

// ---------------------------------------------------------------------------
// The slice: what the tab holds, what it can be asked to do, and what happened.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum TourneyLoadStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed {
        reason: String,
        kind: RequestFailureKind,
    },
}

/// A write that has not answered yet.
///
/// Carried in state rather than in the component so the whole pane can disable
/// itself while one is in flight. Two "enter tournament" clicks would otherwise
/// both reach the server, and the second comes back "You are already signed
/// up", which reads like a bug rather than a double click.
///
/// Each variant names the thing it is acting on, so a spinner can sit on the
/// one match being reported instead of over the whole bracket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum TourneyAction {
    AddingPlayer,
    #[serde(rename_all = "camelCase")]
    AnsweringSignup {
        player_id: String,
    },
    #[serde(rename_all = "camelCase")]
    RemovingPlayer {
        player_id: String,
    },
    /// Organiser team management, keyed by the entrant so one row's spinner does
    /// not disable the whole list.
    #[serde(rename_all = "camelCase")]
    MovingPlayer {
        player_id: String,
    },
    #[serde(rename_all = "camelCase")]
    EditingPlayer {
        player_id: String,
    },
    #[serde(rename_all = "camelCase")]
    SettingCaptain {
        player_id: String,
    },
    Inviting,
    Reseeding,
    Dividing,
    PostingNews,
    CreatingTeam,
    #[serde(rename_all = "camelCase")]
    AnsweringTeam {
        team_id: String,
    },
    LeavingTeam,
    #[serde(rename_all = "camelCase")]
    InvitingToTeam {
        player_id: String,
    },
    RenamingTeam,
    Creating,
    Editing,
    Publishing,
    #[serde(rename_all = "camelCase")]
    Advancing {
        phase: TourneyPhase,
    },
    Archiving,
    SigningUp,
    Withdrawing,
    CheckingIn,
    #[serde(rename_all = "camelCase")]
    AnsweringReport {
        match_id: String,
    },
    #[serde(rename_all = "camelCase")]
    DecidingReport {
        match_id: String,
    },
    #[serde(rename_all = "camelCase")]
    PostingChat {
        room_id: String,
    },
    #[serde(rename_all = "camelCase")]
    AssigningPool {
        round_key: String,
    },
    #[serde(rename_all = "camelCase")]
    Vetoing {
        match_id: String,
    },
    #[serde(rename_all = "camelCase")]
    ReportingFfa {
        match_id: String,
    },
    Drafting,
    SavingMap,
    #[serde(rename_all = "camelCase")]
    PublishingMap {
        map_id: String,
    },
    #[serde(rename_all = "camelCase")]
    DeletingMap {
        map_id: String,
    },
    #[serde(rename_all = "camelCase")]
    PublishingPool {
        pool_id: String,
    },
    #[serde(rename_all = "camelCase")]
    DeletingPool {
        pool_id: String,
    },
    SavingPool,
    EditingFormat,
    #[serde(rename_all = "camelCase")]
    MutingChat {
        faf_id: i32,
    },
    #[serde(rename_all = "camelCase")]
    DeletingChatPost {
        post_id: String,
    },
    AddingOrganiser,
    #[serde(rename_all = "camelCase")]
    SettingCaster {
        faf_id: i32,
    },
    #[serde(rename_all = "camelCase")]
    SettingOrganiserVisibility {
        faf_id: i32,
    },
    Abandoning,
    #[serde(rename_all = "camelCase")]
    EditingNews {
        news_id: String,
    },
    SavingSeries,
    #[serde(rename_all = "camelCase")]
    DeletingSeries {
        series_id: String,
    },
    SettingSeries,
    AddingQualifier,
    #[serde(rename_all = "camelCase")]
    RemovingQualifier {
        link_id: String,
    },
}

/// A write that came back refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TourneyActionFailure {
    pub action: TourneyAction,
    /// The server's own sentence. It says which rating gate was missed or how
    /// many replay ids are still wanted, and nothing the client could write in
    /// its place would be as useful.
    pub reason: String,
    pub kind: RequestFailureKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TourneyState {
    pub events: Vec<Tourney>,
    pub status: TourneyLoadStatus,
    /// Which event's detail pane is open.
    pub selected_id: Option<String>,
    /// The whole open event: entrants, teams, bracket, pools.
    ///
    /// Loaded separately from the list because the list carries only counts;
    /// the people and the bracket are a second, much larger request, and the
    /// list has to stay usable while it arrives.
    pub detail: Option<Tourney>,
    pub detail_status: TourneyLoadStatus,
    pub pending: Option<TourneyAction>,
    /// The last refused write. Survives until it is dismissed or another action
    /// starts, because a message that vanished on the next re-render would
    /// never be read.
    pub action_error: Option<TourneyActionFailure>,
    /// FAF accounts behind the open event's entrants.
    ///
    /// Kept beside the entrants rather than merged into them because they come
    /// from a different service: the tournament service owns the entry, FAF
    /// owns the player, and an entrant whose avatar failed to load must still
    /// appear in the bracket.
    pub entrant_profiles: Vec<PlayerSummary>,
    pub chat_rooms: Vec<ChatRoom>,
    pub open_room_id: Option<String>,
    pub chat_posts: Vec<ChatPost>,
    pub chat_status: TourneyLoadStatus,
    /// The site-wide rules pages, loaded once.
    pub articles: Vec<Article>,
    /// Whether this account may host at all, asked for once.
    pub hosting: HostingStatus,
    /// Accounts matching what the organiser is typing into an add or invite
    /// field.
    ///
    /// Kept in the slice rather than in the component because it is the answer
    /// to a request, and every other request's answer lives here too. It is also
    /// what makes adding an entrant a *choice of a person* rather than a typed
    /// string: the server matches names exactly and refuses anything it cannot
    /// find, so guessing the spelling is the failure mode this removes.
    pub account_search: AccountSearch,
    /// Every series, for the picker and the series list. Loaded on demand
    /// rather than with the tab: most visits never open a series, and the list
    /// is a second request against a different endpoint.
    pub series: Vec<TourneySeries>,
    pub series_status: TourneyLoadStatus,
    /// The open series with its editions, or `None` while the list is showing.
    pub open_series: Option<SeriesDetail>,
}

/// A name-to-account search, as the organiser types.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountSearch {
    /// The text the results belong to. Held so a slower answer for an older
    /// query can be dropped rather than replacing a newer one's results.
    pub query: String,
    pub matches: Vec<PlayerSummary>,
    pub status: TourneyLoadStatus,
}

impl AccountSearch {
    /// Whether a result set for `query` is still the one being shown.
    ///
    /// Compared case-insensitively and trimmed, because that is how the query
    /// was sent: the same word typed with a stray space must not look like a
    /// different search.
    pub fn is_current(&self, query: &str) -> bool {
        self.query.trim().eq_ignore_ascii_case(query.trim())
    }
}

impl TourneyState {
    /// The FAF account behind an entrant, when the entry carries one.
    ///
    /// Not every entrant has one: an organiser can add a player by hand, and
    /// that entry has a name and nothing else.
    pub fn profile_of(&self, entrant: &TourneyPlayer) -> Option<&PlayerSummary> {
        let faf_id = entrant.faf_id?;
        self.entrant_profiles
            .iter()
            .find(|profile| profile.id == faf_id)
    }

    /// The open event, if the detail on hand is really its.
    ///
    /// Guards the window between selecting a row and its detail arriving, where
    /// the previous event's bracket would otherwise be shown under the new
    /// event's name.
    pub fn open_event(&self) -> Option<&Tourney> {
        let detail = self.detail.as_ref()?;
        (self.selected_id.as_deref() == Some(detail.id.as_str())).then_some(detail)
    }

    /// Unread messages across every room of the open event.
    pub fn unread_total(&self) -> i32 {
        self.chat_rooms.iter().map(|room| room.unread).sum()
    }

    /// The rooms still worth having open, and the finished ones behind them.
    ///
    /// The split the service asks for by sending `done` at all: a room per
    /// match piles up over a bracket, and the ones whose match is played are
    /// noise by the quarter-finals. Order is preserved inside each group,
    /// because the service already sorted it: global first, then the bracket.
    pub fn chat_groups(&self) -> (Vec<&ChatRoom>, Vec<&ChatRoom>) {
        self.chat_rooms.iter().partition(|room| !room.done)
    }

    /// Whether a collapsed "completed" group still has to announce itself.
    ///
    /// Being named by `@` in a room that is folded away would otherwise be
    /// invisible, which is the one case where hiding finished rooms costs
    /// something.
    pub fn completed_wants_attention(&self) -> bool {
        self.chat_rooms
            .iter()
            .any(|room| room.done && room.mentioned)
    }

    /// The one match a write is in flight against, if the pending write names
    /// one at all.
    ///
    /// Only the two reporting actions do; every other write is event-wide.
    /// Answered as the single id rather than tested per match because that is
    /// what a bracket needs: it reads this once and compares, instead of asking
    /// the same question of every match it draws.
    pub fn busy_match_id(&self) -> Option<&str> {
        match &self.pending {
            Some(
                TourneyAction::AnsweringReport { match_id }
                | TourneyAction::DecidingReport { match_id }
                | TourneyAction::Vetoing { match_id }
                | TourneyAction::ReportingFfa { match_id },
            ) => Some(match_id),
            _ => None,
        }
    }

    /// Whether a write is in flight against this match.
    ///
    /// One match's spinner should not disable the rest of the bracket.
    pub fn is_busy_with(&self, match_id: &str) -> bool {
        self.busy_match_id() == Some(match_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum TourneyCommand {
    Load,
    #[serde(rename_all = "camelCase")]
    Select {
        tournament_id: String,
    },
    /// Enter as the signed-in player. The primary action of the whole tab.
    #[serde(rename_all = "camelCase")]
    SignUp {
        tournament_id: String,
    },
    /// Leave again. Which entry to remove is read from the open event's viewer
    /// block rather than passed in: the server hands out that id, and a client
    /// that supplied its own could only ever be wrong about it.
    #[serde(rename_all = "camelCase")]
    Withdraw {
        tournament_id: String,
    },
    #[serde(rename_all = "camelCase")]
    CheckIn {
        tournament_id: String,
    },
    /// Agree with, or refuse, the score the opponent submitted.
    ///
    /// The one report-shaped thing a player does here. Raising a result is the
    /// organiser's, but answering one raised elsewhere is not the same act, and
    /// a client that showed a pending report it could not answer would be worse
    /// than one that never showed it.
    #[serde(rename_all = "camelCase")]
    AnswerReport {
        tournament_id: String,
        match_id: String,
        accept: bool,
    },
    /// Set a result as an organiser, which needs no confirmation.
    #[serde(rename_all = "camelCase")]
    DecideReport {
        tournament_id: String,
        report: MatchReport,
    },
    /// Load the room list for the open event.
    #[serde(rename_all = "camelCase")]
    LoadChat {
        tournament_id: String,
    },
    /// Open one room and read it.
    #[serde(rename_all = "camelCase")]
    OpenRoom {
        tournament_id: String,
        room_id: String,
    },
    #[serde(rename_all = "camelCase")]
    PostChat {
        tournament_id: String,
        room_id: String,
        body: String,
    },
    /// Re-read the open room and the room list, without saying so.
    ///
    /// The service has no push of any kind: it is HTTP, and the website polls.
    /// Without this the tab can send a message and never receive one, which
    /// looks like a working chat until somebody else types.
    ///
    /// Distinct from [`Self::OpenRoom`] because it must be silent: announcing a
    /// load every few seconds would blink the room out and back, and would
    /// fight the reader's scroll position.
    #[serde(rename_all = "camelCase")]
    RefreshChat {
        tournament_id: String,
        room_id: String,
    },
    /// Start a team and captain it.
    #[serde(rename_all = "camelCase")]
    CreateTeam {
        tournament_id: String,
        name: String,
    },
    /// Ask a team for a place. The captain answers; there is no instant join,
    /// because the server removed that path.
    #[serde(rename_all = "camelCase")]
    RequestJoin {
        tournament_id: String,
        team_id: String,
    },
    /// Withdraw an outstanding request.
    #[serde(rename_all = "camelCase")]
    CancelJoin {
        tournament_id: String,
        team_id: String,
    },
    /// Answer somebody's request, as the captain.
    #[serde(rename_all = "camelCase")]
    RespondJoin {
        tournament_id: String,
        team_id: String,
        player_id: String,
        accept: bool,
    },
    /// Ask a player to join, as the captain.
    #[serde(rename_all = "camelCase")]
    InviteToTeam {
        tournament_id: String,
        team_id: String,
        player_id: String,
    },
    /// Answer an invitation addressed to this account.
    #[serde(rename_all = "camelCase")]
    RespondInvite {
        tournament_id: String,
        team_id: String,
        accept: bool,
    },
    /// Leave the team. The last member out dissolves it, and a departing
    /// captain hands the armband to the next member.
    #[serde(rename_all = "camelCase")]
    LeaveTeam {
        tournament_id: String,
    },
    /// Take the team apart, as its captain or an organiser.
    #[serde(rename_all = "camelCase")]
    DisbandTeam {
        tournament_id: String,
        team_id: String,
    },
    #[serde(rename_all = "camelCase")]
    RenameTeam {
        tournament_id: String,
        team_id: String,
        name: String,
    },
    /// Add an entrant by FAF name, as the organiser.
    ///
    /// The name is looked up against FAF server-side; there is no free-typed
    /// entrant, which is what keeps an entry attached to a real account.
    #[serde(rename_all = "camelCase")]
    AddPlayer {
        tournament_id: String,
        name: String,
        /// Only used by an unrated tournament, where the server has no rating
        /// to fetch and asks the organiser for one.
        rating: Option<i32>,
    },
    /// Approve or decline a signup that is waiting, in request mode.
    #[serde(rename_all = "camelCase")]
    RespondSignup {
        tournament_id: String,
        player_id: String,
        accept: bool,
    },
    /// Take an entrant out, as the organiser.
    #[serde(rename_all = "camelCase")]
    RemovePlayer {
        tournament_id: String,
        player_id: String,
    },
    /// Hand the armband to another member of a team.
    #[serde(rename_all = "camelCase")]
    SetCaptain {
        tournament_id: String,
        team_id: String,
        player_id: String,
    },
    /// Move an entrant to another team, or off every team.
    ///
    /// `team_id` of `None` takes them out without removing them from the event,
    /// which is how a substitute is parked. Emptying a team dissolves it, and a
    /// departing captain's armband passes to the next member: the server does
    /// both, so the client reloads rather than guessing.
    #[serde(rename_all = "camelCase")]
    MovePlayer {
        tournament_id: String,
        player_id: String,
        team_id: Option<String>,
    },
    /// Attach a note to an entrant, and set their rating where the event has none.
    ///
    /// Renaming is deliberately absent: identity comes from FAF and the server
    /// refuses it outright. A note is how a substitute or a late arrival gets
    /// labelled. The rating is accepted only by an unrated event.
    #[serde(rename_all = "camelCase")]
    EditPlayer {
        tournament_id: String,
        player_id: String,
        note: String,
        /// Only sent by an unrated event; the server refuses it otherwise.
        rating: Option<i32>,
    },
    /// Ask somebody to enter, by FAF name.
    #[serde(rename_all = "camelCase")]
    InvitePlayer {
        tournament_id: String,
        name: String,
    },
    #[serde(rename_all = "camelCase")]
    Uninvite {
        tournament_id: String,
        faf_id: i32,
    },
    /// Set the seeding, at random or in a given order.
    #[serde(rename_all = "camelCase")]
    Reseed {
        tournament_id: String,
        order: SeedOrder,
    },
    /// Split the field into divisions by combined rating, or back to one with
    /// a count of 1.
    #[serde(rename_all = "camelCase")]
    SplitDivisions {
        tournament_id: String,
        divisions: i32,
    },
    #[serde(rename_all = "camelCase")]
    SetDivision {
        tournament_id: String,
        team_id: String,
        division: i32,
    },
    #[serde(rename_all = "camelCase")]
    PostNews {
        tournament_id: String,
        body: String,
        important: bool,
    },
    #[serde(rename_all = "camelCase")]
    DeleteNews {
        tournament_id: String,
        news_id: String,
    },
    LoadArticles,
    /// Ask whether this account may host, which gates the create button.
    LoadHosting,
    /// Find FAF accounts whose name starts with what has been typed.
    ///
    /// Reuses the same batch account lookup the player card and the leaderboard
    /// read: an organiser adding an entrant is choosing a person, and the client
    /// already knows how to show one. A blank or too-short query clears the list
    /// instead of asking the API for everybody.
    SearchAccounts {
        query: String,
    },
    /// Drop the results: somebody was picked, or the field was left.
    ClearAccountSearch,
    /// Create an event. It becomes the open one, so the organiser lands in it
    /// rather than back at an unchanged list.
    Create {
        draft: TourneyDraft,
    },
    /// Change an existing event's settings. Only the fields a draft carries;
    /// the best-of plan and the veto configuration stay on the website.
    #[serde(rename_all = "camelCase")]
    EditInfo {
        tournament_id: String,
        draft: TourneyDraft,
    },
    /// Make a draft event visible to everyone.
    #[serde(rename_all = "camelCase")]
    Publish {
        tournament_id: String,
    },
    /// Move the event along: form teams, draw the bracket, or go back.
    #[serde(rename_all = "camelCase")]
    Advance {
        tournament_id: String,
        phase: TourneyPhase,
        /// The best-of plan, on `start_bracket` alone. `None` everywhere else,
        /// and on a draw that takes the service's own defaults.
        config: Option<BracketConfig>,
    },
    /// Hide the event. Restorable by a site admin, which is why it is not
    /// called delete.
    #[serde(rename_all = "camelCase")]
    Archive {
        tournament_id: String,
    },
    /// Bind a map pool to a round, or clear it with an empty `pool_id`.
    #[serde(rename_all = "camelCase")]
    AssignPool {
        tournament_id: String,
        round_key: String,
        pool_id: String,
    },
    /// Take the draft pick that is due.
    #[serde(rename_all = "camelCase")]
    DraftPickPlayer {
        tournament_id: String,
        player_id: String,
    },
    /// Take back the last pick.
    #[serde(rename_all = "camelCase")]
    DraftUndo {
        tournament_id: String,
    },
    /// Mark which entrants captain a team, before the draft starts.
    #[serde(rename_all = "camelCase")]
    SetCaptains {
        tournament_id: String,
        player_ids: Vec<String>,
    },
    /// Record a free-for-all lobby: either who went through, or the points.
    #[serde(rename_all = "camelCase")]
    ReportFfa {
        tournament_id: String,
        report: FfaReport,
    },
    /// Take the veto step that is due: ban or pick the named map.
    #[serde(rename_all = "camelCase")]
    VetoAct {
        tournament_id: String,
        match_id: String,
        /// A map id from the run's `remaining`.
        map_id: String,
    },
    /// Say which of the two teams is A, before the run starts.
    #[serde(rename_all = "camelCase")]
    VetoSetSides {
        tournament_id: String,
        match_id: String,
        team_a: String,
    },
    /// Take back the last step. The organiser's, for a misclick.
    #[serde(rename_all = "camelCase")]
    VetoUndo {
        tournament_id: String,
        match_id: String,
    },
    /// Add a map to the event's own database, or edit one already in it.
    #[serde(rename_all = "camelCase")]
    SaveMap {
        tournament_id: String,
        map: MapDraft,
    },
    /// Show or hide one map.
    #[serde(rename_all = "camelCase")]
    PublishMap {
        tournament_id: String,
        map_id: String,
        published: bool,
    },
    #[serde(rename_all = "camelCase")]
    DeleteMap {
        tournament_id: String,
        map_id: String,
    },
    /// Show or hide one pool. Publishing also publishes the maps in it.
    #[serde(rename_all = "camelCase")]
    PublishPool {
        tournament_id: String,
        pool_id: String,
        published: bool,
    },
    #[serde(rename_all = "camelCase")]
    DeletePool {
        tournament_id: String,
        pool_id: String,
    },
    #[serde(rename_all = "camelCase")]
    SavePool {
        tournament_id: String,
        pool: PoolDraft,
    },
    /// Load every series, for the picker and the series list.
    LoadSeries,
    /// Open one series and read its editions.
    #[serde(rename_all = "camelCase")]
    OpenSeries {
        series_id: String,
    },
    /// Close it again, back to the list.
    CloseSeries,
    /// Create a series, or rename one that exists.
    SaveSeries {
        draft: SeriesDraft,
    },
    /// Delete a series. Its editions are unfiled, not deleted.
    #[serde(rename_all = "camelCase")]
    DeleteSeries {
        series_id: String,
    },
    /// File this event under a series, or take it out with `None`.
    #[serde(rename_all = "camelCase")]
    SetSeries {
        tournament_id: String,
        series_id: Option<String>,
    },
    /// Link an event whose result feeds entrants into this one.
    #[serde(rename_all = "camelCase")]
    AddQualifier {
        tournament_id: String,
        /// The child event.
        qualifier_id: String,
        rule: QualifierRule,
    },
    /// Unlink one. Invites it already sent are kept, which is why this is not
    /// an undo.
    #[serde(rename_all = "camelCase")]
    RemoveQualifier {
        tournament_id: String,
        /// The link's own id, not the child's.
        link_id: String,
    },
    /// Change the shape of the competition, before the bracket is drawn.
    #[serde(rename_all = "camelCase")]
    EditFormat {
        tournament_id: String,
        format: FormatDraft,
    },
    /// Silence an account in the event's chat, or let it speak again.
    #[serde(rename_all = "camelCase")]
    MuteChat {
        tournament_id: String,
        faf_id: i32,
        /// Carried so the muted list can name them: the service stores the name
        /// alongside the id, having no other way to resolve it afterwards.
        name: String,
        muted: bool,
    },
    /// Take one post out of a room.
    #[serde(rename_all = "camelCase")]
    DeleteChatPost {
        tournament_id: String,
        room_id: String,
        post_id: String,
    },
    /// Give a FAF account organiser rights here.
    ///
    /// There is no counterpart: taking them away is the site admin's, and the
    /// client cannot tell whether this account is one.
    #[serde(rename_all = "camelCase")]
    AddOrganiser {
        tournament_id: String,
        faf_id: i32,
        name: String,
    },
    /// Let a FAF account cast this event, or take that back.
    ///
    /// One command for both directions: the two service endpoints differ only
    /// in whether a name rides along, and a pair of commands could disagree
    /// about which way the flag pointed.
    #[serde(rename_all = "camelCase")]
    SetCaster {
        tournament_id: String,
        faf_id: i32,
        name: String,
        casting: bool,
    },
    /// Show or hide one organiser in the public list. They stay an organiser
    /// either way.
    #[serde(rename_all = "camelCase")]
    SetOrganiserVisibility {
        tournament_id: String,
        faf_id: i32,
        hidden: bool,
    },
    /// Mark the event as called off, or take that back.
    #[serde(rename_all = "camelCase")]
    Abandon {
        tournament_id: String,
        abandoned: bool,
    },
    /// Correct an announcement already posted.
    #[serde(rename_all = "camelCase")]
    EditNews {
        tournament_id: String,
        news_id: String,
        body: String,
        important: bool,
    },
    /// Clear this account's unread badge, on every device.
    #[serde(rename_all = "camelCase")]
    MarkNewsRead {
        tournament_id: String,
    },
    DismissActionError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum TourneyEvent {
    Loading,
    Loaded {
        events: Vec<Tourney>,
    },
    LoadFailed {
        reason: String,
        kind: RequestFailureKind,
    },
    #[serde(rename_all = "camelCase")]
    Selected {
        tournament_id: String,
    },
    DetailLoading,
    DetailLoaded {
        /// Boxed because a whole tournament is by far the largest thing this
        /// enum carries, and every other variant would be padded up to it.
        event: Box<Tourney>,
    },
    DetailLoadFailed {
        reason: String,
        kind: RequestFailureKind,
    },
    ActionStarted {
        action: TourneyAction,
    },
    #[serde(rename_all = "camelCase")]
    ActionSucceeded {
        action: TourneyAction,
        /// The event to open afterwards, which is how a freshly created one
        /// becomes the selected row.
        select: Option<String>,
    },
    ActionFailed {
        failure: TourneyActionFailure,
    },
    ActionErrorDismissed,
    EntrantProfilesLoaded {
        profiles: Vec<PlayerSummary>,
    },
    ChatRoomsLoaded {
        rooms: Vec<ChatRoom>,
    },
    #[serde(rename_all = "camelCase")]
    RoomOpened {
        room_id: String,
    },
    ChatLoading,
    #[serde(rename_all = "camelCase")]
    ChatLoaded {
        room_id: String,
        posts: Vec<ChatPost>,
    },
    ChatFailed {
        reason: String,
        kind: RequestFailureKind,
    },
    ArticlesLoaded {
        articles: Vec<Article>,
    },
    HostingLoaded {
        hosting: HostingStatus,
    },
    /// An account search started; the field carries the query it is for.
    AccountSearchStarted {
        query: String,
    },
    AccountSearchLoaded {
        query: String,
        matches: Vec<PlayerSummary>,
    },
    AccountSearchFailed {
        query: String,
        reason: String,
        kind: RequestFailureKind,
    },
    /// The organiser picked somebody, or left the field: drop the list.
    AccountSearchCleared,
    SeriesLoading,
    SeriesLoaded {
        series: Vec<TourneySeries>,
    },
    SeriesFailed {
        reason: String,
        kind: RequestFailureKind,
    },
    /// One series opened, with its editions.
    SeriesOpened {
        /// Boxed for the same reason the tournament detail is: a series with
        /// its editions is the largest thing this enum carries.
        detail: Box<SeriesDetail>,
    },
    SeriesClosed,
}

pub fn reduce(state: &mut TourneyState, event: &TourneyEvent) {
    match event {
        TourneyEvent::Loading => state.status = TourneyLoadStatus::Loading,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn player(id: &str, name: &str, faf_id: Option<i32>) -> TourneyPlayer {
        TourneyPlayer {
            id: id.into(),
            name: name.into(),
            faf_id,
            rating: Some(1500),
            rating_actual: Some(1500),
            team_id: None,
            manual: false,
            late: false,
            pending: false,
            note: String::new(),
            signed_at: None,
        }
    }

    fn team(id: &str, name: &str, players: &[&str]) -> TourneyTeam {
        TourneyTeam {
            id: id.into(),
            name: name.into(),
            seed: 1,
            captain_id: players.first().map(|id| (*id).to_string()),
            player_ids: players.iter().map(|id| (*id).to_string()).collect(),
            division: 0,
            checked_in: false,
            eliminated: false,
            out: None,
            final_rank: None,
            captain_renamed: false,
            join_requests: Vec::new(),
            invites: Vec::new(),
        }
    }

    fn playable_match() -> TourneyMatch {
        TourneyMatch {
            id: "m1".into(),
            bracket: BracketSide::Winners,
            round: 1,
            index: 0,
            best_of: 3,
            handicap: 0,
            division: 0,
            team1: Some("t1".into()),
            team2: Some("t2".into()),
            score1: None,
            score2: None,
            status: MatchStatus::Ready,
            winner: None,
            loser: None,
            winner_to: None,
            loser_to: None,
            pending_report: None,
            veto: None,
            entrants: Vec::new(),
            winners: Vec::new(),
            points: Vec::new(),
            is_final: false,
            replay_ids: Vec::new(),
        }
    }

    /// The event as seen by whoever plays for `my_team`.
    fn event_seen_by(my_team: &str) -> Tourney {
        Tourney {
            id: "e1".into(),
            status: TourneyStatus::Running,
            player_reporting: true,
            players: vec![
                player("p1", "Nuggets", Some(101)),
                player("p2", "Ada", Some(102)),
                player("p3", "Grace", None),
            ],
            teams: vec![team("t1", "", &["p1", "p3"]), team("t2", "Blue", &["p2"])],
            matches: vec![playable_match()],
            viewer: TourneyViewer {
                logged_in: true,
                member_team_id: Some(my_team.into()),
                signed_up_player_id: Some("p1".into()),
                ..TourneyViewer::default()
            },
            ..Tourney::default()
        }
    }

    fn event() -> Tourney {
        event_seen_by("t1")
    }

    #[test]
    fn a_team_without_a_name_is_called_after_its_first_player() {
        // What an organiser expects for a team that never named itself, and
        // vastly better than showing `t1`.
        let event = event();
        assert_eq!(event.teams[0].display_name(&event.players), "Nuggets");
        assert_eq!(event.teams[1].display_name(&event.players), "Blue");
    }

    #[test]
    fn a_team_with_neither_a_name_nor_players_reads_empty_rather_than_as_an_id() {
        let empty = team("t9", "", &[]);
        assert_eq!(empty.display_name(&[]), "");
    }

    #[test]
    fn members_come_back_in_join_order() {
        let event = event();
        let names: Vec<&str> = event
            .members(&event.teams[0])
            .iter()
            .map(|player| player.name.as_str())
            .collect();
        assert_eq!(names, vec!["Nuggets", "Grace"]);
    }

    /// The same event as `event()`, seen by whoever runs it.
    fn organised_event() -> Tourney {
        Tourney {
            viewer: TourneyViewer {
                logged_in: true,
                organiser: true,
                ..TourneyViewer::default()
            },
            ..event()
        }
    }

    #[test]
    fn the_organiser_may_record_a_result() {
        assert!(organised_event().may_report(&playable_match()));
    }

    #[test]
    fn a_player_in_the_match_may_not() {
        // This client keeps result-entry with the organiser. The service does
        // offer players their own path, but it insists on a FAF replay id per
        // game, and that is not the flow here.
        assert!(!event_seen_by("t1").may_report(&playable_match()));
        assert!(!event_seen_by("t2").may_report(&playable_match()));
        assert!(!event_seen_by("t9").may_report(&playable_match()));
    }

    #[test]
    fn the_player_reporting_switch_does_not_gate_the_organiser() {
        // It decides whether *players* may report. An organiser records results
        // either way, which is the whole point of the flag existing.
        let event = Tourney {
            player_reporting: false,
            ..organised_event()
        };
        assert!(event.may_report(&event.matches[0]));
    }

    #[test]
    fn a_series_in_progress_is_still_reportable() {
        // The bug this guards: `live` means 1-1 with a game still to play, and
        // reading it as "not ready" would take the control away mid-series.
        let event = organised_event();
        let live = TourneyMatch {
            status: MatchStatus::Live,
            score1: Some(1),
            score2: Some(1),
            ..event.matches[0].clone()
        };
        assert!(live.is_playable());
        assert!(event.may_report(&live));
    }

    #[test]
    fn a_finished_match_stays_reportable_so_a_wrong_result_can_be_fixed() {
        // `report` is the correction path too: it undoes the old result and sets
        // the new one. Withdrawing the control once a match is done would leave a
        // mistake permanent.
        let event = organised_event();
        let done = TourneyMatch {
            status: MatchStatus::Done,
            score1: Some(2),
            score2: Some(0),
            winner: event.matches[0].team1.clone(),
            ..event.matches[0].clone()
        };
        assert!(event.may_report(&done));
    }

    #[test]
    fn a_match_still_waiting_on_a_feeder_is_not_reportable() {
        let event = event();
        let waiting = TourneyMatch {
            team2: None,
            status: MatchStatus::Waiting,
            ..event.matches[0].clone()
        };
        assert!(!waiting.is_playable());
        assert!(!event.may_report(&waiting));
    }

    #[test]
    fn a_decided_series_is_the_organisers_to_correct() {
        let event = event();
        let done = TourneyMatch {
            status: MatchStatus::Done,
            ..event.matches[0].clone()
        };
        assert!(!event.may_report(&done));
    }

    #[test]
    fn only_the_other_side_confirms_a_submitted_score() {
        // Confirming your own submission would make the second signature
        // worthless, which is exactly what the server refuses.
        let submitted = TourneyMatch {
            pending_report: Some(PendingReport {
                score1: 2,
                score2: 1,
                by_team: "t1".into(),
                by_name: "Nuggets".into(),
                replay_ids: vec!["22334455".into()],
                at: None,
            }),
            ..playable_match()
        };
        assert!(event_seen_by("t2").may_confirm(&submitted));
        assert!(!event_seen_by("t1").may_confirm(&submitted));
        assert!(!event_seen_by("t9").may_confirm(&submitted));
        // Nothing submitted, nothing to confirm.
        assert!(!event_seen_by("t2").may_confirm(&playable_match()));
    }

    #[test]
    fn entering_is_offered_while_signups_are_open_and_not_after() {
        let mut event = Tourney {
            status: TourneyStatus::Signup,
            viewer: TourneyViewer {
                logged_in: true,
                ..TourneyViewer::default()
            },
            ..Tourney::default()
        };
        assert!(event.may_sign_up());
        assert!(!event.may_withdraw());

        // Signed up: the pair flips.
        event.viewer.signed_up_player_id = Some("p1".into());
        assert!(!event.may_sign_up());
        assert!(event.may_withdraw());

        // Once the bracket is drawn, leaving is the organiser's to do.
        event.status = TourneyStatus::Running;
        assert!(!event.may_withdraw());

        // Signed out: neither, whatever the status.
        event.viewer = TourneyViewer::default();
        event.status = TourneyStatus::Signup;
        assert!(!event.may_sign_up());
    }

    #[test]
    fn a_pool_is_found_through_its_round_assignment() {
        let event = Tourney {
            map_db: vec![
                TourneyMap {
                    id: "m1".into(),
                    name: "Setons".into(),
                    image_url: String::new(),
                    description: String::new(),
                    published: true,
                },
                TourneyMap {
                    id: "m2".into(),
                    name: "Astro".into(),
                    image_url: String::new(),
                    description: String::new(),
                    published: true,
                },
            ],
            map_pools: vec![MapPool {
                id: "pool1".into(),
                name: "Round 1".into(),
                map_ids: vec!["m2".into(), "m1".into()],
                sequence: vec![],
                best_of: Some(3),
                published: true,
                publish_at: None,
            }],
            pool_assign: vec![PoolAssignment {
                round: "1".into(),
                pool_id: "pool1".into(),
            }],
            ..Tourney::default()
        };

        let pool = event
            .pool_for_round("1")
            .expect("a pool is bound to round 1");
        assert_eq!(pool.name, "Round 1");
        // The pool's own order, not the map database's.
        let names: Vec<&str> = event
            .pool_maps(pool)
            .iter()
            .map(|map| map.name.as_str())
            .collect();
        assert_eq!(names, vec!["Astro", "Setons"]);
        assert!(event.pool_for_round("2").is_none());
    }

    /// Stand-in for `VaultMap`, so this test does not depend on the maps slice.
    struct Vault {
        display: &'static str,
        folder: &'static str,
    }

    const VAULT: [Vault; 2] = [
        Vault {
            display: "Seton's Clutch",
            folder: "scmp_009.v0001",
        },
        Vault {
            display: "Astro Crater Battles",
            folder: "astro_crater.v0003",
        },
    ];

    fn resolve(name: &str) -> Option<&'static str> {
        let map = TourneyMap {
            id: "m".into(),
            name: name.into(),
            image_url: String::new(),
            description: String::new(),
            published: true,
        };
        match_vault_map(&map, &VAULT, |v| v.display, |v| v.folder).map(|v| v.display)
    }

    #[test]
    fn a_hand_typed_map_name_still_finds_its_vault_entry() {
        // Organisers type these by hand, and every one of these spellings turns
        // up in a real tournament.
        for spelling in [
            "Seton's Clutch",
            "setons clutch",
            "SETONS CLUTCH",
            "Setons_Clutch",
            "seton''s  clutch",
        ] {
            assert_eq!(
                resolve(spelling),
                Some("Seton's Clutch"),
                "for {spelling:?}"
            );
        }
    }

    #[test]
    fn the_folder_name_resolves_too_version_and_all() {
        // A TD who copied the folder out of their maps directory.
        assert_eq!(resolve("scmp_009"), Some("Seton's Clutch"));
        assert_eq!(resolve("SCMP_009.v0001"), Some("Seton's Clutch"));
    }

    #[test]
    fn a_map_that_is_not_in_the_vault_resolves_to_nothing() {
        // A real case: tournaments do run maps that were never uploaded. The
        // caller falls back to the tournament server's own image.
        assert_eq!(resolve("Some Private Map"), None);
        assert_eq!(resolve(""), None);
        assert_eq!(resolve("   "), None);
    }

    #[test]
    fn the_display_name_wins_over_a_coincidental_folder_match() {
        // Both lookups exist; the human-readable one is the one an organiser
        // meant, so it is tried first.
        assert_eq!(
            resolve("Astro Crater Battles"),
            Some("Astro Crater Battles")
        );
    }

    // --- the slice ---------------------------------------------------------

    fn row(id: &str) -> Tourney {
        Tourney {
            id: id.into(),
            name: format!("Event {id}"),
            player_count: 8,
            ..Tourney::default()
        }
    }

    fn apply(state: &mut TourneyState, events: &[TourneyEvent]) {
        for event in events {
            reduce(state, event);
        }
    }

    #[test]
    fn the_first_load_opens_the_first_event() {
        let mut state = TourneyState::default();
        apply(
            &mut state,
            &[
                TourneyEvent::Loading,
                TourneyEvent::Loaded {
                    events: vec![row("e1"), row("e2")],
                },
            ],
        );
        assert_eq!(state.status, TourneyLoadStatus::Ready);
        assert_eq!(state.selected_id.as_deref(), Some("e1"));
    }

    #[test]
    fn a_refresh_leaves_the_open_event_open() {
        // A reload must not throw the reader back to the top of the list.
        let mut state = TourneyState::default();
        apply(
            &mut state,
            &[
                TourneyEvent::Loaded {
                    events: vec![row("e1"), row("e2")],
                },
                TourneyEvent::Selected {
                    tournament_id: "e2".into(),
                },
                TourneyEvent::DetailLoaded {
                    event: Box::new(row("e2")),
                },
                TourneyEvent::Loaded {
                    events: vec![row("e1"), row("e2")],
                },
            ],
        );
        assert_eq!(state.selected_id.as_deref(), Some("e2"));
        assert!(
            state.open_event().is_some(),
            "the detail survives a refresh"
        );
    }

    #[test]
    fn an_event_that_disappears_takes_its_detail_with_it() {
        let mut state = TourneyState::default();
        apply(
            &mut state,
            &[
                TourneyEvent::Loaded {
                    events: vec![row("e1"), row("e2")],
                },
                TourneyEvent::Selected {
                    tournament_id: "e2".into(),
                },
                TourneyEvent::DetailLoaded {
                    event: Box::new(row("e2")),
                },
                TourneyEvent::ChatRoomsLoaded {
                    rooms: vec![ChatRoom {
                        id: "global".into(),
                        name: "Global".into(),
                        unread: 2,
                        ..ChatRoom::default()
                    }],
                },
                // e2 was archived between refreshes.
                TourneyEvent::Loaded {
                    events: vec![row("e1")],
                },
            ],
        );
        assert_eq!(state.selected_id.as_deref(), Some("e1"));
        assert!(state.detail.is_none());
        assert!(state.chat_rooms.is_empty(), "the chat went with it");
    }

    #[test]
    fn a_detail_for_a_row_nobody_is_looking_at_is_dropped() {
        // The window between clicking a second row and the first one's detail
        // arriving. Letting it land would caption one bracket with another
        // tournament's name.
        let mut state = TourneyState::default();
        apply(
            &mut state,
            &[
                TourneyEvent::Loaded {
                    events: vec![row("e1"), row("e2")],
                },
                TourneyEvent::Selected {
                    tournament_id: "e2".into(),
                },
                TourneyEvent::DetailLoaded {
                    event: Box::new(row("e1")),
                },
            ],
        );
        assert!(state.detail.is_none());
        assert!(state.open_event().is_none());
    }

    #[test]
    fn switching_events_drops_the_previous_ones_conversation_at_once() {
        let mut state = TourneyState::default();
        apply(
            &mut state,
            &[
                TourneyEvent::Loaded {
                    events: vec![row("e1"), row("e2")],
                },
                TourneyEvent::DetailLoaded {
                    event: Box::new(row("e1")),
                },
                TourneyEvent::ChatRoomsLoaded {
                    rooms: vec![ChatRoom {
                        id: "global".into(),
                        name: "Global".into(),
                        unread: 0,
                        ..ChatRoom::default()
                    }],
                },
                TourneyEvent::RoomOpened {
                    room_id: "global".into(),
                },
                TourneyEvent::ChatLoaded {
                    room_id: "global".into(),
                    posts: vec![ChatPost {
                        faf_id: Some(102),
                        id: "c1".into(),
                        author: "Ada".into(),
                        body: "gl hf".into(),
                        at: None,
                        system: false,
                    }],
                },
                TourneyEvent::Selected {
                    tournament_id: "e2".into(),
                },
            ],
        );
        assert!(state.detail.is_none());
        assert!(state.chat_posts.is_empty());
        assert!(state.open_room_id.is_none());
    }

    #[test]
    fn reading_a_room_clears_its_badge_without_a_second_request() {
        // The server clears the marker when the room is read, so waiting for
        // the next room list would leave a badge on a room already open.
        let mut state = TourneyState::default();
        apply(
            &mut state,
            &[
                TourneyEvent::ChatRoomsLoaded {
                    rooms: vec![
                        ChatRoom {
                            id: "global".into(),
                            name: "Global".into(),
                            unread: 3,
                            ..ChatRoom::default()
                        },
                        ChatRoom {
                            id: "m1".into(),
                            name: "Nuggets vs Ada".into(),
                            unread: 1,
                            ..ChatRoom::default()
                        },
                    ],
                },
                TourneyEvent::RoomOpened {
                    room_id: "global".into(),
                },
                TourneyEvent::ChatLoaded {
                    room_id: "global".into(),
                    posts: vec![],
                },
            ],
        );
        assert_eq!(
            state.unread_total(),
            1,
            "only the room that was read clears"
        );
    }

    #[test]
    fn posts_for_a_room_that_is_no_longer_open_are_ignored() {
        let mut state = TourneyState::default();
        apply(
            &mut state,
            &[
                TourneyEvent::RoomOpened {
                    room_id: "m1".into(),
                },
                TourneyEvent::ChatLoaded {
                    room_id: "global".into(),
                    posts: vec![ChatPost {
                        faf_id: Some(102),
                        id: "c1".into(),
                        author: "Ada".into(),
                        body: "wrong room".into(),
                        at: None,
                        system: false,
                    }],
                },
            ],
        );
        assert!(state.chat_posts.is_empty());
    }

    #[test]
    fn a_refused_write_survives_until_it_is_dismissed() {
        // A message that vanished on the next re-render would never be read.
        let mut state = TourneyState::default();
        let failure = TourneyActionFailure {
            action: TourneyAction::SigningUp,
            reason: "Your rating (1420) is below this tournament’s minimum of 1500.".into(),
            kind: RequestFailureKind::Rejected,
        };
        apply(
            &mut state,
            &[
                TourneyEvent::ActionStarted {
                    action: TourneyAction::SigningUp,
                },
                TourneyEvent::ActionFailed {
                    failure: failure.clone(),
                },
            ],
        );
        assert!(state.pending.is_none());
        assert_eq!(state.action_error, Some(failure));

        // Starting another action clears it, and so does dismissing it.
        reduce(
            &mut state,
            &TourneyEvent::ActionStarted {
                action: TourneyAction::CheckingIn,
            },
        );
        assert!(state.action_error.is_none());
        reduce(&mut state, &TourneyEvent::ActionErrorDismissed);
        assert!(state.action_error.is_none());
    }

    /// A team at a known seed, optionally knocked out at a known depth.
    fn ranked_team(id: &str, seed: i32, out: Option<(BracketSide, i32)>) -> TourneyTeam {
        TourneyTeam {
            seed,
            out: out.map(|(bracket, round)| TeamExit { bracket, round }),
            ..team(id, id, &[])
        }
    }

    fn bracket_event(kind: BracketKind, teams: Vec<TourneyTeam>) -> Tourney {
        Tourney {
            id: "e1".into(),
            status: TourneyStatus::Running,
            bracket_kind: kind,
            teams,
            ..Tourney::default()
        }
    }

    #[test]
    fn standings_are_empty_until_there_is_a_bracket() {
        let event = Tourney {
            status: TourneyStatus::Signup,
            teams: vec![ranked_team("t1", 1, None)],
            ..Tourney::default()
        };
        assert_eq!(event.standings_kind(), StandingsKind::None);
        assert!(event.standings().is_empty());
    }

    #[test]
    fn an_elimination_table_ranks_by_how_far_each_run_got() {
        // A four-team double elimination, played out: t1 won it, t2 lost the
        // grand final, and t3 and t4 both went out in the first losers round.
        let mut event = bracket_event(
            BracketKind::Double,
            vec![
                ranked_team("t4", 4, Some((BracketSide::Losers, 1))),
                ranked_team("t2", 2, Some((BracketSide::GrandFinal, 1))),
                ranked_team("t3", 3, Some((BracketSide::Losers, 1))),
                ranked_team("t1", 1, None),
            ],
        );
        event.champion_team_id = Some("t1".into());

        let rows = event.standings();
        let order: Vec<&str> = rows.iter().map(|row| row.team_id.as_str()).collect();
        assert_eq!(order, vec!["t1", "t2", "t3", "t4"], "seed breaks the tie");
        assert_eq!(
            rows.iter().map(|row| row.place).collect::<Vec<_>>(),
            vec![Some(1), Some(2), Some(3), Some(3)],
            "two teams out at the same depth share third"
        );
        assert_eq!(rows[0].outcome, StandingOutcome::Champion);
        assert_eq!(rows[1].outcome, StandingOutcome::LostFinal);
        assert_eq!(
            rows[3].outcome,
            StandingOutcome::OutIn {
                bracket: BracketSide::Losers,
                round: 1
            }
        );
    }

    #[test]
    fn a_team_still_in_it_outranks_everyone_out_and_has_no_place_yet() {
        // Mid-event: nobody has won, so calling the survivor first would be a
        // guess, and calling the knocked-out team second would imply one.
        let event = bracket_event(
            BracketKind::Single,
            vec![
                ranked_team("t2", 2, Some((BracketSide::Winners, 1))),
                ranked_team("t1", 1, None),
            ],
        );
        let rows = event.standings();
        assert_eq!(rows[0].team_id, "t1");
        assert_eq!(rows[0].outcome, StandingOutcome::StillIn);
        assert_eq!(rows[0].place, None, "no place while the run is unfinished");
        assert_eq!(rows[1].place, Some(2));
    }

    #[test]
    fn a_later_losers_round_outranks_an_earlier_one() {
        let event = bracket_event(
            BracketKind::Double,
            vec![
                ranked_team("early", 1, Some((BracketSide::Losers, 1))),
                ranked_team("late", 2, Some((BracketSide::Losers, 3))),
            ],
        );
        let rows = event.standings();
        let order: Vec<&str> = rows.iter().map(|row| row.team_id.as_str()).collect();
        assert_eq!(order, vec!["late", "early"]);
    }

    #[test]
    fn a_swiss_table_counts_wins_then_game_difference() {
        let mut event = bracket_event(
            BracketKind::Swiss,
            vec![
                ranked_team("t1", 1, None),
                ranked_team("t2", 2, None),
                ranked_team("t3", 3, None),
            ],
        );
        // t1 beat t2 two games to nil; t3 drew the bye.
        let mut decided = TourneyMatch {
            bracket: BracketSide::Swiss,
            status: MatchStatus::Done,
            team1: Some("t1".into()),
            team2: Some("t2".into()),
            score1: Some(2),
            score2: Some(0),
            winner: Some("t1".into()),
            loser: Some("t2".into()),
            ..playable_match()
        };
        decided.id = "m1".into();
        let bye = TourneyMatch {
            id: "m2".into(),
            bracket: BracketSide::Swiss,
            status: MatchStatus::Bye,
            team1: Some("t3".into()),
            team2: None,
            ..playable_match()
        };
        event.matches = vec![decided, bye];

        let rows = event.standings();
        assert_eq!(rows[0].team_id, "t1");
        assert_eq!((rows[0].wins, rows[0].losses, rows[0].game_diff), (1, 0, 2));
        assert_eq!(rows[1].team_id, "t3", "a bye is a win worth one game");
        assert_eq!((rows[1].wins, rows[1].losses, rows[1].game_diff), (1, 0, 1));
        assert_eq!(rows[2].team_id, "t2");
        assert_eq!(
            (rows[2].wins, rows[2].losses, rows[2].game_diff),
            (0, 1, -2)
        );
        assert_eq!(
            rows.iter().map(|row| row.place).collect::<Vec<_>>(),
            vec![Some(1), Some(2), Some(3)],
            "a Swiss table always ranks every row"
        );
    }

    #[test]
    fn an_imported_event_uses_the_placings_it_arrived_with() {
        // No matches at all, which is the case the elimination table cannot
        // serve: an import often carries nothing but its final table.
        let event = Tourney {
            imported: true,
            status: TourneyStatus::Finished,
            teams: vec![
                TourneyTeam {
                    final_rank: Some(2),
                    ..ranked_team("t2", 2, None)
                },
                TourneyTeam {
                    final_rank: Some(1),
                    ..ranked_team("t1", 1, None)
                },
                ranked_team("t9", 9, None),
            ],
            ..Tourney::default()
        };
        assert_eq!(event.standings_kind(), StandingsKind::Imported);

        let rows = event.standings();
        let order: Vec<&str> = rows.iter().map(|row| row.team_id.as_str()).collect();
        assert_eq!(order, vec!["t1", "t2", "t9"], "unplaced sorts last");
        assert_eq!(rows[0].place, Some(1));
        assert_eq!(rows[2].place, None);
        assert_eq!(rows[0].outcome, StandingOutcome::Placed);
    }

    #[test]
    fn one_matchs_spinner_does_not_disable_the_rest_of_the_bracket() {
        let mut state = TourneyState::default();
        reduce(
            &mut state,
            &TourneyEvent::ActionStarted {
                action: TourneyAction::DecidingReport {
                    match_id: "m1".into(),
                },
            },
        );
        assert!(state.is_busy_with("m1"));
        assert!(!state.is_busy_with("m2"));

        reduce(
            &mut state,
            &TourneyEvent::ActionSucceeded {
                action: TourneyAction::DecidingReport {
                    match_id: "m1".into(),
                },
                select: None,
            },
        );
        assert!(!state.is_busy_with("m1"));
    }

    #[test]
    fn an_entrant_without_a_faf_account_simply_has_no_profile() {
        // Organisers can add a player by hand; that entry is a name and nothing
        // else, and it still belongs in the bracket.
        let state = TourneyState {
            entrant_profiles: vec![PlayerSummary {
                id: 102,
                login: "Ada".into(),
                avatar_url: String::new(),
                country: "GB".into(),
                global_rating: Some(1_910),
                ladder_rating: None,
            }],
            ..TourneyState::default()
        };
        assert_eq!(
            state
                .profile_of(&player("p2", "Ada", Some(102)))
                .map(|profile| profile.login.as_str()),
            Some("Ada")
        );
        assert!(state.profile_of(&player("p9", "Walk-in", None)).is_none());
        assert!(state
            .profile_of(&player("p3", "Grace", Some(999)))
            .is_none());
    }

    #[test]
    fn unknown_wire_values_fall_back_without_inventing_meaning() {
        // An unrecognised match state must not read as playable: that would
        // offer a report the server rejects.
        assert_eq!(MatchStatus::from_wire("who knows"), MatchStatus::Waiting);
        assert_eq!(MatchStatus::from_wire("live"), MatchStatus::Live);
        assert_eq!(MatchStatus::from_wire("bye"), MatchStatus::Bye);
        // An unrecognised tournament status is admitted as unknown rather than
        // guessed at, because real actions are gated on it.
        assert_eq!(
            TourneyStatus::from_wire("who knows"),
            TourneyStatus::Unknown
        );
        assert_eq!(TourneyStatus::from_wire("drafted"), TourneyStatus::Drafted);
        assert_eq!(BracketSide::from_wire(""), BracketSide::Winners);
        assert_eq!(BracketSide::from_wire("sw"), BracketSide::Swiss);
        assert_eq!(BracketSide::from_wire("ffa"), BracketSide::FreeForAll);
        assert_eq!(Formation::from_wire("premade"), Formation::Open);
        assert_eq!(BracketKind::from_wire("Double"), BracketKind::Double);
        assert_eq!(Competition::from_wire("FFA"), Competition::FreeForAll);
    }
}
