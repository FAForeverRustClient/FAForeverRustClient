//! Who owns the lobby: joins that outlive their cancel, and the reconnect
//! watchdog's arming.
//!
//! The join test drives the interleaving that revived a cancelled join: join
//! A is called off while its files are still coming down, join B starts, and
//! only then does A's preparation finish. The updater here holds each game's
//! preparation at a gate the test opens, so that order is exact rather than a
//! matter of timing.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakeAuth, FakeLobby};
use faf_app::ports::{
    GameLaunchParams, GamePreparation, GameUpdaterPort, InstallPresence, LobbyPort,
    PreparationPhase, PreparationStep, ProcessPort, UpdateProgress,
};
use faf_app::{App, Ports};
use faf_domain::state::{AuthCommand, LobbyCommand, LobbyEvent, LobbyStatus, Player};
use faf_domain::AppEvent;
use tokio::sync::{broadcast, mpsc, Notify};

/// Claims live launch so the launcher's preparation really runs, without an
/// FA install behind it.
struct LaunchableProcess;

#[async_trait]
impl ProcessPort for LaunchableProcess {
    fn supports_live_launch(&self) -> bool {
        true
    }
    async fn launch_game(&self, _params: GameLaunchParams) -> Result<(), String> {
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
        std::future::pending::<()>().await
    }
    fn set_paths(&self, _game_path: String, _replay_game_path: String) {}
    fn set_additional_arguments(&self, _arguments: Vec<String>) {}
    fn game_install_dir(&self) -> Option<PathBuf> {
        Some(PathBuf::from("C:/faf"))
    }
    fn replay_install_dir(&self) -> Option<PathBuf> {
        None
    }
    fn installs_present(&self) -> InstallPresence {
        InstallPresence::default()
    }
}

/// One gate per map folder. A gate opened before anybody waits on it stays
/// open, which is what `Notify::notify_one` does with its stored permit.
#[derive(Clone, Default)]
struct Gates(Arc<Mutex<HashMap<String, Arc<Notify>>>>);

impl Gates {
    fn gate(&self, map: &str) -> Arc<Notify> {
        self.0
            .lock()
            .unwrap()
            .entry(map.to_string())
            .or_default()
            .clone()
    }

    fn open(&self, map: &str) {
        self.gate(map).notify_one();
    }
}

/// Reports a first step named after the map, waits at the map's gate, then
/// reports two more steps and finishes. Step details say whose preparation
/// they belong to, so the test can tell the two joins' progress apart.
struct GatedUpdater {
    gates: Gates,
}

#[async_trait]
impl GameUpdaterPort for GatedUpdater {
    async fn prepare(&self, request: GamePreparation) -> mpsc::Receiver<UpdateProgress> {
        let map = request.map_folder.unwrap_or_default();
        let gate = self.gates.gate(&map);
        let (tx, rx) = mpsc::channel(1);
        tokio::spawn(async move {
            let step = |index: usize| {
                UpdateProgress::Step(PreparationStep::indeterminate(
                    PreparationPhase::Downloading,
                    format!("{map} {index}"),
                ))
            };
            if tx.send(step(0)).await.is_err() {
                return;
            }
            gate.notified().await;
            for index in 1..3 {
                if tx.send(step(index)).await.is_err() {
                    return;
                }
            }
            let _ = tx.send(UpdateProgress::Finished(Ok(()))).await;
        });
        rx
    }
}

/// Every lobby event seen so far, so assertions can look back over all of it.
struct Log {
    events: broadcast::Receiver<AppEvent>,
    seen: Vec<LobbyEvent>,
}

