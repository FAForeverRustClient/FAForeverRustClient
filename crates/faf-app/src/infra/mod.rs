//! Infrastructure — the only place that performs real IO.
//!
//! Concrete implementations of the [`crate::ports`] traits. Nothing outside this
//! module does IO directly (ARCHITECTURE.md §2 dependency rule).
//!
//! Auth now has a real provider ([`OAuthAuth`], FAF Ory Hydra) alongside the
//! offline [`FakeAuth`]; the lobby is still faked until its real protocol lands.
//! Either way the services, slices and UI are unchanged (ARCHITECTURE.md §2).

pub mod auth;
pub mod game;
pub mod ice_java;
pub mod ice_pioneer;
pub mod jsonrpc;
pub mod lobby;
pub mod lobby_ws;
pub mod oauth;
pub mod relay;
pub mod session;
pub mod settings_fake;
pub mod settings_file;

pub use auth::FakeAuth;
pub use game::{FakeGame, GameConfig, GameProcess};
pub use ice_java::{JavaAdapter, JavaConfig};
pub use ice_pioneer::{FakeIce, IceConfig, PioneerAdapter};
pub use lobby::FakeLobby;
pub use lobby_ws::{LobbyClient, LobbyConfig};
pub use oauth::{OAuthAuth, OAuthConfig};
pub use relay::{FakeRelay, GpgRelayServer};
pub use session::TokenStore;
pub use settings_fake::FakeSettings;
pub use settings_file::FileSettings;

use std::sync::Arc;

use crate::ports::{IcePort, LobbyPort, Ports, ProcessPort};

/// Reserve a free loopback TCP port by binding then dropping. Used by the adapter
/// backends to pick GPGNet/RPC ports for subprocesses. Mirrors the Python client's
/// `tcp_server()` helper; the brief gap before the subprocess binds is the same
/// small race it accepts.
pub(crate) fn free_port() -> Option<u16> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|addr| addr.port())
}

/// Build a [`Ports`] bundle backed entirely by fakes. Fully offline; used by tests.
pub fn fake_ports() -> Ports {
    Ports {
        auth: Arc::new(FakeAuth::default()),
        lobby: Arc::new(FakeLobby::default()),
        settings: Arc::new(FakeSettings::default()),
        ice: Arc::new(FakeIce),
        process: Arc::new(FakeGame),
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

    // The connectivity + launch chain spawns real subprocesses, so it is opt-in
    // via `FAF_REAL_LAUNCH=1`. Without it (the default), inert fakes keep the app
    // usable without an adapter or the game installed. The adapter backend is
    // chosen by `FAF_ICE_ADAPTER_KIND` (`java` default, or `go`).
    let (ice, process): (Arc<dyn IcePort>, Arc<dyn ProcessPort>) =
        if std::env::var("FAF_REAL_LAUNCH").is_ok_and(|v| !v.is_empty()) {
            (select_ice_adapter(&tokens), Arc::new(GameProcess::faf()))
        } else {
            (Arc::new(FakeIce), Arc::new(FakeGame))
        };

    Ports {
        auth: Arc::new(OAuthAuth::new(OAuthConfig::from_env(), tokens)),
        lobby,
        settings: Arc::new(FileSettings::faf()),
        ice,
        process,
    }
}

/// Pick the ICE adapter backend. `FAF_ICE_ADAPTER_KIND=go` selects faf-pioneer;
/// anything else (default) selects the Java `faf-ice-adapter`, which is the path
/// proven to connect in current environments.
fn select_ice_adapter(tokens: &TokenStore) -> Arc<dyn IcePort> {
    match std::env::var("FAF_ICE_ADAPTER_KIND").as_deref() {
        Ok("go") => Arc::new(PioneerAdapter::faf(tokens.clone())),
        _ => Arc::new(JavaAdapter::faf(tokens.clone())),
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
