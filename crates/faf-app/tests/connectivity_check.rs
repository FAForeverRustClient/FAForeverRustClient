//! The connectivity check and the live relay view, driven through the real
//! runtime with a scripted port: no socket is opened and no process started.
//!
//! The port answers each question the way a machine in a given state would;
//! what is checked is what the service makes of the answers, line by line and
//! in the verdict.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{
    AdapterInventory, AdapterLogTail, ConnectivityPort, ConnectivitySession, IceParams, IcePort,
    JavaAdapterJar, JavaRuntimeInfo, JavaRuntimeProblem, KnownRelayAddresses, ProbeAnswer,
    RelayAddresses, RelayListError, RelayServer,
};
use faf_app::{App, Ports};
use faf_domain::protocol::stun::{IceTransport, IceUrl};
use faf_domain::state::{
    CheckFinding, CheckOutcome, CheckStatus, CheckStep, ConnectivityCommand, ConnectivityEvent,
    ConnectivityPreferences, IceAdapter, ProbeFailure, RelayPeer, RelaySnapshot, RelayStatus,
    SettingsCommand,
};
use faf_domain::AppEvent;

/// A machine and a network, as the check would find them.
struct Scripted {
    inventory: AdapterInventory,
    relay_list: Result<Vec<RelayServer>, RelayListError>,
    addresses: KnownRelayAddresses,
    /// Hosts that do not answer, and how they fail.
    silent: Vec<(String, ProbeFailure)>,
    log: Option<AdapterLogTail>,
    probes: Arc<AtomicUsize>,
}

impl Default for Scripted {
    fn default() -> Self {
        Self {
            inventory: AdapterInventory {
                forced: None,
                java_runtime: Ok(JavaRuntimeInfo {
                    path: "/opt/jre/bin/java".into(),
                    version: Some("25.0.3".into()),
                    major: Some(25),
                }),
                java_adapter: Some(JavaAdapterJar {
                    path: "/opt/faf/faf-ice-adapter.jar".into(),
                    required_java: Some(21),
                }),
                pioneer: Some("/opt/faf/faf-pioneer".into()),
            },
            relay_list: Ok(vec![
                RelayServer {
                    id: "1".into(),
                    region: "Europe".into(),
                },
                RelayServer {
                    id: "2".into(),
                    region: "Europe".into(),
                },
                RelayServer {
                    id: "3".into(),
                    region: "North America".into(),
                },
            ]),
            addresses: KnownRelayAddresses::Known(RelayAddresses {
                game_id: 4242,
                urls: vec![
                    "stun:eu.relay.example.org".into(),
                    "turn:us.relay.example.org?transport=tcp".into(),
                ],
            }),
            silent: Vec::new(),
            log: Some(AdapterLogTail {
                file_name: "ice-adapter.log".into(),
                modified_at: "2026-10-08T18:00:00+00:00".into(),
                tail: "INFO connected to peer 436001".into(),
                truncated: true,
            }),
            probes: Arc::default(),
        }
    }
}

#[async_trait]
impl ConnectivityPort for Scripted {
    async fn adapter_inventory(&self) -> AdapterInventory {
        self.inventory.clone()
    }

    async fn relay_list(&self) -> Result<Vec<RelayServer>, RelayListError> {
        self.relay_list.clone()
    }

    async fn relay_addresses(&self) -> KnownRelayAddresses {
        self.addresses.clone()
    }

    async fn probe(&self, url: &IceUrl) -> Result<ProbeAnswer, ProbeFailure> {
        self.probes.fetch_add(1, Ordering::SeqCst);
        if let Some((_, failure)) = self.silent.iter().find(|(host, _)| *host == url.host) {
            return Err(failure.clone());
        }
        Ok(match url.transport {
            IceTransport::Udp => ProbeAnswer::Binding {
                round_trip_ms: 23,
                public_address: Some(([203, 0, 113, 7], 51_234).into()),
            },
            IceTransport::Tcp | IceTransport::Tls => ProbeAnswer::Connected { round_trip_ms: 41 },
        })
    }

    async fn adapter_log(&self) -> Option<AdapterLogTail> {
        self.log.clone()
    }
}

fn start(ports: Ports) -> App {
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    app
}

