//! Session slice — connection/auth status of the backend.
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
}

/// Things that have happened to the session. The only way [`SessionState`] changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum SessionEvent {
    Connecting,
    BackendReady { version: String },
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
        SessionEvent::BackendReady { version } => {
            state.status = ConnectionStatus::Connected;
            state.backend_version = version.clone();
        }
        SessionEvent::Disconnected => {
            state.status = ConnectionStatus::Disconnected;
            state.backend_version.clear();
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
            },
        );
        assert_eq!(s.status, ConnectionStatus::Connected);
        assert_eq!(s.backend_version, "1.2.3");
    }

    #[test]
    fn disconnected_clears_version() {
        let mut s = SessionState {
            backend_version: "1.2.3".into(),
            status: ConnectionStatus::Connected,
        };
        reduce(&mut s, &SessionEvent::Disconnected);
        assert_eq!(s.status, ConnectionStatus::Disconnected);
        assert!(s.backend_version.is_empty());
    }
}
