//! Auth service tests — driven through a configurable fake [`AuthPort`].
//!
//! Demonstrates the Port pattern: the service is exercised with no network by
//! swapping the port implementation, both for success and failure paths.

use std::sync::Arc;
use std::time::Duration;

use faf_app::infra::{FakeAuth, FakeLobby};
use faf_app::{App, Ports};
use faf_domain::state::{AuthCommand, AuthEvent, AuthStatus, Player};
use faf_domain::AppEvent;

fn app_with(auth: FakeAuth) -> App {
    let ports = Ports {
        auth: Arc::new(auth),
        lobby: Arc::new(FakeLobby::default()),
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    app
}

#[tokio::test]
async fn login_success_emits_started_then_logged_in() {
    let app = app_with(FakeAuth {
        player: Player {
            id: 7,
            name: "Ada".into(),
        },
        delay: Duration::ZERO,
        fail_with: None,
    });
    let mut events = app.subscribe();

    app.dispatch(AuthCommand::Login.into()).await;

    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Auth(AuthEvent::LoginStarted)
    ));
    match events.recv().await.unwrap() {
        AppEvent::Auth(AuthEvent::LoggedIn { player }) => assert_eq!(player.name, "Ada"),
        other => panic!("expected LoggedIn, got {other:?}"),
    }

    let snap = app.snapshot();
    assert_eq!(snap.auth.status, AuthStatus::LoggedIn);
    assert_eq!(snap.auth.player.unwrap().id, 7);
}

#[tokio::test]
async fn login_failure_emits_started_then_failed() {
    let app = app_with(FakeAuth {
        delay: Duration::ZERO,
        fail_with: Some("invalid credentials".into()),
        ..FakeAuth::default()
    });
    let mut events = app.subscribe();

    app.dispatch(AuthCommand::Login.into()).await;

    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Auth(AuthEvent::LoginStarted)
    ));
    match events.recv().await.unwrap() {
        AppEvent::Auth(AuthEvent::LoginFailed { message }) => {
            assert_eq!(message, "invalid credentials");
        }
        other => panic!("expected LoginFailed, got {other:?}"),
    }

    let snap = app.snapshot();
    assert_eq!(snap.auth.status, AuthStatus::Failed);
    assert_eq!(snap.auth.error.as_deref(), Some("invalid credentials"));
}