impl Log {
    /// Record events until one matches, or fail after a generous timeout.
    async fn until(&mut self, what: &str, matches: impl Fn(&LobbyEvent) -> bool) {
        let events = &mut self.events;
        let seen = &mut self.seen;
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match events.recv().await {
                    Ok(AppEvent::Lobby(event)) => {
                        let found = matches(&event);
                        seen.push(event);
                        if found {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => panic!("the app stopped"),
                    _ => {}
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("never saw {what}"));
    }

    /// Record whatever has already arrived.
    fn drain(&mut self) {
        while let Ok(event) = self.events.try_recv() {
            if let AppEvent::Lobby(event) = event {
                self.seen.push(event);
            }
        }
    }
}

fn join(id: i32) -> faf_domain::AppCommand {
    LobbyCommand::Join {
        id,
        password: None,
        replace_mods: false,
    }
    .into()
}

fn is_step(event: &LobbyEvent, prefix: &str) -> bool {
    matches!(event, LobbyEvent::Preparing { detail, .. } if detail.starts_with(prefix))
}

#[tokio::test]
async fn a_join_cancelled_during_preparation_is_not_revived_by_the_next_join() {
    // Seeded games in the fake lobby: 1 is on Theta Passage, 2 on Seton's
    // Clutch, 3 on Open Palms.
    const FIRST_MAP: &str = "Theta Passage";
    const SECOND_MAP: &str = "Seton's Clutch";

    let gates = Gates::default();
    let ports = Ports {
        auth: Arc::new(FakeAuth {
            player: Player::new(7, "Ada"),
            delay: Duration::ZERO,
            fail_with: None,
        }),
        process: Arc::new(LaunchableProcess),
        updater: Arc::new(GatedUpdater {
            gates: gates.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    let app = Arc::new(app);
    let mut log = Log {
        events: app.subscribe(),
        seen: Vec::new(),
    };

    app.dispatch(AuthCommand::Login { remember: false }.into())
        .await
        .unwrap();
    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
    log.until("the lobby connecting", |event| {
        matches!(event, LobbyEvent::GamesUpdated { .. })
    })
    .await;

    // Join A gets as far as its download, and is called off there.
    let first = tokio::spawn({
        let app = app.clone();
        async move { app.dispatch_and_wait(join(1)).await }
    });
    log.until("join A preparing", |event| is_step(event, FIRST_MAP))
        .await;
    app.dispatch_and_wait(LobbyCommand::CancelJoin.into())
        .await
        .unwrap();

    // Join B starts while A's preparation is still finishing its file.
    let second = tokio::spawn({
        let app = app.clone();
        async move { app.dispatch_and_wait(join(2)).await }
    });
    log.until("join B preparing", |event| is_step(event, SECOND_MAP))
        .await;
    let b_started = log.seen.len();

    // Now A's preparation finishes, and A's handler runs to its end.
    gates.open(FIRST_MAP);
    tokio::time::timeout(Duration::from_secs(5), first)
        .await
        .expect("join A never finished")
        .unwrap()
        .unwrap();

    // B still holds the join slot, so a third join is refused. A's cleanup
    // used to free B's slot, and this one went ahead alongside B.
    app.dispatch_and_wait(join(3)).await.unwrap();
    log.drain();

    let after_b: Vec<_> = log.seen[b_started..].to_vec();
    assert!(
        !after_b.iter().any(|event| is_step(event, FIRST_MAP)),
        "the cancelled join narrated progress over the new one: {after_b:?}"
    );
    assert!(
        !after_b
            .iter()
            .any(|event| matches!(event, LobbyEvent::Joining { id: 1, .. })),
        "the cancelled join came back: {after_b:?}"
    );
    assert!(
        !after_b
            .iter()
            .any(|event| matches!(event, LobbyEvent::Joining { id: 3, .. })),
        "a third join started while B held the slot: {after_b:?}"
    );

    // B carries on to its own request, and the server's answer is for B.
    gates.open(SECOND_MAP);
    log.until("the launch order", |event| {
        matches!(event, LobbyEvent::Launching { .. })
    })
    .await;
    tokio::time::timeout(Duration::from_secs(5), second)
        .await
        .expect("join B never finished")
        .unwrap()
        .unwrap();
    let launches: Vec<i32> = log
        .seen
        .iter()
        .filter_map(|event| match event {
            LobbyEvent::Launching { launch } => Some(launch.uid),
            _ => None,
        })
        .collect();
    assert_eq!(launches, vec![2], "only B's join request was sent");
}

/// How long to give the reconnect watchdog: two of its five-second ticks.
const WATCHDOG_WAIT: Duration = Duration::from_secs(11);

#[tokio::test]
async fn the_lobby_comes_back_after_a_drop_but_not_after_a_disconnect() {
    let lobby = FakeLobby::default();
    let ports = Ports {
        lobby: Arc::new(lobby.clone()),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();

    // A real account session: the watchdog leaves the test mode alone.
    app.dispatch_and_wait(AuthCommand::Login { remember: false }.into())
        .await
        .unwrap();
    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
    expect(&mut events, "the lobby connecting", |event| {
        matches!(event, LobbyEvent::Connected)
    })
    .await;

    // The adapter gives up on its own (its retries are used up), which ends
    // the update stream exactly as this does. Nobody asked for it.
    lobby.disconnect();
    expect(&mut events, "the lobby disconnecting", |event| {
        matches!(event, LobbyEvent::Disconnected)
    })
    .await;
    tokio::time::timeout(
        WATCHDOG_WAIT,
        wait_for(&mut events, |event| matches!(event, LobbyEvent::Connected)),
    )
    .await
    .expect("the watchdog never brought the lobby back");

    // The user hangs up. That stays hung up.
    app.dispatch(LobbyCommand::Disconnect.into()).await.unwrap();
    expect(&mut events, "the lobby disconnecting", |event| {
        matches!(event, LobbyEvent::Disconnected)
    })
    .await;
    let reconnected = tokio::time::timeout(
        WATCHDOG_WAIT,
        wait_for(&mut events, |event| matches!(event, LobbyEvent::Connecting)),
    )
    .await;
    assert!(
        reconnected.is_err(),
        "the watchdog reconnected a lobby the user disconnected"
    );
    assert_eq!(app.snapshot().lobby.status, LobbyStatus::Disconnected);
}

async fn wait_for(
    events: &mut broadcast::Receiver<AppEvent>,
    matches: impl Fn(&LobbyEvent) -> bool,
) {
    loop {
        match events.recv().await {
            Ok(AppEvent::Lobby(event)) if matches(&event) => return,
            Err(broadcast::error::RecvError::Closed) => panic!("the app stopped"),
            _ => {}
        }
    }
}

/// [`wait_for`], failing the test instead of hanging when it never comes.
async fn expect(
    events: &mut broadcast::Receiver<AppEvent>,
    what: &str,
    matches: impl Fn(&LobbyEvent) -> bool,
) {
    tokio::time::timeout(Duration::from_secs(5), wait_for(events, matches))
        .await
        .unwrap_or_else(|_| panic!("never saw {what}"));
}
