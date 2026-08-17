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
    /// slot is still waiting on a feeder — the server refuses both, and it cannot
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
    /// The ban/pick sequence, as the organiser arranged it.
    pub sequence: Vec<String>,
    pub best_of: Option<i32>,
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
    /// Announced, not yet open.
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
/// builds the document — which is why it is invisible when reading `publicView`
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
    /// Whether players may report their own results, or only organisers can.
    pub player_reporting: bool,
    pub veto_enabled: bool,
    pub rating: RatingGate,
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
    pub champion_team_id: Option<String>,
    /// What this account may do here, as the server sees it.
    pub viewer: TourneyViewer,
}

/// A chat room this account is allowed to see.
///
/// Visibility is decided server-side by permission, so the client shows what it
/// is given rather than filtering: an organisers-only room simply never arrives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatRoom {
    pub id: String,
    pub name: String,
    /// Messages posted since this account last opened the room.
    pub unread: i32,
}

/// One post in a tournament chat room.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatPost {
    pub id: String,
    pub author: String,
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
    /// reached the wins the series needs — a 1-1 that ended in a walkover, or any
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
    /// Still worth knowing — an organiser correcting a series wants to see it —
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
    /// no-show — the commonest reason a bracket stalls.
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
    /// has to have two sides. A finished match stays reportable — `report` is also
    /// the correction path, and it undoes the old result first.
    pub fn may_report(&self, entry: &TourneyMatch) -> bool {
        self.viewer.organiser
            && self.status.has_bracket()
            && entry.bracket != BracketSide::FreeForAll
            && entry.team1.is_some()
            && entry.team2.is_some()
    }

    /// Whether this account may rename or take apart `team`.
    ///
    /// An organiser may rename any team as often as needed. A captain gets one
    /// rename, and only where teams have more than one player — the server counts
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
    pub player_reporting: bool,
    /// Unix seconds; sent as an ISO instant, which is what the server stores.
    pub event_date: Option<u32>,
    pub signup_opens_at: Option<u32>,
    pub signup_closes_at: Option<u32>,
    pub rating: RatingGate,
    /// Entrant cap. Zero means no cap, which is the server's own convention.
    pub max_teams: i32,
}

impl TourneyDraft {
    /// The defaults a new event starts from: a 2v2 community cup, open signups,
    /// players reporting their own results.
    pub fn new() -> Self {
        Self {
            team_size: 2,
            player_reporting: true,
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
}

impl TourneyPhase {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::FormTeams => "form_teams",
            Self::StartBracket => "start_bracket",
            Self::ReopenSignups => "reopen_signups",
        }
    }

    /// Whether this step is legal from `status`.
    ///
    /// The server's own gate, mirrored so a button that will be refused is not
    /// drawn at all.
    pub fn is_legal_from(self, status: TourneyStatus) -> bool {
        match self {
            Self::FormTeams => status == TourneyStatus::Signup,
            Self::StartBracket => status == TourneyStatus::Drafted,
            Self::ReopenSignups => matches!(
                status,
                TourneyStatus::Signup | TourneyStatus::Draft | TourneyStatus::Drafted
            ),
        }
    }
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
    SubmittingReport {
        match_id: String,
    },
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
    SavingPool,
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

    /// The one match a write is in flight against, if the pending write names
    /// one at all.
    ///
    /// Only the three reporting actions do; every other write is event-wide.
    /// Answered as the single id rather than tested per match because that is
    /// what a bracket needs: it reads this once and compares, instead of asking
    /// the same question of every match it draws.
    pub fn busy_match_id(&self) -> Option<&str> {
        match &self.pending {
            Some(
                TourneyAction::SubmittingReport { match_id }
                | TourneyAction::AnsweringReport { match_id }
                | TourneyAction::DecidingReport { match_id },
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
    /// Reload the open event.
    #[serde(rename_all = "camelCase")]
    LoadDetail {
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
    /// Report a series as one of its players.
    #[serde(rename_all = "camelCase")]
    SubmitReport {
        tournament_id: String,
        report: MatchReport,
    },
    /// Agree with, or refuse, the score the opponent submitted.
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
    #[serde(rename_all = "camelCase")]
    SavePool {
        tournament_id: String,
        pool: PoolDraft,
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
                },
                TourneyMap {
                    id: "m2".into(),
                    name: "Astro".into(),
                    image_url: String::new(),
                },
            ],
            map_pools: vec![MapPool {
                id: "pool1".into(),
                name: "Round 1".into(),
                map_ids: vec!["m2".into(), "m1".into()],
                sequence: vec![],
                best_of: Some(3),
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
                    }],
                },
                TourneyEvent::RoomOpened {
                    room_id: "global".into(),
                },
                TourneyEvent::ChatLoaded {
                    room_id: "global".into(),
                    posts: vec![ChatPost {
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
                        },
                        ChatRoom {
                            id: "m1".into(),
                            name: "Nuggets vs Ada".into(),
                            unread: 1,
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

    #[test]
    fn one_matchs_spinner_does_not_disable_the_rest_of_the_bracket() {
        let mut state = TourneyState::default();
        reduce(
            &mut state,
            &TourneyEvent::ActionStarted {
                action: TourneyAction::SubmittingReport {
                    match_id: "m1".into(),
                },
            },
        );
        assert!(state.is_busy_with("m1"));
        assert!(!state.is_busy_with("m2"));

        reduce(
            &mut state,
            &TourneyEvent::ActionSucceeded {
                action: TourneyAction::SubmittingReport {
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
