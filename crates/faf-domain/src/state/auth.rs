//! Auth slice — the player's identity / login lifecycle.
//!
//! Like every slice it owns its [state](AuthState), [events](AuthEvent),
//! [commands](AuthCommand) and pure [`reduce`]. How a login is actually performed
//! (OAuth, browser redirect, token exchange) lives behind a port in `faf-app`;
//! none of that leaks in here.

use serde::{Deserialize, Serialize};
use specta::Type;

/// An authenticated FAF player. Grows later (country, avatar, ratings…).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Player {
    // FAF player ids are database serials, comfortably within i32 — and specta
    // forbids i64 across the JS boundary (precision loss). If an id ever needs
    // 64 bits, it crosses the boundary as a string, deliberately.
    pub id: i32,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AuthStatus {
    #[default]
    LoggedOut,
    LoggingIn,
    LoggedIn,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthState {
    pub status: AuthStatus,
    pub player: Option<Player>,
    pub error: Option<String>,
}

/// The only way [`AuthState`] changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum AuthEvent {
    LoginStarted,
    LoggedIn { player: Player },
    LoginFailed { message: String },
    LoggedOut,
}

/// What the UI can ask the auth service to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum AuthCommand {
    Login,
    Logout,
}

/// Pure reducer for the auth slice.
pub fn reduce(state: &mut AuthState, event: &AuthEvent) {
    match event {
        AuthEvent::LoginStarted => {
            state.status = AuthStatus::LoggingIn;
            state.error = None;
        }
        AuthEvent::LoggedIn { player } => {
            state.status = AuthStatus::LoggedIn;
            state.player = Some(player.clone());
            state.error = None;
        }
        AuthEvent::LoginFailed { message } => {
            state.status = AuthStatus::Failed;
            state.player = None;
            state.error = Some(message.clone());
        }
        AuthEvent::LoggedOut => {
            state.status = AuthStatus::LoggedOut;
            state.player = None;
            state.error = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn player() -> Player {
        Player {
            id: 7,
            name: "Commander".into(),
        }
    }

    #[test]
    fn login_started_clears_error_and_marks_pending() {
        let mut s = AuthState {
            status: AuthStatus::Failed,
            player: None,
            error: Some("boom".into()),
        };
        reduce(&mut s, &AuthEvent::LoginStarted);
        assert_eq!(s.status, AuthStatus::LoggingIn);
        assert_eq!(s.error, None);
    }

    #[test]
    fn logged_in_stores_player() {
        let mut s = AuthState::default();
        reduce(&mut s, &AuthEvent::LoggedIn { player: player() });
        assert_eq!(s.status, AuthStatus::LoggedIn);
        assert_eq!(s.player, Some(player()));
    }

    #[test]
    fn login_failed_records_message_and_drops_player() {
        let mut s = AuthState {
            status: AuthStatus::LoggingIn,
            player: Some(player()),
            error: None,
        };
        reduce(
            &mut s,
            &AuthEvent::LoginFailed {
                message: "invalid credentials".into(),
            },
        );
        assert_eq!(s.status, AuthStatus::Failed);
        assert_eq!(s.player, None);
        assert_eq!(s.error.as_deref(), Some("invalid credentials"));
    }

    #[test]
    fn logged_out_resets() {
        let mut s = AuthState {
            status: AuthStatus::LoggedIn,
            player: Some(player()),
            error: None,
        };
        reduce(&mut s, &AuthEvent::LoggedOut);
        assert_eq!(s, AuthState::default());
    }
}
