//! Connectivity slice: the connectivity check, and the running adapter's own
//! view of its peers.
//!
//! A failed join used to leave two places to look: the launch error, which
//! says the adapter could not start or the game never connected, and the log
//! viewer, which says why only to somebody who can read an ICE adapter log.
//! Neither answers the question a player is actually asking before a game,
//! "can this machine reach FAF's relays at all". The check answers it line by
//! line: which adapter starts the next game and whether it can, whether the
//! FAF API hands out relays, whether each relay answers from this network, and
//! what the adapter last wrote.
//!
//! Each line is a [`CheckStep`]: an outcome the service decided and a
//! [`CheckFinding`] saying what was found, as data rather than as a sentence,
//! so the frontend phrases it in the reader's language. Lines arrive one by
//! one as the check gets to them, and a line reported again (a relay first
//! "being asked", then "answered") replaces itself by its id.
//!
//! The live half is [`RelayStatus`]: what the Java adapter says about each
//! peer while a game runs, refreshed while somebody is looking at it.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::protocol::stun::IceTransport;
use crate::state::IceAdapter;

/// How one line of the check came out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CheckOutcome {
    /// Still being found out.
    #[default]
    Running,
    /// A fact worth a line, neither good nor bad: which adapter is selected,
    /// where the addresses came from.
    Info,
    Pass,
    /// Works, but not everywhere or not for everything.
    Warn,
    Fail,
}

impl CheckOutcome {
    /// Worse is greater. Running and info lines judge nothing.
    fn severity(self) -> u8 {
        match self {
            CheckOutcome::Running | CheckOutcome::Info => 0,
            CheckOutcome::Pass => 1,
            CheckOutcome::Warn => 2,
            CheckOutcome::Fail => 3,
        }
    }
}

/// The check's verdict: the worst judged line, or a pass when every line was
/// informational.
pub fn verdict(steps: &[CheckStep]) -> CheckOutcome {
    steps
        .iter()
        .map(|step| step.outcome)
        .filter(|outcome| outcome.severity() > 0)
        .max_by_key(|outcome| outcome.severity())
        .unwrap_or(CheckOutcome::Pass)
}

/// Why a relay did not answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProbeFailure {
    /// Nothing came back in the time allowed. On UDP this is what a firewall
    /// dropping the traffic looks like.
    Timeout { waited_ms: u32 },
    /// The relay's name does not resolve.
    UnknownHost,
    /// The relay's TCP port refused the connection.
    Refused,
    /// Something answered, but not with a STUN success.
    BadAnswer { reason: String },
    /// Anything else the operating system reported, as it reported it.
    Network { reason: String },
}

/// What one line of the check found.
///
/// Data rather than a sentence, so the frontend phrases it in the reader's
/// language; reasons that come from the operating system or a server stay as
/// the text they arrived as.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CheckFinding {
    /// The adapters games start on: joining, hosting, and the development
    /// override (`FAF_ICE_ADAPTER_KIND`) when one is set, since it wins over
    /// both preferences.
    AdapterSelection {
        join: IceAdapter,
        host: IceAdapter,
        forced: Option<IceAdapter>,
    },
    /// The Java runtime the Java adapter is started with, and the version it
    /// reported. `version` is `None` when it ran but said nothing readable.
    JavaRuntime {
        path: String,
        version: Option<String>,
    },
    /// A runtime that is older than the adapter's class files require.
    JavaRuntimeTooOld {
        path: String,
        version: String,
        required: u32,
    },
    /// No runtime could be started.
    JavaRuntimeMissing {
        path: String,
        reason: String,
    },
    /// The Java adapter's jar.
    JavaAdapter {
        path: String,
    },
    JavaAdapterMissing,
    /// The Pioneer (Go) adapter's executable.
    PioneerAdapter {
        path: String,
    },
    /// `required` when a selected adapter is Pioneer; otherwise only Dynamic
    /// would start it, and only for a lobby whose host is on Pioneer.
    PioneerAdapterMissing {
        required: bool,
    },
    /// `GET /ice/server`: the relays the FAF API says are active, and where.
    RelayList {
        count: u32,
        regions: Vec<String>,
    },
    /// The relay list needs a FAF sign-in.
    RelayListNeedsSignIn,
    RelayListUnavailable {
        reason: String,
    },
    /// The addresses tested below, and the game whose relay session they came
    /// from: the API hands relay addresses out per game only.
    RelayAddresses {
        game_id: i32,
        count: u32,
    },
    /// No game has been started this session, so there are no addresses to
    /// test. Said as a line of its own because it is a limit of the check,
    /// not a fault of the network.
    NoRelayAddresses,
    /// The session of the last game could not be fetched again.
    RelayAddressesUnavailable {
        game_id: i32,
        reason: String,
    },
    /// One relay URL, being asked.
    ServerProbing {
        url: String,
        transport: IceTransport,
    },
    /// One relay URL that answered: a STUN binding over UDP, or an accepted
    /// TCP connection. `public_address` is where the relay saw the request
    /// come from, which only a STUN answer says.
    ServerReachable {
        url: String,
        transport: IceTransport,
        round_trip_ms: u32,
        public_address: Option<String>,
    },
    ServerUnreachable {
        url: String,
        transport: IceTransport,
        failure: ProbeFailure,
    },
    /// A URL the check cannot read, so it was not asked.
    ServerUnreadable {
        url: String,
    },
    /// How many of the relay URLs answered. `udp_blocked` is the pattern a
    /// firewall that drops UDP leaves: no UDP probe answered while a TCP one
    /// did. Games need UDP, so it is worth naming.
    Reachability {
        answered: u32,
        total: u32,
        udp_blocked: bool,
    },
    /// The tail of the newest adapter log. `modified_at` is RFC 3339.
    AdapterLog {
        file_name: String,
        modified_at: String,
        tail: String,
        truncated: bool,
    },
    NoAdapterLog,
}

