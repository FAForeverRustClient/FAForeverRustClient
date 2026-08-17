//! Lobby service test: drives the streaming port end-to-end.
//!
//! Proves the push path: Connect → Connecting → Connected → (at least one)
//! GamesUpdated with the seeded games, and that state reflects the snapshot.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakeLobby};
use faf_app::ports::{
    GameLaunchParams, InstallPresence, LobbyUpdate, ProcessPort, ServerNoticeStyle, SettingsPort,
};
use faf_app::{App, Ports};
use faf_domain::state::{
    GameLaunch, HostGameConfig, JoinState, LobbyCommand, LobbyEvent, LobbyStatus, MatchmakingState,
    NotificationEvent, NotificationKind, PlayerProfile, SettingsState, SocialEvent,
};
use faf_domain::AppEvent;

#[derive(Default)]
struct RecordingSettings {
    saved: Arc<Mutex<Vec<SettingsState>>>,
}

#[derive(Default)]
struct RecordingProcess {
    kills: Arc<AtomicUsize>,
}

#[async_trait]
impl ProcessPort for RecordingProcess {
    fn supports_live_launch(&self) -> bool {
        false
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
        self.kills.fetch_add(1, Ordering::SeqCst);
    }

    fn set_paths(&self, _game_path: String, _replay_game_path: String) {}

    fn set_additional_arguments(&self, _arguments: Vec<String>) {}

    fn game_install_dir(&self) -> Option<PathBuf> {
        None
    }

    fn replay_install_dir(&self) -> Option<PathBuf> {
        None
    }

    fn installs_present(&self) -> InstallPresence {
        InstallPresence::default()
    }
}

async fn wait_for_initial_games(events: &mut tokio::sync::broadcast::Receiver<AppEvent>) {
    loop {
        if matches!(
            events.recv().await.unwrap(),
            AppEvent::Lobby(LobbyEvent::GamesUpdated { .. })
        ) {
            return;
        }
    }
}

#[async_trait]
impl SettingsPort for RecordingSettings {
    async fn load(&self) -> SettingsState {
        SettingsState::default()
    }

    async fn save(&self, settings: &SettingsState) {
        self.saved.lock().unwrap().push(settings.clone());
    }
}

fn host_config() -> HostGameConfig {
    HostGameConfig {
        title: "  Friday game  ".into(),
        mod_name: " faf ".into(),
        visibility: "PUBLIC".into(),
        map: " scmp_009 ".into(),
        password: Some(" secret ".into()),
        enforce_rating_range: true,
        rating_min: Some(800),
        rating_max: Some(1_500),
    }
}

#[tokio::test]
async fn valid_host_requests_are_normalized_sent_and_remembered() {
    let lobby = FakeLobby::default();
    let saved = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        lobby: Arc::new(lobby.clone()),
        settings: Arc::new(RecordingSettings {
            saved: saved.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());

    app.dispatch(
        LobbyCommand::Host {
            config: host_config(),
        }
        .into(),
    )
    .await
    .unwrap();

    for _ in 0..100 {
        if !saved.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let hosted = lobby.hosted_configs();
    assert_eq!(hosted.len(), 1);
    assert_eq!(hosted[0].title, "Friday game");
    assert_eq!(hosted[0].password.as_deref(), Some(" secret "));
    let snapshot = app.snapshot();
    let remembered = &snapshot.settings.browsing.host_game;
    assert_eq!(remembered.title, "Friday game");
    assert_eq!(remembered.featured_mod, "faf");
    assert_eq!(remembered.map, "scmp_009");
    assert_eq!(
        saved.lock().unwrap().last().unwrap().browsing.host_game,
        *remembered
    );
}

#[tokio::test]
async fn invalid_host_requests_never_reach_the_lobby_port() {
    let lobby = FakeLobby::default();
    let ports = Ports {
        lobby: Arc::new(lobby.clone()),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();
    let mut config = host_config();
    config.rating_min = Some(1_501);

    app.dispatch(LobbyCommand::Host { config }.into())
        .await
        .unwrap();

    loop {
        if let AppEvent::Notifications(NotificationEvent::Added { notification }) =
            events.recv().await.unwrap()
        {
            assert_eq!(notification.kind, NotificationKind::Error);
            assert!(notification.body.contains("Minimum rating"));
            break;
        }
    }
    assert!(lobby.hosted_configs().is_empty());
}

#[tokio::test]
async fn connect_streams_game_snapshots() {
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();

    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();

    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Lobby(faf_domain::state::LobbyEvent::Connecting)
    ));
    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Lobby(faf_domain::state::LobbyEvent::Connected)
    ));

    // The fake sends an immediate first snapshot: no waiting on the tick.
    match events.recv().await.unwrap() {
        AppEvent::Lobby(faf_domain::state::LobbyEvent::GamesUpdated { games }) => {
            assert!(!games.is_empty(), "first snapshot should have games");
        }
        other => panic!("expected GamesUpdated, got {other:?}"),
    }

    let snap = app.snapshot();
    assert_eq!(snap.lobby.status, LobbyStatus::Connected);
    assert!(!snap.lobby.games.is_empty());
}

