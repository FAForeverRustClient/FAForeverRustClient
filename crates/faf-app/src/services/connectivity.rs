//! The connectivity check, and the live relay view.
//!
//! The check runs its questions in the order a person debugging a failed
//! join would ask them, and reports each as a line the moment it is answered:
//!
//! 1. **Which adapter, and can it start.** The joining and hosting choices
//!    (and the development override, which wins over both), then what each
//!    adapter they can start needs on disk: the Java runtime and its version
//!    against the one the adapter's jar was compiled for, the jar, the Pioneer
//!    executable. An adapter no choice can start is not checked at all.
//! 2. **Does the API hand out relays.** `GET /ice/server`, the API's list of
//!    active relays.
//! 3. **Does each relay answer from here.** The relay URLs of the last game
//!    this client started (see `infra::connectivity` for why there is no
//!    other source), each asked at once: a STUN binding over UDP, a TCP
//!    connection otherwise. A summary line says how many answered, and names
//!    the pattern a firewall that drops UDP leaves.
//! 4. **What did the adapter say.** The end of its newest log.
//!
//! The verdict is the worst line. The live relay view is one call to the
//! running adapter, asked on a timer by the settings page.

use faf_domain::protocol::stun::{parse_ice_url, IceTransport};
use faf_domain::state::connectivity::verdict;
use faf_domain::state::{
    CheckFinding, CheckOutcome, CheckStep, ConnectivityCommand, ConnectivityEvent, IceAdapter,
};
use futures_util::future::join_all;

use crate::ports::{KnownRelayAddresses, ProbeAnswer, RelayListError};
use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: ConnectivityCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        ConnectivityCommand::RunCheck => run_check(ctx, out).await,
        ConnectivityCommand::RefreshRelayStatus => refresh_relay_status(ctx, out).await,
    }
}

/// Whether an adapter matters to the games this client will start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Need {
    /// A choice starts it for every game it covers: missing is a failure.
    Required,
    /// Only Dynamic starts it, and only for a lobby whose host is on it:
    /// missing is a warning.
    Optional,
    /// No choice starts it, so it is not checked.
    Unused,
}

impl Need {
    fn missing(self) -> CheckOutcome {
        match self {
            Need::Required => CheckOutcome::Fail,
            Need::Optional | Need::Unused => CheckOutcome::Warn,
        }
    }
}

/// What the joining and hosting choices can start, the way `SelectableIce`
/// picks: the override decides alone; hosting is Java unless it is Go; and
/// joining on Dynamic is Java for every lobby but a marked one.
fn needs(join: IceAdapter, host: IceAdapter, forced: Option<IceAdapter>) -> (Need, Need) {
    match forced {
        Some(IceAdapter::Go) => return (Need::Unused, Need::Required),
        Some(_) => return (Need::Required, Need::Unused),
        None => {}
    }
    let host_on_go = host == IceAdapter::Go;
    let java = if join != IceAdapter::Go || !host_on_go {
        Need::Required
    } else {
        Need::Unused
    };
    let go = if join == IceAdapter::Go || host_on_go {
        Need::Required
    } else if join == IceAdapter::Dynamic {
        Need::Optional
    } else {
        Need::Unused
    };
    (java, go)
}

/// The lines of one run: each is emitted as it is reported, and the last
/// version of each is kept for the verdict.
struct Report<'a> {
    out: &'a EventSink,
    steps: Vec<CheckStep>,
}

impl Report<'_> {
    fn line(&mut self, id: impl Into<String>, outcome: CheckOutcome, finding: CheckFinding) {
        let step = CheckStep {
            id: id.into(),
            outcome,
            finding,
        };
        match self.steps.iter_mut().find(|held| held.id == step.id) {
            Some(held) => *held = step.clone(),
            None => self.steps.push(step.clone()),
        }
        self.out.emit(ConnectivityEvent::StepReported { step });
    }
}

