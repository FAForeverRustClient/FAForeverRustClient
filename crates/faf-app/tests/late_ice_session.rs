//! A game started before its ICE session (#511).
//!
//! The Java adapter answers seconds before FAF hands out the game's ICE
//! session, and the game no longer waits for it: the session is handed back
//! with a `late_failure` channel instead. These pin what the launcher does
//! with that channel. A failure stops the game and says why, and stays on
//! screen when the game's exit follows it; a session that arrives changes
//! nothing.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakeAuth, FakeLobby};
use faf_app::ports::{
    ConnectivitySession, GameLaunchParams, IceParams, IcePort, InstallPresence, ProcessPort,
    RelayMsg,
};
use faf_app::{App, Ports};
use faf_domain::state::{AuthCommand, JoinState, LobbyCommand, LobbyEvent, Player};
use faf_domain::AppEvent;
use tokio::sync::{mpsc, oneshot, Notify};

/// A game that runs until it is killed.
#[derive(Default)]
struct KillableGame {
    killed: AtomicBool,
    exited: Notify,
}

#[async_trait]
impl ProcessPort for KillableGame {
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
    fn kill(&self) {
        self.killed.store(true, Ordering::SeqCst);
        self.exited.notify_one();
    }
    async fn wait_for_exit(&self) {
        self.exited.notified().await;
    }
    fn set_paths(&self, _game_path: String, _replay_game_path: String) {}
    fn set_additional_arguments(&self, _arguments: Vec<String>) {}
    fn game_install_dir(&self) -> Option<PathBuf> {
        Some(PathBuf::from("C:/fake-fa-install"))
    }
    fn replay_install_dir(&self) -> Option<PathBuf> {
        None
    }
    fn installs_present(&self) -> InstallPresence {
        InstallPresence::default()
    }
}

/// An adapter that answers before its session: the test decides later
/// whether the session failed (`fail`) or arrived (`arrive`).
#[derive(Default)]
struct EarlyAdapter {
    late: Mutex<Option<oneshot::Sender<String>>>,
    stopped: AtomicUsize,
}

impl EarlyAdapter {
    fn fail(&self, reason: &str) {
        let late = self.late.lock().unwrap().take().expect("a session pending");
        late.send(reason.to_string()).unwrap();
    }

    fn arrive(&self) {
        drop(self.late.lock().unwrap().take().expect("a session pending"));
    }
}

#[async_trait]
impl IcePort for EarlyAdapter {
    async fn start(&self, _params: IceParams) -> Result<ConnectivitySession, String> {
        let (_to_lobby_tx, to_lobby) = mpsc::channel::<RelayMsg>(1);
        let (from_lobby, _from_lobby_rx) = mpsc::channel::<RelayMsg>(1);
        let (late, late_failure) = oneshot::channel();
        *self.late.lock().unwrap() = Some(late);
        Ok(ConnectivitySession {
            game_port: 1,
            to_lobby,
            from_lobby,
            late_failure: Some(late_failure),
        })
    }
    fn stop(&self) {
        self.stopped.fetch_add(1, Ordering::SeqCst);
    }
}

struct Harness {
    app: App,
    lobby: FakeLobby,
    game: Arc<KillableGame>,
    ice: Arc<EarlyAdapter>,
}

fn harness() -> Harness {
    let lobby = FakeLobby::default();
    let game = Arc::new(KillableGame::default());
    let ice = Arc::new(EarlyAdapter::default());
    let ports = Ports {
        auth: Arc::new(FakeAuth {
            player: Player::new(7, "Ada"),
            delay: Duration::ZERO,
            fail_with: None,
        }),
        lobby: Arc::new(lobby.clone()),
        process: game.clone(),
        ice: ice.clone(),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    Harness {
        app,
        lobby,
        game,
        ice,
    }
}

/// Log in, connect, join game 1, and wait for the game to be started.
async fn join_until_in_game(h: &Harness) {
    let mut events = h.app.subscribe();
    h.app
        .dispatch(AuthCommand::Login { remember: false }.into())
        .await
        .unwrap();
    h.app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !matches!(
            events.recv().await,
            Ok(AppEvent::Lobby(LobbyEvent::Connected))
        ) {}
    })
    .await
    .expect("the fake lobby never connected");
    h.app
        .dispatch(
            LobbyCommand::Join {
                id: 1,
                password: None,
                replace_mods: false,
            }
            .into(),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match events.recv().await {
                Ok(AppEvent::Lobby(LobbyEvent::InGame)) => return,
                Ok(AppEvent::Lobby(LobbyEvent::LaunchFailed { reason })) => {
                    panic!("the launch failed: {reason}")
                }
                _ => {}
            }
        }
    })
    .await
    .expect("the game never started");
}

/// Wait for the join state to satisfy `done`.
async fn until(h: &Harness, done: impl Fn(&JoinState) -> bool) -> JoinState {
    for _ in 0..250 {
        let join = h.app.snapshot().lobby.join;
        if done(&join) {
            return join;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("still at {:?}", h.app.snapshot().lobby.join);
}

#[tokio::test]
async fn a_session_that_fails_after_the_game_started_stops_the_game_and_says_why() {
    let h = harness();
    join_until_in_game(&h).await;
    assert!(!h.game.killed.load(Ordering::SeqCst));

    h.ice.fail("ice servers returned 503");

    let join = until(&h, |join| matches!(join, JoinState::LaunchFailed { .. })).await;
    let JoinState::LaunchFailed { reason } = join else {
        unreachable!()
    };
    assert!(reason.contains("ice servers returned 503"), "{reason}");
    assert!(h.game.killed.load(Ordering::SeqCst), "the game is stopped");
    assert!(
        h.ice.stopped.load(Ordering::SeqCst) > 0,
        "and so is the adapter"
    );

    // The exit that follows the kill releases the seat, and leaves the
    // failure on screen rather than replacing it with "terminated".
    for _ in 0..100 {
        if h.lobby.game_relays().iter().any(|(command, args)| {
            command == "GameState" && args.first().and_then(|arg| arg.as_str()) == Some("Ended")
        }) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(h.lobby.game_relays().iter().any(|(command, args)| {
        command == "GameState" && args.first().and_then(|arg| arg.as_str()) == Some("Ended")
    }));
    assert!(matches!(
        h.app.snapshot().lobby.join,
        JoinState::LaunchFailed { .. }
    ));
}

#[tokio::test]
async fn a_session_that_arrives_after_the_game_started_leaves_it_running() {
    let h = harness();
    join_until_in_game(&h).await;

    h.ice.arrive();
    tokio::time::sleep(Duration::from_millis(200)).await;

    assert!(!h.game.killed.load(Ordering::SeqCst));
    assert_eq!(h.ice.stopped.load(Ordering::SeqCst), 0);
    assert_eq!(h.app.snapshot().lobby.join, JoinState::InGame);
}

#[tokio::test]
async fn a_session_that_fails_after_the_player_left_changes_nothing() {
    // The game was quit first. Its adapter is stopped with it, which closes
    // the channel in the real adapter; a failure that still got through must
    // not fail a game that is not running.
    let h = harness();
    join_until_in_game(&h).await;

    h.app
        .dispatch(LobbyCommand::TerminateGame.into())
        .await
        .unwrap();
    until(&h, |join| *join == JoinState::Idle).await;
    h.ice.fail("too late");
    tokio::time::sleep(Duration::from_millis(200)).await;

    assert_eq!(h.app.snapshot().lobby.join, JoinState::Idle);
}
