//! Session slice: connection/auth status of the backend.
//!
//! A slice owns four things: its [state](SessionState), its [events](SessionEvent),
//! its [commands](SessionCommand) and its pure [`reduce`] function. Nothing else.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Connection state of the backend session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionStatus {
    #[default]
    Disconnected,
    Connecting,
    Connected,
}

/// State of the session slice.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    /// Version reported by the Rust backend once it is ready.
    pub backend_version: String,
    pub status: ConnectionStatus,
    /// Whether this process is wired to the offline development ports
    /// (`FAF_FAKE_AUTH=1`), rather than the real FAF services.
    ///
    /// The credential-free test login only produces a usable session in that
    /// build: against real ports it fabricates a player the server has never
    /// heard of, with no token behind it, so every subsequent request fails in
    /// a way that looks like the client is broken. The UI uses this to decide
    /// whether to offer it at all.
    pub offline_auth: bool,
}

/// Things that have happened to the session. The only way [`SessionState`] changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum SessionEvent {
    Connecting,
    #[serde(rename_all = "camelCase")]
    BackendReady {
        version: String,
        offline_auth: bool,
    },
    Disconnected,
}

/// Things the UI can ask the session service to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum SessionCommand {
    /// Handshake: ask the backend to report readiness.
    Hello,
}

/// Pure reducer for the session slice. No IO, no async, total over its events.
pub fn reduce(state: &mut SessionState, event: &SessionEvent) {
    match event {
        SessionEvent::Connecting => {
            state.status = ConnectionStatus::Connecting;
        }
        SessionEvent::BackendReady {
            version,
            offline_auth,
        } => {
            state.status = ConnectionStatus::Connected;
            state.backend_version = version.clone();
            state.offline_auth = *offline_auth;
        }
        SessionEvent::Disconnected => {
            state.status = ConnectionStatus::Disconnected;
            state.backend_version.clear();
            // Deliberately kept: which ports this process was built with does
            // not change when the socket drops, and clearing it would make the
            // login screen hide the development affordance on reconnect.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connecting_sets_status() {
        let mut s = SessionState::default();
        reduce(&mut s, &SessionEvent::Connecting);
        assert_eq!(s.status, ConnectionStatus::Connecting);
        assert!(s.backend_version.is_empty());
    }

    #[test]
    fn backend_ready_sets_connected_and_version() {
        let mut s = SessionState::default();
        reduce(
            &mut s,
            &SessionEvent::BackendReady {
                version: "1.2.3".into(),
                offline_auth: false,
            },
        );
        assert_eq!(s.status, ConnectionStatus::Connected);
        assert_eq!(s.backend_version, "1.2.3");
        assert!(!s.offline_auth);
    }

    #[test]
    fn a_release_build_never_reports_offline_auth() {
        // The login screen hangs the credential-free test button off this, and
        // that button fabricates a player id against real ports.
        let mut s = SessionState::default();
        assert!(!s.offline_auth, "the default must be the safe one");
        reduce(
            &mut s,
            &SessionEvent::BackendReady {
                version: "1.2.3".into(),
                offline_auth: true,
            },
        );
        assert!(s.offline_auth);
    }

    #[test]
    fn disconnected_clears_the_version_but_not_the_build_flavour() {
        let mut s = SessionState {
            backend_version: "1.2.3".into(),
            status: ConnectionStatus::Connected,
            offline_auth: true,
        };
        reduce(&mut s, &SessionEvent::Disconnected);
        assert_eq!(s.status, ConnectionStatus::Disconnected);
        assert!(s.backend_version.is_empty());
        assert!(
            s.offline_auth,
            "which ports were built does not change when a socket drops"
        );
    }
}
