//! Auth service tests: driven through a configurable fake [`AuthPort`].
//!
//! Demonstrates the Port pattern: the service is exercised with no network by
//! swapping the port implementation, both for success and failure paths.

use std::sync::Arc;
use std::time::Duration;

use faf_app::infra::{fake_ports, FakeAuth};
use faf_app::{App, Ports};
use faf_domain::state::{AuthCommand, AuthEvent, AuthMode, AuthStatus, Player};
use faf_domain::AppEvent;

fn app_with(auth: FakeAuth) -> App {
    // Start from the all-fake bundle and swap in the configured auth port, so new
    // ports don't ripple into this test.
    let ports = Ports {
        auth: Arc::new(auth),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    app
}

#[tokio::test]
async fn login_success_emits_started_then_logged_in() {
    let app = app_with(FakeAuth {
        player: Player::new(7, "Ada"),
        delay: Duration::ZERO,
        fail_with: None,
    });
    let mut events = app.subscribe();

    app.dispatch(AuthCommand::Login { remember: true }.into())
        .await
        .unwrap();

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

    app.dispatch(AuthCommand::Login { remember: false }.into())
        .await
        .unwrap();

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

#[tokio::test]
async fn test_login_never_calls_provider_and_marks_test_mode() {
    let app = app_with(FakeAuth {
        fail_with: Some("provider should not be called".into()),
        ..FakeAuth::default()
    });
    let mut events = app.subscribe();

    app.dispatch(AuthCommand::LoginTest.into()).await.unwrap();

    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Auth(AuthEvent::LoginStarted)
    ));
    match events.recv().await.unwrap() {
        AppEvent::Auth(AuthEvent::TestLoggedIn { player }) => {
            assert_eq!(player.name, "TestCommander");
        }
        other => panic!("expected TestLoggedIn, got {other:?}"),
    }

    let snap = app.snapshot();
    assert_eq!(snap.auth.status, AuthStatus::LoggedIn);
    assert_eq!(snap.auth.mode, AuthMode::Test);
}

#[tokio::test]
async fn a_superseded_login_cannot_log_the_user_back_in() {
    let app = app_with(FakeAuth {
        delay: Duration::from_millis(40),
        ..FakeAuth::default()
    });
    let mut events = app.subscribe();

    app.dispatch(AuthCommand::Login { remember: true }.into())
        .await
        .unwrap();
    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Auth(AuthEvent::LoginStarted)
    ));

    app.dispatch(AuthCommand::LogoutTest.into()).await.unwrap();
    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Auth(AuthEvent::LoggedOut)
    ));

    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(app.snapshot().auth.status, AuthStatus::LoggedOut);
    assert!(
        tokio::time::timeout(Duration::from_millis(10), events.recv())
            .await
            .is_err()
    );
}
