//! Lobby service test — drives the streaming port end-to-end.
//!
//! Proves the push path: Connect → Connecting → Connected → (at least one)
//! GamesUpdated with the seeded games, and that state reflects the snapshot.

use faf_app::infra::fake_ports;
use faf_app::App;
use faf_domain::state::{JoinState, LobbyCommand, LobbyStatus};
use faf_domain::AppEvent;

#[tokio::test]
async fn connect_streams_game_snapshots() {
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();

    app.dispatch(LobbyCommand::Connect.into()).await;

    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Lobby(faf_domain::state::LobbyEvent::Connecting)
    ));
    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Lobby(faf_domain::state::LobbyEvent::Connected)
    ));

    // The fake sends an immediate first snapshot — no waiting on the tick.
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
async fn disconnect_ends_the_stream() {
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();

    app.dispatch(LobbyCommand::Connect.into()).await;

    // Drain until we've seen at least one snapshot (connection is live).
    loop {
        match events.recv().await.unwrap() {
            AppEvent::Lobby(faf_domain::state::LobbyEvent::GamesUpdated { .. }) => break,
            _ => continue,
        }
    }

    // Cancelling the connection must drive the slice back to Disconnected.
    app.dispatch(LobbyCommand::Disconnect.into()).await;
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
    // not both open a connection — the second loses the single-flight guard. So we
    // see exactly one Connecting → Connected → GamesUpdated, never a stray second
    // Connecting or a teardown that clobbers state.
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();

    app.dispatch(LobbyCommand::Connect.into()).await;
    app.dispatch(LobbyCommand::Connect.into()).await;

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

    app.dispatch(LobbyCommand::Connect.into()).await;

    // Wait until the connection is live (a snapshot arrived) before joining, so
    // the fake has stored the live update sender.
    loop {
        if let AppEvent::Lobby(faf_domain::state::LobbyEvent::GamesUpdated { .. }) =
            events.recv().await.unwrap()
        {
            break;
        }
    }

    app.dispatch(LobbyCommand::Join { id: 2 }.into()).await;

    // Optimistic Joining is emitted immediately by the service.
    loop {
        match events.recv().await.unwrap() {
            AppEvent::Lobby(faf_domain::state::LobbyEvent::Joining { id }) => {
                assert_eq!(id, 2);
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
