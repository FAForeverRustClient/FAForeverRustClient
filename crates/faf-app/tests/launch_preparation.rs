//! Launch preparation: patching the featured mod and downloading the map
//! before a live game.
//!
//! Drives the whole path the way it really runs: log in, connect, join, and let
//! the fake lobby answer with a `game_launch`. Live launch is enabled through a
//! test double for [`ProcessPort`] so the launcher actually runs, and the
//! updater port is swapped for one that reports whatever the test needs.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakeAuth, FakeLobby};
use faf_app::ports::{
    GameLaunchParams, GamePreparation, GameUpdaterPort, InstallPresence, PreparationStep,
    ProcessPort, UpdateProgress,
};
use faf_app::{App, Ports};
use faf_domain::state::{
    AuthCommand, HostGameConfig, JoinState, LobbyCommand, LobbyEvent, NotificationKind, Player,
};
use faf_domain::AppEvent;
use tokio::sync::mpsc;

/// A process port that claims live launch is available but does nothing. Lets
/// the launcher run end to end without an FA install.
#[derive(Default)]
struct LaunchableProcess {
    launched: Arc<Mutex<bool>>,
    install_dir: Option<PathBuf>,
    /// Fires the "the game exited" signal after this long. `None` keeps the
    /// game running, which is what most of these tests want.
    exits_after: Option<Duration>,
}

#[async_trait]
impl ProcessPort for LaunchableProcess {
    fn supports_live_launch(&self) -> bool {
        true
    }
    async fn launch_game(&self, _params: GameLaunchParams) -> Result<(), String> {
        *self.launched.lock().unwrap() = true;
        Ok(())
    }
    async fn launch_offline(&self, _featured_mod: String, _map: String) -> Result<(), String> {
        Ok(())
    }
    async fn launch_replay(&self, _args: Vec<String>) -> Result<(), String> {
        Ok(())
    }
    fn kill(&self) {}
    async fn wait_for_exit(&self) {
        match self.exits_after {
            Some(delay) => tokio::time::sleep(delay).await,
            None => std::future::pending::<()>().await,
        }
    }
    fn set_paths(&self, _game_path: String, _replay_game_path: String) {}
    fn set_additional_arguments(&self, _arguments: Vec<String>) {}
    fn game_install_dir(&self) -> Option<PathBuf> {
        self.install_dir.clone()
    }

    fn replay_install_dir(&self) -> Option<PathBuf> {
        None
    }
    fn installs_present(&self) -> InstallPresence {
        InstallPresence::default()
    }
}

/// An updater that replays a scripted sequence and records what it was asked
/// to prepare.
struct ScriptedUpdater {
    steps: Vec<String>,
    outcome: Result<(), String>,
    seen: Arc<Mutex<Vec<GamePreparation>>>,
}

#[async_trait]
impl GameUpdaterPort for ScriptedUpdater {
    async fn prepare(&self, request: GamePreparation) -> mpsc::Receiver<UpdateProgress> {
        self.seen.lock().unwrap().push(request);
        let (tx, rx) = mpsc::channel(16);
        for step in &self.steps {
            tx.send(UpdateProgress::Step(PreparationStep::indeterminate(
                step.clone(),
            )))
            .await
            .unwrap();
        }
        tx.send(UpdateProgress::Finished(self.outcome.clone()))
            .await
            .unwrap();
        rx
    }
}

struct Harness {
    app: App,
    prepared: Arc<Mutex<Vec<GamePreparation>>>,
    launched: Arc<Mutex<bool>>,
}

fn harness(steps: &[&str], outcome: Result<(), String>) -> Harness {
    harness_with_install(steps, outcome, Some(PathBuf::from("C:/fake-fa-install")))
}