fn with(scripted: Scripted) -> App {
    start(Ports {
        connectivity: Arc::new(scripted),
        ..fake_ports()
    })
}

async fn run(app: &App) -> (CheckStatus, Vec<CheckStep>) {
    app.dispatch_and_wait(ConnectivityCommand::RunCheck.into())
        .await
        .unwrap();
    app.with_state(|state| {
        (
            state.connectivity.check.status,
            state.connectivity.check.steps.clone(),
        )
    })
}

fn line<'a>(steps: &'a [CheckStep], id: &str) -> &'a CheckStep {
    steps
        .iter()
        .find(|step| step.id == id)
        .unwrap_or_else(|| panic!("no `{id}` line in {steps:#?}"))
}

#[tokio::test]
async fn everything_reachable_passes_line_by_line() {
    let app = with(Scripted::default());
    let (status, steps) = run(&app).await;

    let ids: Vec<&str> = steps.iter().map(|step| step.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "selection",
            "javaRuntime",
            "javaAdapter",
            "pioneerAdapter",
            "relayList",
            "relayAddresses",
            "server:0",
            "server:1",
            "reachability",
            "adapterLog",
        ],
        "the order a person debugging a join would ask in"
    );
    assert_eq!(
        status,
        CheckStatus::Finished {
            verdict: CheckOutcome::Pass
        }
    );

    assert_eq!(
        line(&steps, "selection").finding,
        CheckFinding::AdapterSelection {
            join: IceAdapter::Dynamic,
            host: IceAdapter::Java,
            forced: None,
        }
    );
    assert_eq!(
        line(&steps, "relayList").finding,
        CheckFinding::RelayList {
            count: 3,
            regions: vec!["Europe".into(), "North America".into()],
        },
        "each region once"
    );
    assert_eq!(
        line(&steps, "server:0"),
        &CheckStep {
            id: "server:0".into(),
            outcome: CheckOutcome::Pass,
            finding: CheckFinding::ServerReachable {
                url: "stun:eu.relay.example.org".into(),
                transport: IceTransport::Udp,
                round_trip_ms: 23,
                public_address: Some("203.0.113.7:51234".into()),
            },
        }
    );
    assert_eq!(
        line(&steps, "server:1").finding,
        CheckFinding::ServerReachable {
            url: "turn:us.relay.example.org?transport=tcp".into(),
            transport: IceTransport::Tcp,
            round_trip_ms: 41,
            public_address: None,
        }
    );
    assert_eq!(
        line(&steps, "reachability").finding,
        CheckFinding::Reachability {
            answered: 2,
            total: 2,
            udp_blocked: false,
        }
    );
    assert!(matches!(
        line(&steps, "adapterLog").finding,
        CheckFinding::AdapterLog {
            truncated: true,
            ..
        }
    ));
}

#[tokio::test]
async fn each_relay_line_is_shown_as_being_asked_before_it_answers() {
    let app = with(Scripted::default());
    let mut events = app.subscribe();
    app.dispatch_and_wait(ConnectivityCommand::RunCheck.into())
        .await
        .unwrap();

    let mut server_lines = Vec::new();
    while let Ok(event) = events.try_recv() {
        if let AppEvent::Connectivity(ConnectivityEvent::StepReported { step }) = event {
            if step.id == "server:0" {
                server_lines.push(step.outcome);
            }
        }
    }
    assert_eq!(server_lines, [CheckOutcome::Running, CheckOutcome::Pass]);
}

#[tokio::test]
async fn one_unreachable_relay_warns_and_names_the_failure() {
    let probes = Arc::new(AtomicUsize::new(0));
    let app = with(Scripted {
        silent: vec![(
            "us.relay.example.org".into(),
            ProbeFailure::Timeout { waited_ms: 3000 },
        )],
        probes: probes.clone(),
        ..Scripted::default()
    });
    let (status, steps) = run(&app).await;

    assert_eq!(probes.load(Ordering::SeqCst), 2, "every URL was asked");
    assert_eq!(line(&steps, "server:0").outcome, CheckOutcome::Pass);
    assert_eq!(
        line(&steps, "server:1"),
        &CheckStep {
            id: "server:1".into(),
            outcome: CheckOutcome::Warn,
            finding: CheckFinding::ServerUnreachable {
                url: "turn:us.relay.example.org?transport=tcp".into(),
                transport: IceTransport::Tcp,
                failure: ProbeFailure::Timeout { waited_ms: 3000 },
            },
        }
    );
    assert_eq!(line(&steps, "reachability").outcome, CheckOutcome::Warn);
    assert_eq!(
        status,
        CheckStatus::Finished {
            verdict: CheckOutcome::Warn
        }
    );
}

