//! The bracket: matches, how they link, what they report, and the plan a
//! format is drawn to. Standings are computed here too, because they are read
//! off the same graph.

use super::*;

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

/// The best-of template an event is created with.
///
/// Not the same thing as [`BracketConfig`], which is the per-round list settled
/// at the draw. This is the shape the organiser fills in *before* there are any
/// rounds to list, and the service expands it into that list when the bracket
/// is built. One variant per bracket type, because the service stores one of
/// three differently shaped objects under the same `plan` key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum MatchPlan {
    #[serde(rename_all = "camelCase")]
    Single {
        early: i32,
        semi: i32,
        final_bo: i32,
    },
    #[serde(rename_all = "camelCase")]
    Double {
        wb: i32,
        wb_final: i32,
        lb: i32,
        lb_final: i32,
        gf: i32,
        /// Whether the winners finalist starts the grand final one game up.
        lb_handicap: bool,
    },
    #[serde(rename_all = "camelCase")]
    Swiss {
        /// 1 or 3; the service accepts nothing else for an ordinary round.
        best_of: i32,
        /// Whether the top two play a final after the last round.
        final_match: bool,
        final_best_of: i32,
        /// Whether a pairing starts as soon as two teams are free.
        fast: bool,
    },
}

impl MatchPlan {
    /// The service's own defaults for a bracket type, mirrored so the create
    /// dialog opens on what would happen anyway rather than on a blank form.
    pub fn default_for(kind: BracketKind) -> Self {
        match kind {
            BracketKind::Single => Self::Single {
                early: 3,
                semi: 3,
                final_bo: 5,
            },
            BracketKind::Double => Self::Double {
                wb: 3,
                wb_final: 3,
                lb: 3,
                lb_final: 3,
                gf: 5,
                lb_handicap: true,
            },
            BracketKind::Swiss => Self::Swiss {
                best_of: 3,
                final_match: true,
                final_best_of: 5,
                fast: false,
            },
        }
    }

    /// The bracket type this plan belongs to, so a changed bracket can swap it.
    pub fn kind(&self) -> BracketKind {
        match self {
            Self::Single { .. } => BracketKind::Single,
            Self::Double { .. } => BracketKind::Double,
            Self::Swiss { .. } => BracketKind::Swiss,
        }
    }
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

/// Rounds needed for a single-elimination bracket of `teams`.
///
/// `ceil(log2(next power of two))`, which is the service's `log2i(nextPow2(n))`
/// written the way Rust spells it.
pub(crate) fn rounds_for(teams: i32) -> i32 {
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
pub(crate) fn round_keys(pairs: &[(BracketSide, i32)]) -> Vec<RoundKey> {
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
