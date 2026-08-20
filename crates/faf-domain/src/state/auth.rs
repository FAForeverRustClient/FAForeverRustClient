//! Auth slice: the player's identity / login lifecycle.
//!
//! Like every slice it owns its [state](AuthState), [events](AuthEvent),
//! [commands](AuthCommand) and pure [`reduce`]. How a login is actually performed
//! (OAuth, browser redirect, token exchange) lives behind a port in `faf-app`;
//! none of that leaks in here.

use serde::{Deserialize, Serialize};
use specta::Type;

/// FAF's permission role for organising tournaments.
///
/// The name the API's `ChallongeController` guards its write routes with
/// (`@Secured("ROLE_TOURNAMENT_DIRECTOR")`), held by the `faf_tournament_directors`
/// user group.
pub const ROLE_TOURNAMENT_DIRECTOR: &str = "TOURNAMENT_DIRECTOR";

/// An authenticated FAF player. Grows later (country, avatar, ratings…).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Player {
    // FAF player ids are database serials, comfortably within i32: and specta
    // forbids i64 across the JS boundary (precision loss). If an id ever needs
    // 64 bits, it crosses the boundary as a string, deliberately.
    pub id: i32,
    pub name: String,
    /// Permission roles the identity provider reports for this session.
    ///
    /// **These gate visibility, never access.** Every privileged operation is
    /// authorised server-side; an empty list here means "we could not read the
    /// roles", not "this player may do nothing". Hiding a control the server
    /// would refuse anyway is a courtesy, so being wrong costs a confusing
    /// screen: not a security hole. Anything that treated this as an
    /// authorisation decision would be trusting a value the client itself
    /// decoded.
    pub roles: Vec<String>,
}

impl Player {
    /// A player with no known roles: the ordinary case, and what every caller
    /// that has no role information should construct.
    pub fn new(id: i32, name: impl Into<String>) -> Self {
        Self {
            id,
            name: name.into(),
            roles: Vec::new(),
        }
    }

    /// Whether this session reports `role`.
    ///
    /// Deliberately lenient: FAF spells the same permission `ADMIN_MAP` in the
    /// database and `ROLE_ADMIN_MAP` in Spring's authority form, and the token
    /// claim is passed through verbatim by the infrastructure in between. Since
    /// this only decides whether a button is drawn, accepting both spellings is
    /// better than silently hiding a control from someone who holds the role.
    pub fn has_role(&self, role: &str) -> bool {
        self.roles
            .iter()
            .any(|held| normalise_role(held).eq_ignore_ascii_case(normalise_role(role)))
    }

    /// Whether this session may create and manage tournaments.
    pub fn is_tournament_director(&self) -> bool {
        self.has_role(ROLE_TOURNAMENT_DIRECTOR)
    }
}

fn normalise_role(role: &str) -> &str {
    let trimmed = role.trim();
    trimmed
        .strip_prefix("ROLE_")
        .or_else(|| trimmed.strip_prefix("role_"))
        .unwrap_or(trimmed)
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

/// Identifies whether the active shell session came from FAF OAuth or the
/// local, credential-free UI test path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AuthMode {
    #[default]
    Account,
    Test,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthState {
    pub status: AuthStatus,
    pub player: Option<Player>,
    pub error: Option<String>,
    pub mode: AuthMode,
}

/// The only way [`AuthState`] changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum AuthEvent {
    LoginStarted,
    LoggedIn { player: Player },
    TestLoggedIn { player: Player },
    LoginFailed { message: String },
    LoggedOut,
}

/// What the UI can ask the auth service to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum AuthCommand {
    /// Start the browser login and optionally retain the refresh token for the
    /// next client start.
    Login {
        remember: bool,
    },
    /// Cancel an in-flight browser login attempt and return to logged-out state.
    CancelLogin,
    /// Try a previously remembered refresh token. No-op when none is stored.
    Restore,
    LoginTest,
    Logout,
    LogoutTest,
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
            state.mode = AuthMode::Account;
        }
        AuthEvent::TestLoggedIn { player } => {
            state.status = AuthStatus::LoggedIn;
            state.player = Some(player.clone());
            state.error = None;
            state.mode = AuthMode::Test;
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
            state.mode = AuthMode::Account;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn player() -> Player {
        Player::new(7, "Commander")
    }

    fn player_with_roles(roles: &[&str]) -> Player {
        Player {
            roles: roles.iter().map(|role| (*role).to_string()).collect(),
            ..player()
        }
    }

    #[test]
    fn a_player_without_roles_holds_none() {
        assert!(!player().is_tournament_director());
        assert!(!player().has_role("ADMIN_MAP"));
    }

    #[test]
    fn a_held_role_is_recognised() {
        assert!(player_with_roles(&["USER", "TOURNAMENT_DIRECTOR"]).is_tournament_director());
    }

    #[test]
    fn both_spellings_of_the_same_role_match() {
        // FAF writes `TOURNAMENT_DIRECTOR` in the database and
        // `ROLE_TOURNAMENT_DIRECTOR` in Spring's authority form; whichever the
        // token carries must unlock the same UI.
        for spelling in [
            "TOURNAMENT_DIRECTOR",
            "ROLE_TOURNAMENT_DIRECTOR",
            "tournament_director",
            "  TOURNAMENT_DIRECTOR  ",
        ] {
            assert!(
                player_with_roles(&[spelling]).is_tournament_director(),
                "{spelling} should be recognised"
            );
        }
    }

    #[test]
    fn a_different_role_does_not_unlock_another() {
        let player = player_with_roles(&["ADMIN_MAP", "WRITE_AVATAR"]);
        assert!(!player.is_tournament_director());
        assert!(player.has_role("ADMIN_MAP"));
    }

    #[test]
    fn login_started_clears_error_and_marks_pending() {
        let mut s = AuthState {
            status: AuthStatus::Failed,
            player: None,
            error: Some("boom".into()),
            ..Default::default()
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
            ..Default::default()
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
            ..Default::default()
        };
        reduce(&mut s, &AuthEvent::LoggedOut);
        assert_eq!(s, AuthState::default());
    }

    #[test]
    fn test_login_marks_session_as_test_mode() {
        let mut s = AuthState::default();
        reduce(&mut s, &AuthEvent::TestLoggedIn { player: player() });
        assert_eq!(s.status, AuthStatus::LoggedIn);
        assert_eq!(s.mode, AuthMode::Test);
    }
}