fn harness_with_install(
    steps: &[&str],
    outcome: Result<(), String>,
    install_dir: Option<PathBuf>,
) -> Harness {
    let prepared = Arc::new(Mutex::new(Vec::new()));
    let launched = Arc::new(Mutex::new(false));
    let ports = Ports {
        auth: Arc::new(FakeAuth {
            player: Player::new(7, "Ada"),
            delay: Duration::ZERO,
            fail_with: None,
        }),
        process: Arc::new(LaunchableProcess {
            launched: launched.clone(),
            install_dir,
            exits_after: None,
        }),
        updater: Arc::new(ScriptedUpdater {
            steps: steps.iter().map(|s| s.to_string()).collect(),
            outcome,
            seen: prepared.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    Harness {
        app,
        prepared,
        launched,
    }
}

/// Log in, connect, join game 1, and collect lobby events until the launch
/// settles one way or the other.
async fn join_and_collect(h: &Harness) -> Vec<LobbyEvent> {
    let mut events = h.app.subscribe();
    h.app
        .dispatch(AuthCommand::Login { remember: false }.into())
        .await
        .unwrap();
    h.app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if matches!(
                events.recv().await,
                Ok(AppEvent::Lobby(LobbyEvent::Connected))
            ) {
                break;
            }
        }
    })
    .await
    .expect("the fake lobby never connected");
    h.app
        .dispatch(
            LobbyCommand::Join {
                id: 1,
                password: None,
            }
            .into(),
        )
        .await
        .unwrap();

    let mut seen = Vec::new();
    let collect = async {
        while let Ok(event) = events.recv().await {
            if let AppEvent::Lobby(lobby) = event {
                let terminal = matches!(
                    lobby,
                    LobbyEvent::InGame
                        | LobbyEvent::JoinFailed { .. }
                        | LobbyEvent::LaunchFailed { .. }
                );
                seen.push(lobby);
                if terminal {
                    break;
                }
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(10), collect)
        .await
        .expect("the launch never settled");
    seen
}

#[tokio::test]
async fn a_game_that_exits_releases_the_join_so_another_can_be_attempted() {
    // The reported failure: after a join that did not work out, the client
    // stayed `InGame` forever because nothing watched the process, so the Play
    // tab refused a second attempt.
    let prepared = Arc::new(Mutex::new(Vec::new()));
    let launched = Arc::new(Mutex::new(false));
    let ports = Ports {
        auth: Arc::new(FakeAuth {
            player: Player::new(7, "Ada"),
            delay: Duration::ZERO,
            fail_with: None,
        }),
        process: Arc::new(LaunchableProcess {
            launched: launched.clone(),
            install_dir: Some(PathBuf::from("C:/faf")),
            exits_after: Some(Duration::from_millis(50)),
        }),
        updater: Arc::new(ScriptedUpdater {
            steps: Vec::new(),
            outcome: Ok(()),
            seen: prepared.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    let h = Harness {
        app,
        prepared,
        launched,
    };

    let events = join_and_collect(&h).await;
    assert!(events.contains(&LobbyEvent::InGame), "the game started");
    assert_eq!(h.app.snapshot().lobby.join, JoinState::InGame);

    // The watcher fires once the process ends.
    for _ in 0..100 {
        if h.app.snapshot().lobby.join == JoinState::Idle {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!(
        "still stuck at {:?} after the game exited",
        h.app.snapshot().lobby.join
    );
}

#[tokio::test]
async fn a_missing_install_fails_before_any_download_or_join() {
    let h = harness_with_install(&["must not run"], Ok(()), None);
    let events = join_and_collect(&h).await;

    assert!(h.prepared.lock().unwrap().is_empty());
    assert!(!*h.launched.lock().unwrap());
    assert!(matches!(
        events.last(),
        Some(LobbyEvent::LaunchFailed { reason })
            if reason.contains("ForgedAlliance.exe") && reason.contains("Settings")
    ));
}

#[tokio::test]
async fn the_install_is_prepared_before_the_game_starts() {
    let h = harness(
        &["Updating faf 3775: units.nx2 (1/2)", "Downloading map…"],
        Ok(()),
    );
    let events = join_and_collect(&h).await;

    let prepared = h.prepared.lock().unwrap().clone();
    assert_eq!(prepared.len(), 1, "one preparation before the join request");
    assert_eq!(prepared[0].featured_mod, "faf");

    let join_phases: Vec<bool> = events
        .iter()
        .filter_map(|event| match event {
            LobbyEvent::Joining { prepared, .. } => Some(*prepared),
            _ => None,
        })
        .collect();
    assert_eq!(
        join_phases,
        [false, true],
        "the authoritative join state must expose when preparation completes"
    );

    // Progress reaches the UI as its own launch phase, in order, and the game
    // only starts afterwards.
    let steps: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            LobbyEvent::Preparing { detail, .. } => Some(detail.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        steps,
        ["Updating faf 3775: units.nx2 (1/2)", "Downloading map…"]
    );

    let last = events.last().expect("at least one event");
    assert!(matches!(last, LobbyEvent::InGame), "got {last:?}");
    assert!(*h.launched.lock().unwrap(), "the game should have started");
    assert_eq!(h.app.snapshot().lobby.join, JoinState::InGame);
}

#[tokio::test]
async fn a_failed_patch_fails_the_launch_instead_of_starting_an_outdated_game() {
    let h = harness(
        &["Updating faf…"],
        Err("could not update faf: 503 Service Unavailable".into()),
    );
    let events = join_and_collect(&h).await;

    match events.last() {
        Some(LobbyEvent::LaunchFailed { reason }) => {
            assert!(reason.contains("503"), "the cause should survive: {reason}");
        }
        other => panic!("expected LaunchFailed, got {other:?}"),
    }
    assert!(
        !*h.launched.lock().unwrap(),
        "the game must not start on an install we could not update"
    );
    assert!(matches!(
        h.app.snapshot().lobby.join,
        JoinState::LaunchFailed { .. }
    ));
    let snapshot = h.app.snapshot();
    assert!(snapshot.notifications.items.iter().any(|notification| {
        notification.kind == NotificationKind::Error
            && notification.title == "Game launch failed"
            && notification.body.contains("503")
    }));
}

#[tokio::test]
async fn a_base_game_map_is_still_handed_to_the_updater() {
    // The fake lobby launches on `Theta Passage`. Deciding that a base map needs no
    // download belongs to the updater (which knows the vault's naming rules),
    // not to the launcher: so the launcher must pass it through rather than
    // filtering it out and silently skipping real vault maps too.
    let h = harness(&[], Ok(()));
    join_and_collect(&h).await;

    let prepared = h.prepared.lock().unwrap().clone();
    assert_eq!(prepared[0].map_folder.as_deref(), Some("Theta Passage"));
}

/// Hosting, with a lobby port whose requests the test can inspect.
fn host_harness(outcome: Result<(), String>) -> (App, FakeLobby, Arc<Mutex<Vec<GamePreparation>>>) {
    let prepared = Arc::new(Mutex::new(Vec::new()));
    let lobby = FakeLobby::default();
    let ports = Ports {
        auth: Arc::new(FakeAuth {
            player: Player::new(7, "Ada"),
            delay: Duration::ZERO,
            fail_with: None,
        }),
        lobby: Arc::new(lobby.clone()),
        process: Arc::new(LaunchableProcess {
            launched: Arc::new(Mutex::new(false)),
            install_dir: Some(PathBuf::from("C:/fake-fa-install")),
            exits_after: None,
        }),
        updater: Arc::new(ScriptedUpdater {
            steps: Vec::new(),
            outcome,
            seen: prepared.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    (app, lobby, prepared)
}

fn host_config(map: &str) -> HostGameConfig {
    HostGameConfig {
        title: "Friday game".into(),
        mod_name: "faf".into(),
        visibility: "public".into(),
        map: map.into(),
        password: None,
        enforce_rating_range: false,
        rating_min: None,
        rating_max: None,
    }
}

async fn wait_for<F: Fn() -> bool>(condition: F) -> bool {
    for _ in 0..200 {
        if condition() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

#[tokio::test]
async fn hosting_downloads_the_map_the_host_chose() {
    // The reported failure: hosting never downloaded the map. The server's
    // `game_launch` names a map only for the matchmaker - a host already told
    // the server which map to use, so the reply carries no `mapname` - and the
    // launch path reads exactly that field. Nothing else asked for the map, so
    // the host arrived in a lobby whose scenario was not on disk.
    let (app, lobby, prepared) = host_harness(Ok(()));

    app.dispatch(
        LobbyCommand::Host {
            config: host_config("adaptive_gadostb.v0002"),
        }
        .into(),
    )
    .await
    .unwrap();

    assert!(
        wait_for(|| !lobby.hosted_configs().is_empty()).await,
        "the host request never reached the lobby"
    );
    let requests = prepared.lock().unwrap().clone();
    assert_eq!(requests.len(), 1, "the map was prepared exactly once");
    assert_eq!(
        requests[0].map_folder.as_deref(),
        Some("adaptive_gadostb.v0002")
    );
    assert_eq!(requests[0].featured_mod, "faf");
}

#[tokio::test]
async fn a_map_that_cannot_be_downloaded_stops_the_host_request() {
    // Better a clear failure than a lobby other players can join and nobody,
    // including its host, can load.
    let (app, lobby, prepared) = host_harness(Err("map archive is not on the CDN".into()));
    let mut events = app.subscribe();

    app.dispatch(
        LobbyCommand::Host {
            config: host_config("adaptive_gadostb.v0002"),
        }
        .into(),
    )
    .await
    .unwrap();

    let failed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(AppEvent::Lobby(LobbyEvent::LaunchFailed { reason })) = events.recv().await {
                return reason;
            }
        }
    })
    .await
    .expect("the host attempt never settled");

    assert!(failed.contains("map archive is not on the CDN"));
    assert!(!prepared.lock().unwrap().is_empty());
    assert!(
        lobby.hosted_configs().is_empty(),
        "no lobby should exist for a map that could not be fetched"
    );
}