/// One line of the check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckStep {
    /// Stable within one run, so a line reported again replaces itself.
    pub id: String,
    pub outcome: CheckOutcome,
    pub finding: CheckFinding,
}

/// Where the check is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum CheckStatus {
    #[default]
    Idle,
    Running,
    /// Done, with the worst outcome among its lines.
    Finished {
        verdict: CheckOutcome,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectivityCheck {
    pub status: CheckStatus,
    /// The lines of the current or last run, in the order they were reached.
    pub steps: Vec<CheckStep>,
    /// When the current or last run started, RFC 3339. Empty before the first.
    pub started_at: String,
}

/// One peer the Java adapter is connecting to or connected with.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RelayPeer {
    pub player_id: i32,
    pub login: String,
    /// The adapter's own word for the ICE state: `new`, `gathering`,
    /// `awaitingCandidates`, `checking`, `connected`, `completed`,
    /// `disconnected`.
    pub state: String,
    pub connected: bool,
    /// The candidate types the pair settled on (`host`, `srflx`, `prflx`,
    /// `relay`), empty until it has. `relay` on either side means the traffic
    /// goes through a FAF relay rather than directly.
    pub local_candidate: String,
    pub remote_candidate: String,
}

/// The Java adapter's answer to its `status` call.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RelaySnapshot {
    pub adapter_version: String,
    /// The game's GPGNet state as the adapter last heard it: `Idle`,
    /// `Lobby`, `Launching`, `Ended`.
    pub game_state: String,
    /// Whether the game is connected to the adapter's GPGNet port.
    pub game_connected: bool,
    pub peers: Vec<RelayPeer>,
}