#[tokio::test]
async fn no_relay_answering_fails_and_a_udp_only_silence_is_named() {
    let app = with(Scripted {
        silent: vec![("eu.relay.example.org".into(), ProbeFailure::Refused)],
        ..Scripted::default()
    });
    let (_, steps) = run(&app).await;
    assert_eq!(
        line(&steps, "reachability").finding,
        CheckFinding::Reachability {
            answered: 1,
            total: 2,
            udp_blocked: true,
        },
        "the UDP relay was silent while the TCP one answered"
    );

    let app = with(Scripted {
        silent: vec![
            ("eu.relay.example.org".into(), ProbeFailure::UnknownHost),
            ("us.relay.example.org".into(), ProbeFailure::Refused),
        ],
        ..Scripted::default()
    });
    let (status, steps) = run(&app).await;
    assert_eq!(line(&steps, "reachability").outcome, CheckOutcome::Fail);
    assert_eq!(
        status,
        CheckStatus::Finished {
            verdict: CheckOutcome::Fail
        }
    );
}

#[tokio::test]
async fn an_unavailable_relay_list_and_no_game_yet_are_said_rather_than_passed() {
    let probes = Arc::new(AtomicUsize::new(0));
    let app = with(Scripted {
        relay_list: Err(RelayListError::Unavailable(
            "the API answered 503 Service Unavailable".into(),
        )),
        addresses: KnownRelayAddresses::None,
        log: None,
        probes: probes.clone(),
        ..Scripted::default()
    });
    let (status, steps) = run(&app).await;

    assert_eq!(
        line(&steps, "relayList"),
        &CheckStep {
            id: "relayList".into(),
            outcome: CheckOutcome::Warn,
            finding: CheckFinding::RelayListUnavailable {
                reason: "the API answered 503 Service Unavailable".into(),
            },
        }
    );
    assert_eq!(
        line(&steps, "relayAddresses"),
        &CheckStep {
            id: "relayAddresses".into(),
            outcome: CheckOutcome::Warn,
            finding: CheckFinding::NoRelayAddresses,
        }
    );
    assert_eq!(probes.load(Ordering::SeqCst), 0, "nothing to ask");
    assert!(steps.iter().all(|step| step.id != "reachability"));
    assert_eq!(
        line(&steps, "adapterLog").finding,
        CheckFinding::NoAdapterLog
    );
    assert_eq!(
        status,
        CheckStatus::Finished {
            verdict: CheckOutcome::Warn
        }
    );
}

#[tokio::test]
async fn a_signed_out_client_and_a_refetch_failure_are_their_own_lines() {
    let app = with(Scripted {
        relay_list: Err(RelayListError::NeedsSignIn),
        addresses: KnownRelayAddresses::Unavailable {
            game_id: 77,
            reason: "ice servers returned 404".into(),
        },
        ..Scripted::default()
    });
    let (_, steps) = run(&app).await;
    assert_eq!(
        line(&steps, "relayList").finding,
        CheckFinding::RelayListNeedsSignIn
    );
    assert_eq!(
        line(&steps, "relayAddresses").finding,
        CheckFinding::RelayAddressesUnavailable {
            game_id: 77,
            reason: "ice servers returned 404".into(),
        }
    );
}

#[tokio::test]
async fn an_adapter_the_choices_start_must_be_able_to_start() {
    // Java too old for the jar: a failure, since every Dynamic join needs it.
    let mut scripted = Scripted::default();
    scripted.inventory.java_runtime = Ok(JavaRuntimeInfo {
        path: "/usr/bin/java".into(),
        version: Some("17.0.9".into()),
        major: Some(17),
    });
    // Pioneer absent: only a warning on Dynamic, which starts it for marked
    // lobbies alone.
    scripted.inventory.pioneer = None;
    let app = with(scripted);
    let (status, steps) = run(&app).await;
    assert_eq!(
        line(&steps, "javaRuntime"),
        &CheckStep {
            id: "javaRuntime".into(),
            outcome: CheckOutcome::Fail,
            finding: CheckFinding::JavaRuntimeTooOld {
                path: "/usr/bin/java".into(),
                version: "17.0.9".into(),
                required: 21,
            },
        }
    );
    assert_eq!(
        line(&steps, "pioneerAdapter"),
        &CheckStep {
            id: "pioneerAdapter".into(),
            outcome: CheckOutcome::Warn,
            finding: CheckFinding::PioneerAdapterMissing { required: false },
        }
    );
    assert_eq!(
        status,
        CheckStatus::Finished {
            verdict: CheckOutcome::Fail
        }
    );
}