async fn run_check(ctx: &ServiceCtx, out: &EventSink) {
    out.emit(ConnectivityEvent::CheckStarted {
        started_at: chrono::Utc::now().to_rfc3339(),
    });
    let mut report = Report {
        out,
        steps: Vec::new(),
    };
    let port = &ctx.ports.connectivity;

    // 1. The adapters.
    let (join, host) = out.with_state(|state| {
        let preferences = state.settings.connectivity;
        (preferences.adapter, preferences.host_adapter)
    });
    let inventory = port.adapter_inventory().await;
    report.line(
        "selection",
        CheckOutcome::Info,
        CheckFinding::AdapterSelection {
            join,
            host,
            forced: inventory.forced,
        },
    );
    let (java, go) = needs(join, host, inventory.forced);
    if java != Need::Unused {
        let required = inventory
            .java_adapter
            .as_ref()
            .and_then(|jar| jar.required_java);
        match inventory.java_runtime {
            Ok(runtime) => match (runtime.major, required, runtime.version) {
                (Some(major), Some(required), Some(version)) if major < required => report.line(
                    "javaRuntime",
                    CheckOutcome::Fail,
                    CheckFinding::JavaRuntimeTooOld {
                        path: runtime.path,
                        version,
                        required,
                    },
                ),
                (_, _, version) => report.line(
                    "javaRuntime",
                    CheckOutcome::Pass,
                    CheckFinding::JavaRuntime {
                        path: runtime.path,
                        version,
                    },
                ),
            },
            Err(problem) => report.line(
                "javaRuntime",
                java.missing(),
                CheckFinding::JavaRuntimeMissing {
                    path: problem.path,
                    reason: problem.reason,
                },
            ),
        }
        match inventory.java_adapter {
            Some(jar) => report.line(
                "javaAdapter",
                CheckOutcome::Pass,
                CheckFinding::JavaAdapter { path: jar.path },
            ),
            None => report.line(
                "javaAdapter",
                java.missing(),
                CheckFinding::JavaAdapterMissing,
            ),
        }
    }
    if go != Need::Unused {
        match inventory.pioneer {
            Some(path) => report.line(
                "pioneerAdapter",
                CheckOutcome::Pass,
                CheckFinding::PioneerAdapter { path },
            ),
            None => report.line(
                "pioneerAdapter",
                go.missing(),
                CheckFinding::PioneerAdapterMissing {
                    required: go == Need::Required,
                },
            ),
        }
    }

    // 2. The API's relay list. A warning rather than a failure when it cannot
    // be had: the list names relays, it does not carry a game, and a game's
    // own session can still work without it.
    match port.relay_list().await {
        Ok(servers) => {
            let mut regions: Vec<String> = Vec::new();
            for server in &servers {
                let region = server.region.trim();
                if !region.is_empty() && !regions.iter().any(|held| held == region) {
                    regions.push(region.to_string());
                }
            }
            let outcome = if servers.is_empty() {
                CheckOutcome::Warn
            } else {
                CheckOutcome::Pass
            };
            report.line(
                "relayList",
                outcome,
                CheckFinding::RelayList {
                    count: count(servers.len()),
                    regions,
                },
            );
        }
        Err(RelayListError::NeedsSignIn) => report.line(
            "relayList",
            CheckOutcome::Warn,
            CheckFinding::RelayListNeedsSignIn,
        ),
        Err(RelayListError::Unavailable(reason)) => report.line(
            "relayList",
            CheckOutcome::Warn,
            CheckFinding::RelayListUnavailable { reason },
        ),
    }

    // 3. Each relay.
    match port.relay_addresses().await {
        KnownRelayAddresses::None => report.line(
            "relayAddresses",
            CheckOutcome::Warn,
            CheckFinding::NoRelayAddresses,
        ),
        KnownRelayAddresses::Unavailable { game_id, reason } => report.line(
            "relayAddresses",
            CheckOutcome::Warn,
            CheckFinding::RelayAddressesUnavailable { game_id, reason },
        ),
        KnownRelayAddresses::Known(addresses) => {
            let outcome = if addresses.urls.is_empty() {
                CheckOutcome::Warn
            } else {
                CheckOutcome::Info
            };
            report.line(
                "relayAddresses",
                outcome,
                CheckFinding::RelayAddresses {
                    game_id: addresses.game_id,
                    count: count(addresses.urls.len()),
                },
            );
            probe_relays(ctx, &mut report, addresses.urls).await;
        }
    }

    // 4. The adapter's own words.
    match port.adapter_log().await {
        Some(log) => report.line(
            "adapterLog",
            CheckOutcome::Info,
            CheckFinding::AdapterLog {
                file_name: log.file_name,
                modified_at: log.modified_at,
                tail: log.tail,
                truncated: log.truncated,
            },
        ),
        None => report.line("adapterLog", CheckOutcome::Info, CheckFinding::NoAdapterLog),
    }

    out.emit(ConnectivityEvent::CheckFinished {
        verdict: verdict(&report.steps),
    });
}

