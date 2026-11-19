//! A full lobby is announced when the player's own game says it is (#777).
//!
//! The game list cannot always tell: the server's `max_players` stays at the
//! map's number of start positions when the host closes slots, and an AI in a
//! slot is not counted as a player there. The game's lobby sends `GameFull`
//! over GPGNet when no open slot is left, to every player in it, and these pin
//! that the client reads it on its way to the server.

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
use faf_domain::state::settings::NotificationPreferencesPatch;
use faf_domain::state::{
    AuthCommand, GameLaunch, LobbyCommand, LobbyEvent, NotificationKind, Player, SettingsCommand,
};
use faf_domain::AppEvent;
use tokio::sync::{broadcast, mpsc, Notify};

use crate::support;

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

/// An adapter the test speaks for: what it sends is what the game said.
#[derive(Default)]
struct GameVoice {
    to_lobby: Mutex<Option<mpsc::Sender<RelayMsg>>>,
    // Held so the lobby's side of the relay into the adapter stays open.
    from_lobby: Mutex<Option<mpsc::Receiver<RelayMsg>>>,
}

impl GameVoice {
    async fn says(&self, command: &str) {
        let sender = self
            .to_lobby
            .lock()
            .unwrap()
            .clone()
            .expect("the adapter was started");
        sender
            .send(RelayMsg {
                command: command.into(),
                args: vec![],
            })
            .await
            .expect("the launcher stopped reading the game");
    }
}

#[async_trait]
impl IcePort for GameVoice {
    async fn start(&self, _params: IceParams) -> Result<ConnectivitySession, String> {
        let (to_lobby_tx, to_lobby) = mpsc::channel::<RelayMsg>(8);
        let (from_lobby, from_lobby_rx) = mpsc::channel::<RelayMsg>(8);
        *self.to_lobby.lock().unwrap() = Some(to_lobby_tx);
        *self.from_lobby.lock().unwrap() = Some(from_lobby_rx);
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

/// Logged in and connected, with the lobby and the adapter to drive.
async fn connected() -> (
    App,
    FakeLobby,
    Arc<GameVoice>,
    broadcast::Receiver<AppEvent>,
) {
    let lobby = FakeLobby::default();
    let ice = Arc::new(GameVoice::default());
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
    let app = support::start(ports);
    let mut events = app.subscribe();
    app.dispatch_and_wait(AuthCommand::Login { remember: false }.into())
        .await
        .unwrap();
    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
    until_lobby(&mut events, "the lobby connecting", |event| {
        matches!(event, LobbyEvent::Connected)
    })
    .await;
    (app, lobby, ice, events)
}

fn relayed(lobby: &FakeLobby, command: &str) -> usize {
    lobby
        .game_relays()
        .iter()
        .filter(|(sent, _)| sent == command)
        .count()
}

fn game_full_notices(app: &App) -> Vec<String> {
    app.snapshot()
        .notifications
        .items
        .into_iter()
        .filter(|notice| notice.kind == NotificationKind::GameFull)
        .map(|notice| notice.body)
        .collect()
}

/// In the game that "Sandbox" is: 2 of 12 in the list, because the host
/// closed the other slots, which the server's numbers never show.
async fn in_sandbox(app: &App, events: &mut broadcast::Receiver<AppEvent>) {
    support::until(app, "the game list", |state| {
        state
            .lobby
            .games
            .iter()
            .any(|game| game.id == 3 && game.players < game.max_players)
    })
    .await;
    app.dispatch(
        LobbyCommand::Join {
            id: 3,
            password: None,
            replace_mods: false,
        }
        .into(),
    )
    .await
    .unwrap();
    until_lobby(events, "the game starting", |event| {
        matches!(event, LobbyEvent::InGame)
    })
    .await;
}

/// The game says its lobby is full, and the message reaches the server.
async fn game_full(lobby: &FakeLobby, ice: &GameVoice, times: usize) {
    ice.says("GameFull").await;
    support::eventually("the game's message reaching the server", || {
        relayed(lobby, "GameFull") == times
    })
    .await;
}

#[tokio::test]
async fn a_lobby_the_game_calls_full_is_announced_though_the_list_has_room() {
    let (app, lobby, ice, mut events) = connected().await;
    in_sandbox(&app, &mut events).await;

    game_full(&lobby, &ice, 1).await;
    let notices = game_full_notices(&app);
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert!(notices[0].contains("Sandbox"), "{notices:?}");

    // Somebody leaves and the slot is filled again: the lobby is about to
    // launch again, and by default that is announced too.
    game_full(&lobby, &ice, 2).await;
    assert_eq!(game_full_notices(&app).len(), 2);
}

#[tokio::test]
async fn with_repeats_off_a_lobby_filling_again_is_announced_once() {
    let (app, lobby, ice, mut events) = connected().await;
    app.dispatch_and_wait(
        SettingsCommand::PatchNotifications {
            patch: Box::new(NotificationPreferencesPatch {
                game_full_repeats: Some(false),
                ..Default::default()
            }),
        }
        .into(),
    )
    .await
    .unwrap();
    in_sandbox(&app, &mut events).await;

    game_full(&lobby, &ice, 1).await;
    game_full(&lobby, &ice, 2).await;
    assert_eq!(game_full_notices(&app).len(), 1);
}

#[tokio::test]
async fn a_matchmaker_game_calling_itself_full_is_not_announced() {
    let (app, lobby, ice, mut events) = connected().await;
    assert!(lobby.push_update(LobbyUpdate::Launch(GameLaunch {
        uid: 900,
        mod_name: "faf".into(),
        name: "Ada Vs Opponent".into(),
        mapname: "scmp_009".into(),
        game_type: "matchmaker".into(),
        rating_type: "ladder_1v1".into(),
        expected_players: Some(2),
        team: Some(2),
        faction: Some(1),
        map_position: Some(1),
        game_options: Default::default(),
        args: vec![],
    })));
    until_lobby(&mut events, "the match starting", |event| {
        matches!(event, LobbyEvent::InGame)
    })
    .await;

    ice.says("GameFull").await;
    support::eventually("the game's message reaching the server", || {
        relayed(&lobby, "GameFull") == 1
    })
    .await;
    // Read before the message is passed on, so nothing can still be coming.
    assert!(game_full_notices(&app).is_empty());
}