#[tokio::test]
async fn joining_and_hosting_on_pioneer_checks_only_pioneer() {
    let mut scripted = Scripted::default();
    scripted.inventory.pioneer = None;
    scripted.inventory.java_runtime = Err(JavaRuntimeProblem {
        path: "java".into(),
        reason: "no Java runtime was found there".into(),
    });
    let app = with(scripted);
    app.dispatch_and_wait(
        SettingsCommand::PatchConnectivity {
            patch: ConnectivityPreferences {
                adapter: IceAdapter::Go,
                host_adapter: IceAdapter::Go,
                selection_version: 2,
            }
            .into(),
        }
        .into(),
    )
    .await
    .unwrap();
    let (_, steps) = run(&app).await;

    assert!(
        steps
            .iter()
            .all(|step| step.id != "javaRuntime" && step.id != "javaAdapter"),
        "a missing Java is nothing to fail on when nothing starts it"
    );
    assert_eq!(
        line(&steps, "pioneerAdapter"),
        &CheckStep {
            id: "pioneerAdapter".into(),
            outcome: CheckOutcome::Fail,
            finding: CheckFinding::PioneerAdapterMissing { required: true },
        }
    );
}

/// An adapter that is running and answers its status call with a scripted
/// table, counting how often it was asked.
struct LiveIce {
    status: Mutex<RelayStatus>,
    asked: AtomicUsize,
}

#[async_trait]
impl IcePort for LiveIce {
    async fn start(&self, _params: IceParams) -> Result<ConnectivitySession, String> {
        Err("not used in this test".into())
    }
    fn stop(&self) {}
    async fn relay_status(&self) -> RelayStatus {
        self.asked.fetch_add(1, Ordering::SeqCst);
        self.status.lock().unwrap().clone()
    }
}

#[tokio::test]
async fn the_live_view_shows_the_adapters_peers_and_is_quiet_when_nothing_changed() {
    let live = RelayStatus::Live {
        snapshot: RelaySnapshot {
            adapter_version: "3.3.9".into(),
            game_state: "Lobby".into(),
            game_connected: true,
            peers: vec![RelayPeer {
                player_id: 436001,
                login: "Critren".into(),
                state: "connected".into(),
                connected: true,
                local_candidate: "srflx".into(),
                remote_candidate: "relay".into(),
            }],
        },
    };
    let ice = Arc::new(LiveIce {
        status: Mutex::new(live.clone()),
        asked: AtomicUsize::new(0),
    });
    let app = start(Ports {
        ice: ice.clone(),
        ..fake_ports()
    });
    let mut events = app.subscribe();

    for _ in 0..2 {
        app.dispatch_and_wait(ConnectivityCommand::RefreshRelayStatus.into())
            .await
            .unwrap();
    }
    assert_eq!(
        app.with_state(|state| state.connectivity.relay.clone()),
        live
    );
    assert_eq!(ice.asked.load(Ordering::SeqCst), 2);
    let updates = std::iter::from_fn(|| events.try_recv().ok())
        .filter(|event| {
            matches!(
                event,
                AppEvent::Connectivity(ConnectivityEvent::RelayStatusUpdated { .. })
            )
        })
        .count();
    assert_eq!(updates, 1, "the unchanged second answer is not an event");

    // The game ends: the adapter has nothing to say any more.
    *ice.status.lock().unwrap() = RelayStatus::Idle;
    app.dispatch_and_wait(ConnectivityCommand::RefreshRelayStatus.into())
        .await
        .unwrap();
    assert_eq!(
        app.with_state(|state| state.connectivity.relay.clone()),
        RelayStatus::Idle
    );
}