/// The running adapter's view of its peers.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum RelayStatus {
    /// No adapter is running, or nobody has asked yet.
    #[default]
    Idle,
    /// The running adapter has no status call. Pioneer has none.
    Unsupported {
        adapter: IceAdapter,
    },
    /// The adapter did not answer its status call.
    Unavailable {
        reason: String,
    },
    Live {
        snapshot: RelaySnapshot,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectivityState {
    pub check: ConnectivityCheck,
    pub relay: RelayStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ConnectivityEvent {
    /// A run began: the previous run's lines are dropped.
    CheckStarted {
        started_at: String,
    },
    /// One line, new or replacing the line with the same id.
    StepReported {
        step: CheckStep,
    },
    CheckFinished {
        verdict: CheckOutcome,
    },
    RelayStatusUpdated {
        status: RelayStatus,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ConnectivityCommand {
    /// Run the whole check. Single-flight: a second press while one runs is
    /// dropped, since it would only ask the same relays again.
    RunCheck,
    /// Ask the running adapter for its peers once. Sent on a timer by the
    /// Connectivity settings page while a game runs and the page is open.
    RefreshRelayStatus,
}

pub fn reduce(state: &mut ConnectivityState, event: &ConnectivityEvent) {
    match event {
        ConnectivityEvent::CheckStarted { started_at } => {
            state.check = ConnectivityCheck {
                status: CheckStatus::Running,
                steps: Vec::new(),
                started_at: started_at.clone(),
            };
        }
        // A line belongs to a run. One arriving outside a run has nothing to
        // be a line of, and appending it would mix it into the last result.
        ConnectivityEvent::StepReported { step } => {
            if state.check.status != CheckStatus::Running {
                return;
            }
            match state.check.steps.iter_mut().find(|held| held.id == step.id) {
                Some(held) => *held = step.clone(),
                None => state.check.steps.push(step.clone()),
            }
        }
        ConnectivityEvent::CheckFinished { verdict } => {
            if state.check.status == CheckStatus::Running {
                state.check.status = CheckStatus::Finished { verdict: *verdict };
            }
        }
        ConnectivityEvent::RelayStatusUpdated { status } => state.relay = status.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(id: &str, outcome: CheckOutcome) -> CheckStep {
        CheckStep {
            id: id.into(),
            outcome,
            finding: CheckFinding::JavaAdapterMissing,
        }
    }

    fn started() -> ConnectivityState {
        let mut state = ConnectivityState::default();
        reduce(
            &mut state,
            &ConnectivityEvent::CheckStarted {
                started_at: "2026-10-08T18:00:00Z".into(),
            },
        );
        state
    }

    #[test]
    fn a_run_starts_empty_and_collects_its_lines_in_order() {
        let mut state = started();
        assert_eq!(state.check.status, CheckStatus::Running);
        assert_eq!(state.check.started_at, "2026-10-08T18:00:00Z");
        for id in ["selection", "javaRuntime"] {
            reduce(
                &mut state,
                &ConnectivityEvent::StepReported {
                    step: step(id, CheckOutcome::Pass),
                },
            );
        }
        let ids: Vec<&str> = state.check.steps.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["selection", "javaRuntime"]);
    }

    #[test]
    fn a_line_reported_again_replaces_itself_in_place() {
        let mut state = started();
        for reported in [
            step("server:0", CheckOutcome::Running),
            step("server:1", CheckOutcome::Running),
            step("server:0", CheckOutcome::Fail),
        ] {
            reduce(
                &mut state,
                &ConnectivityEvent::StepReported { step: reported },
            );
        }
        assert_eq!(state.check.steps.len(), 2);
        assert_eq!(state.check.steps[0].outcome, CheckOutcome::Fail);
        assert_eq!(state.check.steps[0].id, "server:0", "kept its place");
    }

    #[test]
    fn a_new_run_drops_the_last_runs_lines() {
        let mut state = started();
        reduce(
            &mut state,
            &ConnectivityEvent::StepReported {
                step: step("selection", CheckOutcome::Info),
            },
        );
        reduce(
            &mut state,
            &ConnectivityEvent::CheckFinished {
                verdict: CheckOutcome::Pass,
            },
        );
        reduce(
            &mut state,
            &ConnectivityEvent::CheckStarted {
                started_at: "2026-10-08T18:05:00Z".into(),
            },
        );
        assert!(state.check.steps.is_empty());
        assert_eq!(state.check.status, CheckStatus::Running);
    }

    #[test]
    fn lines_and_verdicts_outside_a_run_are_ignored() {
        let mut state = ConnectivityState::default();
        reduce(
            &mut state,
            &ConnectivityEvent::StepReported {
                step: step("selection", CheckOutcome::Info),
            },
        );
        reduce(
            &mut state,
            &ConnectivityEvent::CheckFinished {
                verdict: CheckOutcome::Fail,
            },
        );
        assert_eq!(state, ConnectivityState::default());

        let mut state = started();
        reduce(
            &mut state,
            &ConnectivityEvent::CheckFinished {
                verdict: CheckOutcome::Warn,
            },
        );
        let finished = state.clone();
        reduce(
            &mut state,
            &ConnectivityEvent::StepReported {
                step: step("late", CheckOutcome::Fail),
            },
        );
        assert_eq!(state, finished, "a line after the end is not part of it");
    }

    #[test]
    fn the_relay_status_is_replaced_whole() {
        let mut state = ConnectivityState::default();
        reduce(
            &mut state,
            &ConnectivityEvent::RelayStatusUpdated {
                status: RelayStatus::Unsupported {
                    adapter: IceAdapter::Go,
                },
            },
        );
        assert_eq!(
            state.relay,
            RelayStatus::Unsupported {
                adapter: IceAdapter::Go
            }
        );
        reduce(
            &mut state,
            &ConnectivityEvent::RelayStatusUpdated {
                status: RelayStatus::Idle,
            },
        );
        assert_eq!(state.relay, RelayStatus::Idle);
    }

    #[test]
    fn the_verdict_is_the_worst_judged_line() {
        assert_eq!(verdict(&[]), CheckOutcome::Pass);
        assert_eq!(
            verdict(&[step("a", CheckOutcome::Info), step("b", CheckOutcome::Pass)]),
            CheckOutcome::Pass
        );
        assert_eq!(
            verdict(&[
                step("a", CheckOutcome::Warn),
                step("b", CheckOutcome::Pass),
                step("c", CheckOutcome::Info),
            ]),
            CheckOutcome::Warn
        );
        assert_eq!(
            verdict(&[step("a", CheckOutcome::Fail), step("b", CheckOutcome::Warn)]),
            CheckOutcome::Fail
        );
    }
}
