//! Infrastructure — the only place that performs real IO.
//!
//! Concrete implementations of the [`crate::ports`] traits. Nothing outside this
//! module does IO directly (ARCHITECTURE.md §2 dependency rule).
//!
//! Auth now has a real provider ([`OAuthAuth`], FAF Ory Hydra) alongside the
//! offline [`FakeAuth`]; the lobby is still faked until its real protocol lands.
//! Either way the services, slices and UI are unchanged (ARCHITECTURE.md §2).

pub mod auth;
pub mod chat;
pub mod game;
pub mod game_updater;
pub mod ice_java;
pub mod ice_pioneer;
pub mod irc;
pub mod jsonrpc;
pub mod leaderboard;
pub mod lobby;
pub mod lobby_ws;
pub mod maps;
pub mod mods;
pub mod oauth;
pub mod relay;
pub mod replay;
pub mod session;
pub mod settings_fake;
pub mod settings_file;

pub use auth::FakeAuth;
pub use chat::FakeChat;
pub use game::{FakeGame, GameConfig, GameProcess};
pub use ice_java::{JavaAdapter, JavaConfig};
pub use ice_pioneer::{FakeIce, IceConfig, PioneerAdapter};
pub use irc::{IrcClient, IrcConfig};
pub use leaderboard::{FakeLeaderboard, LeaderboardClient, LeaderboardConfig};
pub use lobby::FakeLobby;
pub use lobby_ws::{LobbyClient, LobbyConfig};
pub use maps::{FakeMaps, MapsClient, MapsConfig};
pub use mods::{FakeMods, ModsClient, ModsConfig};
pub use oauth::{OAuthAuth, OAuthConfig};
pub use relay::{FakeRelay, GpgRelayServer};
pub use replay::{FakeReplay, ReplayClient, ReplayConfig};
pub use session::TokenStore;
pub use settings_fake::FakeSettings;
pub use settings_file::FileSettings;

use std::sync::Arc;

use serde_json::Value;

use crate::ports::{ChatPort, IcePort, LobbyPort, MapsPort, ModsPort, Ports, ProcessPort, ReplayPort};

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

/// Read an env var, falling back to `fallback` if unset or empty. Shared by the
/// lobby and replay clients for their `*_from_env`/`faf()` constructors.
pub(crate) fn env_or(key: &str, fallback: impl Into<String>) -> String {
    std::env::var(key)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| fallback.into())
}

/// Ask the FAF user API for a verified WebSocket access URL. Shared by the
/// lobby (`/lobby/access`) and replay (`/replay/access`) clients — both return
/// `{"accessUrl": "wss://…"}` (or the JSON:API-nested form) for a bearer token.
pub(crate) async fn fetch_access_url(
    http: &reqwest::Client,
    user_api_base: &str,
    path: &str,
    token: &str,
) -> Result<String, String> {
    let resp = http
        .get(format!("{user_api_base}{path}"))
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "{path} returned {status}: {}",
            body.chars().take(200).collect::<String>()
        ));
    }

    let value: Value = serde_json::from_str(&body).map_err(|e| format!("invalid JSON: {e}"))?;
    extract_access_url(&value).ok_or_else(|| "response had no accessUrl".to_string())
}

/// Pull `accessUrl` out of an `/…/access` response (top-level or JSON:API).
pub(crate) fn extract_access_url(value: &Value) -> Option<String> {
    value
        .get("accessUrl")
        .or_else(|| value.get("data").and_then(|d| d.get("accessUrl")))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Ensure there is a `/` path between the authority and the query, so a URL like
/// `wss://host?verify=x` becomes `wss://host/?verify=x`. Leaves URLs that already
/// have a path untouched, and never modifies the query (the verify token).
pub(crate) fn ensure_ws_path(raw: &str) -> String {
    if let Some(scheme_end) = raw.find("://") {
        let after = &raw[scheme_end + 3..];
        if let Some(q) = after.find('?') {
            if !after[..q].contains('/') {
                return format!("{}://{}/{}", &raw[..scheme_end], &after[..q], &after[q..]);
            }
        }
    }
    raw.to_string()
}

/// Build a [`Ports`] bundle backed entirely by fakes. Fully offline; used by tests.
pub fn fake_ports() -> Ports {
    Ports {
        auth: Arc::new(FakeAuth::default()),
        chat: Arc::new(FakeChat::default()),
        lobby: Arc::new(FakeLobby::default()),
        settings: Arc::new(FakeSettings::default()),
        ice: Arc::new(FakeIce),
        process: Arc::new(FakeGame),
        replay: Arc::new(FakeReplay),
        maps: Arc::new(FakeMaps),
        mods: Arc::new(FakeMods),
        leaderboard: Arc::new(FakeLeaderboard),
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

    // The real chat client speaks live IRC against production Ergochat, so
    // it's opt-in via `FAF_REAL_CHAT=1` — same posture as `FAF_REAL_LOBBY`.
    // By default chat stays faked so the app remains usable offline.
    let chat: Arc<dyn ChatPort> = if std::env::var("FAF_REAL_CHAT").is_ok_and(|v| !v.is_empty()) {
        Arc::new(IrcClient::faf(tokens.clone()))
    } else {
        Arc::new(FakeChat::default())
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

    // Replay watching launches the same game executable, so it rides on the
    // same `FAF_REAL_LAUNCH` gate and shares the `process` port above.
    let replay: Arc<dyn ReplayPort> =
        if std::env::var("FAF_REAL_LAUNCH").is_ok_and(|v| !v.is_empty()) {
            Arc::new(ReplayClient::faf(tokens.clone(), process.clone()))
        } else {
            Arc::new(FakeReplay)
        };

    // Vault browsing + local install management is pure API + filesystem —
    // no subprocess, so unlike ice/process/replay it isn't gated behind
    // `FAF_REAL_LAUNCH`; it just needs the same bearer token.
    let maps: Arc<dyn MapsPort> = Arc::new(MapsClient::faf(tokens.clone()));

    // Same posture as maps: pure API + filesystem (game.prefs), no
    // subprocess, not gated behind `FAF_REAL_LAUNCH`.
    let mods: Arc<dyn ModsPort> = Arc::new(ModsClient::faf(tokens.clone()));

    // Same posture as maps: pure API, no subprocess, not gated behind
    // `FAF_REAL_LAUNCH`.
    let leaderboard: Arc<dyn crate::ports::LeaderboardPort> =
        Arc::new(LeaderboardClient::faf(tokens.clone()));

    Ports {
        auth: Arc::new(OAuthAuth::new(OAuthConfig::from_env(), tokens)),
        chat,
        lobby,
        settings: Arc::new(FileSettings::faf()),
        ice,
        process,
        replay,
        maps,
        mods,
        leaderboard,
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