/// Ask every relay URL at once, report each as it answers, then the summary.
async fn probe_relays(ctx: &ServiceCtx, report: &mut Report<'_>, urls: Vec<String>) {
    let mut probes = Vec::new();
    for (index, url) in urls.into_iter().enumerate() {
        let id = format!("server:{index}");
        match parse_ice_url(&url) {
            Some(parsed) => {
                report.line(
                    id.clone(),
                    CheckOutcome::Running,
                    CheckFinding::ServerProbing {
                        url: url.clone(),
                        transport: parsed.transport,
                    },
                );
                probes.push((id, url, parsed));
            }
            None => report.line(
                id,
                CheckOutcome::Warn,
                CheckFinding::ServerUnreadable { url },
            ),
        }
    }
    if probes.is_empty() {
        return;
    }

    // Each probe reports its own line as it finishes, so a slow relay does
    // not hold up the lines of the ones that answered.
    let out = report.out;
    let answers = join_all(probes.into_iter().map(|(id, url, parsed)| async move {
        let transport = parsed.transport;
        let (outcome, finding) = match ctx.ports.connectivity.probe(&parsed).await {
            Ok(ProbeAnswer::Binding {
                round_trip_ms,
                public_address,
            }) => (
                CheckOutcome::Pass,
                CheckFinding::ServerReachable {
                    url,
                    transport,
                    round_trip_ms,
                    public_address: public_address.map(|address| address.to_string()),
                },
            ),
            Ok(ProbeAnswer::Connected { round_trip_ms }) => (
                CheckOutcome::Pass,
                CheckFinding::ServerReachable {
                    url,
                    transport,
                    round_trip_ms,
                    public_address: None,
                },
            ),
            // A warning on its own line: one relay that does not answer is
            // one relay, and games still connect through the others. The
            // summary below fails when none answered.
            Err(failure) => (
                CheckOutcome::Warn,
                CheckFinding::ServerUnreachable {
                    url,
                    transport,
                    failure,
                },
            ),
        };
        let step = CheckStep {
            id,
            outcome,
            finding,
        };
        out.emit(ConnectivityEvent::StepReported { step: step.clone() });
        (transport, step)
    }))
    .await;

    let total = answers.len();
    let answered = |udp: Option<bool>| {
        answers
            .iter()
            .filter(|(transport, step)| {
                step.outcome == CheckOutcome::Pass
                    && udp.is_none_or(|udp| (*transport == IceTransport::Udp) == udp)
            })
            .count()
    };
    let udp_total = answers
        .iter()
        .filter(|(transport, _)| *transport == IceTransport::Udp)
        .count();
    let all_answered = answered(None);
    let udp_blocked = udp_total > 0 && answered(Some(true)) == 0 && answered(Some(false)) > 0;
    for (_, step) in answers {
        match report.steps.iter_mut().find(|held| held.id == step.id) {
            Some(held) => *held = step,
            None => report.steps.push(step),
        }
    }
    let outcome = if all_answered == total {
        CheckOutcome::Pass
    } else if all_answered == 0 {
        CheckOutcome::Fail
    } else {
        CheckOutcome::Warn
    };
    report.line(
        "reachability",
        outcome,
        CheckFinding::Reachability {
            answered: count(all_answered),
            total: count(total),
            udp_blocked,
        },
    );
}

fn count(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// Ask the running adapter for its peers, and say so only when the answer
/// changed: the page asks every couple of seconds, and an unchanged table is
/// not news.
async fn refresh_relay_status(ctx: &ServiceCtx, out: &EventSink) {
    let status = ctx.ports.ice.relay_status().await;
    if out.with_state(|state| state.connectivity.relay == status) {
        return;
    }
    out.emit(ConnectivityEvent::RelayStatusUpdated { status });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dynamic_needs_java_and_may_need_pioneer() {
        assert_eq!(
            needs(IceAdapter::Dynamic, IceAdapter::Java, None),
            (Need::Required, Need::Optional)
        );
    }

    #[test]
    fn an_explicit_choice_needs_only_what_it_starts() {
        assert_eq!(
            needs(IceAdapter::Java, IceAdapter::Java, None),
            (Need::Required, Need::Unused)
        );
        assert_eq!(
            needs(IceAdapter::Go, IceAdapter::Go, None),
            (Need::Unused, Need::Required)
        );
        // Joining on Go, hosting on Java: both start games.
        assert_eq!(
            needs(IceAdapter::Go, IceAdapter::Java, None),
            (Need::Required, Need::Required)
        );
    }

    #[test]
    fn the_override_decides_alone() {
        assert_eq!(
            needs(IceAdapter::Dynamic, IceAdapter::Go, Some(IceAdapter::Java)),
            (Need::Required, Need::Unused)
        );
        assert_eq!(
            needs(IceAdapter::Java, IceAdapter::Java, Some(IceAdapter::Go)),
            (Need::Unused, Need::Required)
        );
    }
}
