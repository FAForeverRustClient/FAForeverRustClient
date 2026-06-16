//! Infrastructure — the only place that performs real IO.
//!
//! Concrete implementations of the [`crate::ports`] traits. Nothing outside this
//! module does IO directly (ARCHITECTURE.md §2 dependency rule).
//!
//! Auth now has a real provider ([`OAuthAuth`], FAF Ory Hydra) alongside the
//! offline [`FakeAuth`]; the lobby is still faked until its real protocol lands.
//! Either way the services, slices and UI are unchanged (ARCHITECTURE.md §2).

pub mod auth;
pub mod lobby;
pub mod lobby_ws;
pub mod oauth;
pub mod session;

pub use auth::FakeAuth;
pub use lobby::FakeLobby;
pub use lobby_ws::{LobbyClient, LobbyConfig};
pub use oauth::{OAuthAuth, OAuthConfig};
pub use session::TokenStore;

use std::sync::Arc;

use crate::ports::{LobbyPort, Ports};

/// Build a [`Ports`] bundle backed entirely by fakes. Fully offline; used by tests.
pub fn fake_ports() -> Ports {
    Ports {
        auth: Arc::new(FakeAuth::default()),
        lobby: Arc::new(FakeLobby::default()),
    }
}

/// Build a [`Ports`] bundle with the real OAuth2 auth provider, sharing one
/// [`TokenStore`] so the lobby client can authenticate with the logged-in token.
///
/// The real lobby client is opt-in via `FAF_REAL_LOBBY=1`; it runs FAF's `faf-uid`
/// executable (path via `FAF_UID_PATH`) for the anti-smurf fingerprint required by
/// lobby auth (see [`lobby_ws`]). By default the lobby stays faked so the app
/// remains usable end-to-end without that binary.
pub fn real_ports() -> Ports {
    let tokens = TokenStore::new();
    let lobby: Arc<dyn LobbyPort> =
        if std::env::var("FAF_REAL_LOBBY").is_ok_and(|v| !v.is_empty()) {
            Arc::new(LobbyClient::faf(tokens.clone()))
        } else {
            Arc::new(FakeLobby::default())
        };
    Ports {
        auth: Arc::new(OAuthAuth::new(OAuthConfig::from_env(), tokens)),
        lobby,
    }
}

/// Pick the port bundle the shell should use. Defaults to real auth; set
/// `FAF_FAKE_AUTH=1` to run fully offline (no browser login) for local dev.
pub fn ports_from_env() -> Ports {
    if std::env::var("FAF_FAKE_AUTH").is_ok_and(|v| !v.is_empty()) {
        fake_ports()
    } else {
        real_ports()
    }
}
