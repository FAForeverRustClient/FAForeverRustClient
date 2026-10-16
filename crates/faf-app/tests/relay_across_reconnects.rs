//! A game outlives the lobby connection it was launched on.
//!
//! The adapter's input from the lobby lived in the connect loop and closed
//! with it. After the player pressed Disconnect and Connect mid-game, the
//! server restored the game session, and its relay messages (a peer's new ICE
//! candidates) were dropped: the adapter's input was gone for good. These pin
//! that the next connection hands them to the same adapter.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakeAuth, FakeLobby};
use faf_app::ports::{
    ConnectivitySession, GameLaunchParams, IceParams, IcePort, InstallPresence, LobbyUpdate,
    ProcessPort, RelayMsg,
};
use faf_app::{App, Ports};
use faf_domain::state::{AuthCommand, LobbyCommand, LobbyEvent, Player};
use faf_domain::AppEvent;
use serde_json::json;
use tokio::sync::{broadcast, mpsc, Notify};

/// A game that runs until the test ends.
#[derive(Default)]
struct RunningGame {
    exited: Notify,
}

#[async_trait]
impl ProcessPort for RunningGame {
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

/// An adapter that keeps what the lobby sends it, for the test to read.
#[derive(Default)]
struct RecordingAdapter {
    from_lobby: Mutex<Option<mpsc::Receiver<RelayMsg>>>,
    // Held so the adapter's side of the relay to the lobby stays open.
    to_lobby: Mutex<Option<mpsc::Sender<RelayMsg>>>,
}

#[async_trait]
impl IcePort for RecordingAdapter {
    async fn start(&self, _params: IceParams) -> Result<ConnectivitySession, String> {
        let (to_lobby_tx, to_lobby) = mpsc::channel::<RelayMsg>(8);
        let (from_lobby, from_lobby_rx) = mpsc::channel::<RelayMsg>(8);
        *self.from_lobby.lock().unwrap() = Some(from_lobby_rx);
        *self.to_lobby.lock().unwrap() = Some(to_lobby_tx);
        Ok(ConnectivitySession {
            game_port: 1,
            to_lobby,
            from_lobby,
            late_failure: None,
        })
    }
    fn stop(&self) {}
}

async fn until_lobby(
    events: &mut broadcast::Receiver<AppEvent>,
    what: &str,
    done: impl Fn(&LobbyEvent) -> bool,
) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match events.recv().await {
                Ok(AppEvent::Lobby(event)) if done(&event) => return,
                Ok(AppEvent::Lobby(LobbyEvent::LaunchFailed { reason })) => {
                    panic!("the launch failed: {reason}")
                }
                _ => {}
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("never saw {what}"));
}

#[tokio::test]
async fn relay_messages_reach_the_adapter_after_a_reconnect_mid_game() {
    let lobby = FakeLobby::default();
    let ice = Arc::new(RecordingAdapter::default());
    let ports = Ports {
        auth: Arc::new(FakeAuth {
            player: Player::new(7, "Ada"),
            delay: Duration::ZERO,
            fail_with: None,
        }),
        lobby: Arc::new(lobby.clone()),
        process: Arc::new(RunningGame::default()),
        ice: ice.clone(),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();

    app.dispatch(AuthCommand::Login { remember: false }.into())
        .await
        .unwrap();
    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
    until_lobby(&mut events, "the lobby connecting", |event| {
        matches!(event, LobbyEvent::Connected)
    })
    .await;
    app.dispatch(
        LobbyCommand::Join {
            id: 1,
            password: None,
            replace_mods: false,
        }
        .into(),
    )
    .await
    .unwrap();
    until_lobby(&mut events, "the game starting", |event| {
        matches!(event, LobbyEvent::InGame)
    })
    .await;

    app.dispatch(LobbyCommand::Disconnect.into()).await.unwrap();
    until_lobby(&mut events, "the lobby disconnecting", |event| {
        matches!(event, LobbyEvent::Disconnected)
    })
    .await;
    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
    until_lobby(&mut events, "the lobby reconnecting", |event| {
        matches!(event, LobbyEvent::Connected)
    })
    .await;

    assert!(lobby.push_update(LobbyUpdate::GameRelay {
        command: "IceMsg".into(),
        args: vec![json!(2), json!("candidate")],
    }));
    let mut from_lobby = ice
        .from_lobby
        .lock()
        .unwrap()
        .take()
        .expect("the adapter was started");
    let relayed = tokio::time::timeout(Duration::from_secs(5), from_lobby.recv())
        .await
        .expect("the relay message never reached the adapter")
        .expect("the adapter's input closed with the first connection");
    assert_eq!(relayed.command, "IceMsg");
}
