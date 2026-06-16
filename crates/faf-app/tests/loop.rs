//! End-to-end test of the unidirectional loop (without Tauri).
//!
//! Proves: dispatch a command → service emits events → state is reduced → the
//! same events are broadcast to subscribers, in order.

use faf_app::App;
use faf_domain::state::{ConnectionStatus, SessionCommand, SessionEvent};
use faf_domain::AppEvent;

#[tokio::test]
async fn hello_drives_session_to_ready() {
    let (app, app_loop) = App::new("9.9.9", faf_app::infra::fake_ports());
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();

    app.dispatch(SessionCommand::Hello.into()).await;

    // The service emits Connecting, then BackendReady — in that order.
    let first = events.recv().await.expect("expected Connecting event");
    assert!(matches!(first, AppEvent::Session(SessionEvent::Connecting)));

    let second = events.recv().await.expect("expected BackendReady event");
    match second {
        AppEvent::Session(SessionEvent::BackendReady { version }) => {
            assert_eq!(version, "9.9.9");
        }
        other => panic!("expected BackendReady, got {other:?}"),
    }

    // State reflects the final event.
    let snap = app.snapshot();
    assert_eq!(snap.session.status, ConnectionStatus::Connected);
    assert_eq!(snap.session.backend_version, "9.9.9");
}
