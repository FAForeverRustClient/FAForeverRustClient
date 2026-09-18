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