#[tokio::test]
async fn server_kill_notice_is_retained_and_terminates_the_game() {
    let lobby = FakeLobby::default();
    let kills = Arc::new(AtomicUsize::new(0));
    let ports = Ports {
        lobby: Arc::new(lobby.clone()),
        process: Arc::new(RecordingProcess {
            kills: kills.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();
    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
    wait_for_initial_games(&mut events).await;

    assert!(lobby.push_update(LobbyUpdate::Notice {
        style: ServerNoticeStyle::Kill,
        text: "The match was closed by an administrator.".into(),
    }));

    let mut saw_notice = false;
    let mut saw_termination = false;
    while !saw_notice || !saw_termination {
        match events.recv().await.unwrap() {
            AppEvent::Notifications(NotificationEvent::Added { notification }) => {
                if notification.title == "Game stopped by server" {
                    assert_eq!(notification.kind, NotificationKind::Error);
                    assert!(notification.body.contains("administrator"));
                    saw_notice = true;
                }
            }
            AppEvent::Lobby(LobbyEvent::GameTerminated) => saw_termination = true,
            _ => {}
        }
    }
    assert_eq!(kills.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn connection_rejection_keeps_the_authoritative_reason() {
    let lobby = FakeLobby::default();
    let ports = Ports {
        lobby: Arc::new(lobby.clone()),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();
    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
    wait_for_initial_games(&mut events).await;

    assert!(lobby.push_update(LobbyUpdate::ConnectionRejected {
        reason: "This client version is no longer supported.".into(),
    }));
    loop {
        if let AppEvent::Notifications(NotificationEvent::Added { notification }) =
            events.recv().await.unwrap()
        {
            if notification.title == "Lobby connection rejected" {
                assert!(notification.body.contains("no longer supported"));
                break;
            }
        }
    }
}

#[tokio::test]
async fn cancellation_after_matchmaker_launch_stops_the_spawned_game() {
    let lobby = FakeLobby::default();
    let kills = Arc::new(AtomicUsize::new(0));
    let ports = Ports {
        lobby: Arc::new(lobby.clone()),
        process: Arc::new(RecordingProcess {
            kills: kills.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();
    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
    wait_for_initial_games(&mut events).await;

    assert!(
        lobby.push_update(LobbyUpdate::Matchmaking(MatchmakingState::Launching {
            queue_name: "ladder1v1".into(),
        },))
    );
    assert!(lobby.push_update(LobbyUpdate::Launch(GameLaunch {
        uid: 77,
        mod_name: "faf".into(),
        name: "Ranked match".into(),
        mapname: "scmp_007".into(),
        game_type: "matchmaker".into(),
        rating_type: "ladder_1v1".into(),
        expected_players: Some(2),
        team: Some(1),
        faction: Some(1),
        map_position: Some(1),
        game_options: Default::default(),
        args: Vec::new(),
    })));

    loop {
        if matches!(
            events.recv().await.unwrap(),
            AppEvent::Lobby(LobbyEvent::Launching { .. })
        ) {
            break;
        }
    }
    assert!(
        lobby.push_update(LobbyUpdate::Matchmaking(MatchmakingState::Cancelled {
            queue_name: Some("ladder1v1".into()),
        },))
    );

    loop {
        if matches!(
            events.recv().await.unwrap(),
            AppEvent::Lobby(LobbyEvent::GameTerminated)
        ) {
            break;
        }
    }
    assert_eq!(kills.load(Ordering::SeqCst), 1);
    assert_eq!(app.snapshot().lobby.join, JoinState::Idle);
}

#[tokio::test]
async fn an_authoritative_friend_offline_update_notifies_once_then_removes_the_profile() {
    let lobby = FakeLobby::default();
    let ports = Ports {
        lobby: Arc::new(lobby.clone()),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();

    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
    loop {
        if matches!(
            events.recv().await.unwrap(),
            AppEvent::Social(SocialEvent::RelationsUpdated { .. })
        ) {
            break;
        }
    }
    assert!(app.snapshot().social.is_friend("Stormlord"));
    assert!(app.snapshot().social.player("Stormlord").is_some());

    assert!(
        lobby.push_update(LobbyUpdate::PlayersRemoved(vec![PlayerProfile {
            id: 2,
            login: "Stormlord".into(),
            ..Default::default()
        }]))
    );

    loop {
        if let AppEvent::Notifications(NotificationEvent::Added { notification }) =
            events.recv().await.unwrap()
        {
            assert_eq!(notification.kind, NotificationKind::FriendOffline);
            assert!(notification.body.contains("Stormlord"));
            break;
        }
    }
    loop {
        if matches!(
            events.recv().await.unwrap(),
            AppEvent::Social(SocialEvent::PlayersRemoved { .. })
        ) {
            break;
        }
    }
    let snapshot = app.snapshot();
    assert!(snapshot.social.player("Stormlord").is_none());
    assert!(snapshot.social.is_friend("Stormlord"));
}

#[tokio::test]
async fn terminate_game_command_resets_the_join_lifecycle() {
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();

    app.dispatch(LobbyCommand::TerminateGame.into())
        .await
        .unwrap();

    loop {
        if matches!(
            events.recv().await.unwrap(),
            AppEvent::Lobby(LobbyEvent::GameTerminated)
        ) {
            break;
        }
    }
    assert_eq!(app.snapshot().lobby.join, JoinState::Idle);
}

#[tokio::test]
async fn disconnect_ends_the_stream() {
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();

    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();

    // Drain until we've seen at least one snapshot (connection is live).
    loop {
        match events.recv().await.unwrap() {
            AppEvent::Lobby(faf_domain::state::LobbyEvent::GamesUpdated { .. }) => break,
            _ => continue,
        }
    }

    // Cancelling the connection must drive the slice back to Disconnected.
    app.dispatch(LobbyCommand::Disconnect.into()).await.unwrap();
    loop {
        if let AppEvent::Lobby(faf_domain::state::LobbyEvent::Disconnected) =
            events.recv().await.unwrap()
        {
            break;
        }
    }

    let snap = app.snapshot();
    assert_eq!(snap.lobby.status, LobbyStatus::Disconnected);
    assert!(snap.lobby.games.is_empty(), "games cleared on disconnect");
}

#[tokio::test]
async fn duplicate_connect_is_dropped_single_flight() {
    // Two near-simultaneous Connects (e.g. React StrictMode double-invoke) must
    // not both open a connection: the second loses the single-flight guard. So we
    // see exactly one Connecting → Connected → GamesUpdated, never a stray second
    // Connecting or a teardown that clobbers state.
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();

    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();

    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Lobby(faf_domain::state::LobbyEvent::Connecting)
    ));
    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Lobby(faf_domain::state::LobbyEvent::Connected)
    ));
    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Lobby(faf_domain::state::LobbyEvent::GamesUpdated { .. })
    ));

    let snap = app.snapshot();
    assert_eq!(snap.lobby.status, LobbyStatus::Connected);
    assert!(!snap.lobby.games.is_empty());
}

#[tokio::test]
async fn join_emits_joining_then_launching() {
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();

    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();

    // Wait until the connection is live (a snapshot arrived) before joining, so
    // the fake has stored the live update sender.
    loop {
        if let AppEvent::Lobby(faf_domain::state::LobbyEvent::GamesUpdated { .. }) =
            events.recv().await.unwrap()
        {
            break;
        }
    }

    app.dispatch(
        LobbyCommand::Join {
            id: 2,
            password: None,
        }
        .into(),
    )
    .await
    .unwrap();

    // Optimistic Joining is emitted immediately by the service.
    loop {
        match events.recv().await.unwrap() {
            AppEvent::Lobby(faf_domain::state::LobbyEvent::Joining { id, prepared }) => {
                assert_eq!(id, 2);
                assert!(!prepared, "the fake process does not prepare local content");
                break;
            }
            _ => continue, // a GamesUpdated tick may interleave
        }
    }

    // The fake replies with a launch order on the same stream.
    loop {
        match events.recv().await.unwrap() {
            AppEvent::Lobby(faf_domain::state::LobbyEvent::Launching { launch }) => {
                assert_eq!(launch.uid, 2);
                break;
            }
            _ => continue,
        }
    }

    let snap = app.snapshot();
    match snap.lobby.join {
        JoinState::Launched { launch } => assert_eq!(launch.uid, 2),
        other => panic!("expected Launched, got {other:?}"),
    }
}
