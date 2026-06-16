//! Lobby service test — drives the streaming port end-to-end.
//!
//! Proves the push path: Connect → Connecting → Connected → (at least one)
//! GamesUpdated with the seeded games, and that state reflects the snapshot.

use faf_app::infra::fake_ports;
use faf_app::App;
use faf_domain::state::{LobbyCommand, LobbyStatus};
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
