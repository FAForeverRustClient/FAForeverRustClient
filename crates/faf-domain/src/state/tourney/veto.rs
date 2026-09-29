//! Map vetoes: the turn order, the choices, and what the two sides may do.

use super::*;

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
///
/// All four fields travel together: the service rebuilds the whole object
/// from what it is sent (`cleanVeto`), so a key left out is not left alone
/// but reset to its default.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VetoConfig {
    pub enabled: bool,
    pub mode: VetoMode,
    /// Who acts first in each match (`abMode`).
    pub team_a: VetoTeamA,
    /// Whether a secret map is revealed when it is banned (`revealBans`).
    /// Off by default: banning blind is the point of secret maps. A secret map
    /// is always revealed when it is picked or left as the decider.
    pub reveal_bans: bool,
}

/// How Team A, the side that acts first, is chosen for each match.
///
/// Rated by the team's combined rating, the same number the Teams tab shows.
/// Whatever the rule, an organiser can still set the sides of any match by
/// hand before its veto starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum VetoTeamA {
    /// The lower rated side acts first. The service's default.
    #[default]
    LowerA,
    /// The higher rated side acts first.
    LowerB,
    Random,
    /// Nobody until the organiser says, match by match.
    Manual,
}

impl VetoTeamA {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::LowerA => "lowerA",
            Self::LowerB => "lowerB",
            Self::Random => "random",
            Self::Manual => "manual",
        }
    }

    pub fn from_wire(raw: &str) -> Self {
        match raw.trim() {
            "lowerB" => Self::LowerB,
            "random" => Self::Random,
            "manual" => Self::Manual,
            _ => Self::LowerA,
        }
    }
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
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Upfront => "upfront",
            Self::Continuous => "continuous",
        }
    }

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

/// One of the four factions a faction veto bans and picks from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TourneyFaction {
    Uef,
    Aeon,
    Cybran,
    Seraphim,
}

impl TourneyFaction {
    /// In the order the website offers them.
    pub const ALL: [Self; 4] = [Self::Uef, Self::Aeon, Self::Cybran, Self::Seraphim];

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Uef => "uef",
            Self::Aeon => "aeon",
            Self::Cybran => "cybran",
            Self::Seraphim => "seraphim",
        }
    }

    /// `None` for anything the service would refuse as "Unknown faction".
    pub fn from_wire(raw: &str) -> Option<Self> {
        let raw = raw.trim().to_ascii_lowercase();
        Self::ALL
            .into_iter()
            .find(|faction| faction.as_wire() == raw)
    }
}

/// Whether an event runs faction vetoes, and how many bans and picks each
/// player makes per game (`fveto`).
///
/// A 1v1 feature: the service refuses it for teams and for free-for-all, see
/// [`Tourney::faction_veto_on`]. Picks always outnumber bans, so an opponent
/// can never ban every faction a player named.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FactionVetoConfig {
    pub enabled: bool,
    pub bans: i32,
    pub picks: i32,
}

impl Default for FactionVetoConfig {
    /// Off, with the website's own starting numbers for when it is turned on.
    fn default() -> Self {
        Self {
            enabled: false,
            bans: 1,
            picks: 2,
        }
    }
}

impl FactionVetoConfig {
    /// Whether `fveto_config` will take it: one or two bans, and when enabled,
    /// more picks than bans and at most three.
    pub fn is_submittable(&self) -> bool {
        (1..=2).contains(&self.bans)
            && (!self.enabled || (self.picks > self.bans && self.picks <= 3))
    }
}

/// One match's faction veto, as this account may see it.
///
/// The choices are secret: the service sends a competitor their own bans and
/// picks, and everybody else, organisers included, only which side is done,
/// until both are and the result exists. Nothing here is worked out
/// client-side for the same reason.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MatchFactionVeto {
    pub bans: i32,
    pub picks: i32,
    /// One per game of the series, in game order.
    pub games: Vec<FactionVetoGame>,
}

impl MatchFactionVeto {
    /// How many games still wait on this account's choices.
    ///
    /// Zero for anybody who is not one of the two players, because only they
    /// are sent a `next` step.
    pub fn games_owed(&self) -> i32 {
        self.games.iter().filter(|game| game.next.is_some()).count() as i32
    }

    /// Whether every game has its factions.
    pub fn is_settled(&self) -> bool {
        !self.games.is_empty() && self.games.iter().all(|game| game.result.is_some())
    }
}

/// One game's faction veto.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FactionVetoGame {
    /// Which game of the series, from 1.
    pub game: i32,
    pub team1_done: bool,
    pub team2_done: bool,
    /// The factions played, once both sides are done.
    pub result: Option<FactionResult>,
    /// This account's own choices so far. Sent to the two players only.
    pub mine: Option<FactionChoices>,
    /// What this account owes next, or `None` when it owes nothing.
    pub next: Option<FactionStep>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FactionResult {
    pub team1: TourneyFaction,
    pub team2: TourneyFaction,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FactionChoices {
    pub bans: Vec<TourneyFaction>,
    /// In order of preference: the first the opponent did not ban is played.
    pub picks: Vec<TourneyFaction>,
    pub done: bool,
}

/// The choice that is due: "ban, the 1st of 1", "pick, the 2nd of 3".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FactionStep {
    pub action: PoolAction,
    pub index: i32,
    pub of: i32,
}
