use super::*;
use faf_domain::state::{
    AuthEvent, ChatCommand, ChatEvent, ChatStatus, LobbyEvent, LobbyStatus, PartyMember,
    PartyState, Player, PlayerProfile, SocialEvent,
};

async fn until(app: &App, done: impl Fn(&AppState) -> bool) {
    let mut events = app.subscribe();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !app.with_state(&done) {
            let _ = events.recv().await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "lifecycle did not reach expected state: {:?}",
            app.with_state(|s| (
                s.auth.clone(),
                s.chat.status,
                s.lobby.status,
                s.chat
                    .channels
                    .iter()
                    .map(|c| c.name.clone())
                    .collect::<Vec<_>>()
            ))
        )
    });
}

fn party(owner: i32) -> PartyState {
    PartyState {
        owner_id: Some(owner),
        members: [10001, 10002]
            .map(|player_id| PartyMember {
                player_id,
                name: format!("Player {player_id}"),
                factions: vec![],
            })
            .into(),
    }
}

#[tokio::test]
async fn lifecycle_connects_without_a_frontend_and_tracks_party_rooms() {
    let (app, app_loop) = App::new("test", crate::infra::fake_ports());
    let sink = app_loop.sink.clone();
    tokio::spawn(app_loop.run());
    sink.emit(AuthEvent::LoggedIn {
        player: Player::new(10001, "Owner"),
    });
    until(&app, |s| {
        s.chat.status == ChatStatus::Connected && s.lobby.status == LobbyStatus::Connected
    })
    .await;
    sink.emit(LobbyEvent::PartyUpdated {
        party: party(10001),
    });
    until(&app, |s| s.chat.channel("#Owner'sParty").is_some()).await;
    // A transfer waits for the real owner login, rather than joining a
    // placeholder room such as "#Player 2'sParty".
    sink.emit(LobbyEvent::PartyUpdated {
        party: party(10002),
    });
    until(&app, |s| s.chat.channel("#Owner'sParty").is_none()).await;
    sink.emit(SocialEvent::PlayersSeen {
        players: vec![PlayerProfile {
            id: 10002,
            login: "Next".into(),
            ..Default::default()
        }],
    });
    until(&app, |s| s.chat.channel("#Next'sParty").is_some()).await;
    app.dispatch_and_wait(ChatCommand::Disconnect.into())
        .await
        .unwrap();
    until(&app, |s| s.chat.status == ChatStatus::Disconnected).await;
    app.dispatch(
        ChatCommand::Connect {
            username: "Owner".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    until(&app, |s| {
        s.chat.status == ChatStatus::Connected && s.chat.channel("#Next'sParty").is_some()
    })
    .await;
    sink.emit(LobbyEvent::PartyUpdated {
        party: PartyState::default(),
    });
    until(&app, |s| s.chat.channel("#Next'sParty").is_none()).await;
    sink.emit(AuthEvent::LoggedOut);
    until(&app, |s| s.chat.status == ChatStatus::Disconnected).await;
    sink.emit(AuthEvent::LoggedIn {
        player: Player::new(10002, "Next"),
    });
    until(&app, |s| {
        s.chat.status == ChatStatus::Connected && s.chat.username == "Next"
    })
    .await;
    assert!(app.with_state(|s| s.chat.channel("#Owner'sParty").is_none()));
}

#[tokio::test]
async fn lifecycle_delayed_login_task_cannot_rearm_a_manual_disconnect() {
    let (app, app_loop) = App::new("test", crate::infra::fake_ports());
    app_loop.sink.emit(AuthEvent::LoggedIn {
        player: Player::new(10001, "Owner"),
    });
    // The commands complete before the lifecycle observer is polled.
    services::chat::handle(ChatCommand::Disconnect, &app_loop.ctx, &app_loop.sink).await;
    services::lobby::handle(
        faf_domain::state::LobbyCommand::Disconnect,
        &app_loop.ctx,
        &app_loop.sink,
    )
    .await;
    let ctx = Arc::new(app_loop.ctx);
    let sink = app_loop.sink;
    services::lobby::reconnect(&ctx, &sink).await;
    services::chat::start_account("Owner".into(), &ctx, &sink).await;
    assert_eq!(app.snapshot().chat.status, ChatStatus::Disconnected);
    assert_eq!(app.snapshot().lobby.status, LobbyStatus::Disconnected);
}

#[tokio::test]
async fn lifecycle_internal_chat_retry_retires_an_obsolete_party_room() {
    let (app, app_loop) = App::new("test", crate::infra::fake_ports());
    let sink = app_loop.sink.clone();
    tokio::spawn(app_loop.run());
    sink.emit(AuthEvent::LoggedIn {
        player: Player::new(10001, "Owner"),
    });
    until(&app, |s| s.chat.status == ChatStatus::Connected).await;
    sink.emit(LobbyEvent::PartyUpdated {
        party: party(10001),
    });
    until(&app, |s| s.chat.channel("#Owner'sParty").is_some()).await;
    // An adapter-internal retry keeps the same port and active guard.
    sink.emit(ChatEvent::Disconnected);
    sink.emit(LobbyEvent::PartyUpdated {
        party: PartyState::default(),
    });
    until(&app, |s| s.chat.channel("#Owner'sParty").is_none()).await;
    sink.emit(ChatEvent::Connected {
        username: "Owner".into(),
    });
    sink.emit(LobbyEvent::PartyUpdated {
        party: party(10001),
    });
    until(&app, |s| s.chat.channel("#Owner'sParty").is_some()).await;
}

#[tokio::test]
async fn lifecycle_test_login_connects_fake_chat_without_opening_a_tab() {
    let (app, app_loop) = App::new("test", crate::infra::fake_ports());
    let sink = app_loop.sink.clone();
    tokio::spawn(app_loop.run());
    sink.emit(AuthEvent::TestLoggedIn {
        player: Player::new(42, "TestCommander"),
    });
    until(&app, |s| {
        s.chat.status == ChatStatus::Connected && s.chat.username == "TestCommander"
    })
    .await;
}
