//! Real lobby provider — the FAF lobby WebSocket protocol.
//!
//! Connects to `wss://ws.faforever.com`, performs the session handshake and
//! streams the open-games list behind the same [`LobbyPort`] the fake implements.
//! The connection lifecycle (and graceful teardown via `disconnect`) lives here;
//! the lobby service, slice and UI are unchanged.
//!
//! ## Protocol
//! First, `GET {api}/lobby/access` (bearer token) returns `{ accessUrl }` — a
//! one-time verified `wss://…/?verify=…` URL (connecting to the bare host 403s).
//! Then, one JSON object per text frame, keyed by `command`:
//!
//! 1. → `ask_session { version, user_agent }`
//! 2. ← `session { session }`
//! 3. → `auth { token, unique_id, session }`
//! 4. ← `welcome { me }` (or `authentication_failed`)
//! 5. ← `game_info { … }` / `game_info { games: [ … ] }` — pushed continuously
//!
//! ## `unique_id` (anti-smurf)
//! The lobby `auth` also requires a `unique_id`: a machine fingerprint produced by
//! FAF's `faf-uid` executable (we can't reproduce its encryption, but we don't need
//! to — we run the official binary). We invoke `faf-uid <session>` and use its
//! stdout. The binary path comes from `FAF_UID_PATH` (defaults to `faf-uid[.exe]`
//! resolved against the working directory / `PATH`). This client is opt-in via
//! `FAF_REAL_LOBBY=1`; without a working `faf-uid`, auth fails and the stream ends.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_domain::state::{Game, GameLaunch};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use crate::infra::session::TokenStore;
use crate::ports::{LobbyPort, LobbyUpdate};

/// Configuration for the real lobby client.
#[derive(Debug, Clone)]
pub struct LobbyConfig {
    /// Explicit WebSocket URL override (e.g. a local test server). Empty means
    /// "derive a verified URL from the API" via `/lobby/access`, which FAF prod
    /// requires — connecting to the bare `wss://…` host returns 403.
    pub ws_url: String,
    /// FAF *user* API base (`user.faforever.com`), which serves `/lobby/access`.
    /// Note this is a different host from the main `api.faforever.com`.
    pub user_api_base: String,
    /// Client version reported in `ask_session`.
    pub version: String,
    /// Path to the `faf-uid` executable used to compute `unique_id`.
    pub uid_path: String,
}

impl LobbyConfig {
    pub fn faf() -> Self {
        Self {
            // Empty by default → fetch a verified URL from /lobby/access.
            ws_url: std::env::var("FAF_LOBBY_URL")
                .ok()
                .filter(|v| !v.is_empty())
                .unwrap_or_default(),
            user_api_base: env_or("FAF_USER_API_BASE", "https://user.faforever.com"),
            version: env_or("FAF_CLIENT_VERSION", env!("CARGO_PKG_VERSION")),
            uid_path: env_or("FAF_UID_PATH", default_uid_path()),
        }
    }
}

fn env_or(key: &str, fallback: impl Into<String>) -> String {
    std::env::var(key)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| fallback.into())
}

fn default_uid_path() -> &'static str {
    if cfg!(windows) {
        "faf-uid.exe"
    } else {
        "faf-uid"
    }
}

pub struct LobbyClient {
    config: LobbyConfig,
    tokens: TokenStore,
    http: reqwest::Client,
    cancel: Arc<Mutex<Option<CancellationToken>>>,
    /// Outgoing frames for the live connection. `join` pushes a `game_join` here;
    /// `run_session` drains it and writes to the socket. `None` when not connected.
    outgoing: Arc<Mutex<Option<mpsc::Sender<Value>>>>,
}

impl LobbyClient {
    pub fn new(config: LobbyConfig, tokens: TokenStore) -> Self {
        Self {
            config,
            tokens,
            http: reqwest::Client::new(),
            cancel: Arc::new(Mutex::new(None)),
            outgoing: Arc::new(Mutex::new(None)),
        }
    }

    pub fn faf(tokens: TokenStore) -> Self {
        Self::new(LobbyConfig::faf(), tokens)
    }

    /// Push a JSON frame onto the live connection's outgoing channel. Returns
    /// `false` if there is no active connection (so callers can log).
    fn send_frame(&self, frame: Value) -> bool {
        self.outgoing
            .lock()
            .unwrap()
            .as_ref()
            .map(|tx| tx.try_send(frame).is_ok())
            .unwrap_or(false)
    }
}

#[async_trait]
impl LobbyPort for LobbyClient {
    async fn connect(&self) -> mpsc::Receiver<LobbyUpdate> {
        let token = CancellationToken::new();
        if let Some(prev) = self.cancel.lock().unwrap().replace(token.clone()) {
            prev.cancel();
        }

        let (tx, rx) = mpsc::channel(8);
        // Channel for client→server frames (game_join, …). The receiver is drained
        // inside `run_session`; the sender is stored so `join` can reach the socket.
        let (out_tx, out_rx) = mpsc::channel::<Value>(8);
        *self.outgoing.lock().unwrap() = Some(out_tx);

        let config = self.config.clone();
        let http = self.http.clone();
        let access_token = self.tokens.get();
        tokio::spawn(async move {
            // On any failure we simply drop `tx`; the receiver closes and the
            // lobby service emits `Disconnected`.
            run_session(config, http, access_token, tx, out_rx, token).await;
        });
        rx
    }

    fn join(&self, id: i32) {
        let frame = json!({ "command": "game_join", "uid": id, "gameport": 0 });
        if !self.send_frame(frame) {
            eprintln!("[lobby] join({id}) ignored: no active connection");
        }
    }

    fn send_game_relay(&self, command: String, args: Vec<Value>) {
        let frame = json!({ "command": command, "target": "game", "args": args });
        if !self.send_frame(frame) {
            eprintln!("[lobby] relay '{command}' dropped: no active connection");
        }
    }

    fn disconnect(&self) {
        if let Some(token) = self.cancel.lock().unwrap().take() {
            token.cancel();
        }
        // Drop the outgoing sender so a `join` before reconnect is a no-op.
        *self.outgoing.lock().unwrap() = None;
    }
}

/// Drive one lobby connection from handshake to close. Returns when the socket
/// ends, auth fails, or `cancel` fires (which sends a graceful close frame).
async fn run_session(
    config: LobbyConfig,
    http: reqwest::Client,
    access_token: Option<String>,
    tx: mpsc::Sender<LobbyUpdate>,
    mut outgoing: mpsc::Receiver<Value>,
    cancel: CancellationToken,
) {
    let Some(access_token) = access_token else {
        eprintln!("[lobby] not connecting: no access token (are you logged in?)");
        return; // not logged in — nothing to authenticate with
    };

    // Resolve the WebSocket URL. FAF prod requires a verified URL obtained from
    // the API (the bare host 403s); an explicit FAF_LOBBY_URL bypasses that.
    let ws_url = if config.ws_url.is_empty() {
        match fetch_access_url(&http, &config.user_api_base, &access_token).await {
            Ok(url) => url,
            Err(e) => {
                eprintln!("[lobby] could not get lobby access url: {e}");
                return;
            }
        }
    } else {
        config.ws_url.clone()
    };
    // The server returns "wss://host?verify=…" with no path, which some clients
    // reject with 400. Insert the missing "/" (mirrors the reference client).
    let ws_url = ensure_ws_path(&ws_url);

    // Note: ws_url carries a one-time verify token — never log it verbatim.
    let ws = match tokio_tungstenite::connect_async(ws_url.as_str()).await {
        Ok((ws, _)) => ws,
        Err(e) => {
            eprintln!("[lobby] could not open websocket: {e}");
            return;
        }
    };
    eprintln!("[lobby] websocket connected");
    let (mut write, mut read) = ws.split();

    // 1. Ask for a session.
    let ask = json!({
        "command": "ask_session",
        "version": config.version,
        "user_agent": "forge-client",
    });
    if write.send(Message::text(ask.to_string())).await.is_err() {
        eprintln!("[lobby] failed to send ask_session");
        return;
    }

    let mut games = GameSet::default();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = write.send(Message::Close(None)).await;
                break;
            }
            // Client→server frames (e.g. game_join from `join`). `None` means the
            // sender was dropped by `disconnect` — tear down gracefully.
            frame = outgoing.recv() => {
                let Some(frame) = frame else {
                    let _ = write.send(Message::Close(None)).await;
                    break;
                };
                if write.send(Message::text(frame.to_string())).await.is_err() {
                    break;
                }
            }
            incoming = read.next() => {
                let Some(Ok(message)) = incoming else { break };
                let text = match message {
                    Message::Text(t) => t,
                    Message::Close(_) => break,
                    _ => continue, // ping/pong/binary — ignore
                };
                let Ok(value) = serde_json::from_str::<Value>(text.as_str()) else { continue };

                // Connectivity messages addressed to the game are relayed to the
                // local ICE adapter, regardless of their command name.
                if value.get("target").and_then(Value::as_str) == Some("game") {
                    let command = command_of(&value).to_string();
                    let args = value
                        .get("args")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    if tx
                        .send(LobbyUpdate::GameRelay { command, args })
                        .await
                        .is_err()
                    {
                        break;
                    }
                    continue;
                }

                match command_of(&value) {
                    "session" => {
                        // Compute the machine fingerprint and authenticate.
                        eprintln!("[lobby] got session, running faf-uid…");
                        let session = value.get("session").cloned().unwrap_or(Value::Null);
                        let unique_id =
                            match generate_unique_id(&config.uid_path, &session_to_string(&session))
                                .await
                            {
                                Ok(uid) => uid,
                                Err(e) => {
                                    // Can't authenticate — end the stream (service
                                    // emits Disconnected). Surfaced for the dev console.
                                    eprintln!("[lobby] faf-uid failed: {e}");
                                    break;
                                }
                            };
                        let auth = json!({
                            "command": "auth",
                            "token": access_token,
                            "unique_id": unique_id,
                            "session": session,
                        });
                        if write.send(Message::text(auth.to_string())).await.is_err() {
                            break;
                        }
                    }
                    "authentication_failed" => {
                        eprintln!(
                            "[lobby] authentication failed: {}",
                            value.get("text").and_then(Value::as_str).unwrap_or("(no detail)")
                        );
                        break;
                    }
                    "welcome" => {
                        eprintln!("[lobby] authenticated — receiving games");
                    }
                    "notice" => {
                        // Server-side messages (version kicks, kicks, info) land here.
                        eprintln!(
                            "[lobby] notice [{}]: {}",
                            value.get("style").and_then(Value::as_str).unwrap_or(""),
                            value.get("text").and_then(Value::as_str).unwrap_or("")
                        );
                    }
                    "game_info" => {
                        for raw in extract_raw_games(&value) {
                            games.apply(raw);
                        }
                        if tx.send(LobbyUpdate::Games(games.snapshot())).await.is_err() {
                            break; // consumer gone
                        }
                    }
                    "game_launch" => {
                        match parse_game_launch(&value) {
                            Some(launch) => {
                                eprintln!("[lobby] game_launch for uid {}", launch.uid);
                                if tx.send(LobbyUpdate::Launch(launch)).await.is_err() {
                                    break;
                                }
                            }
                            None => eprintln!("[lobby] game_launch missing required fields"),
                        }
                    }
                    "game_join_failed" => {
                        let id = value.get("uid").and_then(Value::as_i64).unwrap_or(0) as i32;
                        let reason = value
                            .get("reason")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .to_string();
                        eprintln!("[lobby] game_join_failed (uid {id}): {reason}");
                        if tx
                            .send(LobbyUpdate::JoinFailed { id, reason })
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    _ => {} // social, player_info, … — not needed yet
                }
            }
        }
    }
    eprintln!("[lobby] connection closed");
}

fn command_of(value: &Value) -> &str {
    value.get("command").and_then(Value::as_str).unwrap_or("")
}

/// Ask the API for a verified lobby WebSocket URL. Returns `accessUrl`, which
/// already embeds the one-time verify token the lobby server requires.
async fn fetch_access_url(
    http: &reqwest::Client,
    user_api_base: &str,
    token: &str,
) -> Result<String, String> {
    let resp = http
        .get(format!("{user_api_base}/lobby/access"))
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "/lobby/access returned {status}: {}",
            body.chars().take(200).collect::<String>()
        ));
    }

    let value: Value = serde_json::from_str(&body).map_err(|e| format!("invalid JSON: {e}"))?;
    extract_access_url(&value).ok_or_else(|| "response had no accessUrl".to_string())
}

/// Ensure there is a `/` path between the authority and the query, so a URL like
/// `wss://host?verify=x` becomes `wss://host/?verify=x`. Leaves URLs that already
/// have a path untouched, and never modifies the query (the verify token).
fn ensure_ws_path(raw: &str) -> String {
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

/// Pull `accessUrl` out of the `/lobby/access` response (top-level or JSON:API).
fn extract_access_url(value: &Value) -> Option<String> {
    value
        .get("accessUrl")
        .or_else(|| value.get("data").and_then(|d| d.get("accessUrl")))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// The session id may arrive as a JSON number or string; `faf-uid` wants it as a
/// plain string argument.
fn session_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

/// Run `faf-uid <session>` and return its stdout — the `unique_id` blob. Errors
/// if the binary is missing, exits non-zero, or produces nothing.
async fn generate_unique_id(uid_path: &str, session: &str) -> Result<String, String> {
    let output = tokio::process::Command::new(uid_path)
        .arg(session)
        .output()
        .await
        .map_err(|e| format!("could not run '{uid_path}': {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "{uid_path} exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let uid = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if uid.is_empty() {
        return Err(format!("{uid_path} produced no output"));
    }
    Ok(uid)
}

/// One game as it arrives in a `game_info` message. Only the fields we surface.
#[derive(Debug, Clone, Deserialize)]
struct RawGame {
    uid: i32,
    #[serde(default)]
    state: String,
    #[serde(default)]
    num_players: i32,
    #[serde(default)]
    max_players: i32,
    #[serde(default)]
    title: String,
    #[serde(default)]
    host: String,
    #[serde(default)]
    mapname: String,
}

impl RawGame {
    /// Only games still open for joining belong in the list.
    fn is_open(&self) -> bool {
        self.state == "open"
    }

    fn into_game(self) -> Game {
        Game {
            id: self.uid,
            title: self.title,
            host: self.host,
            players: self.num_players,
            max_players: self.max_players,
            map: self.mapname,
        }
    }
}

/// A `game_info` message is either a single game or a batch under `games`.
fn extract_raw_games(message: &Value) -> Vec<RawGame> {
    if let Some(array) = message.get("games").and_then(Value::as_array) {
        array
            .iter()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect()
    } else {
        serde_json::from_value(message.clone()).into_iter().collect()
    }
}

/// A `game_launch` message — the server's order to start a game. `args` arrives as
/// a mixed list of strings and numbers (`list[str | int]`), so we take it as raw
/// `Value`s and stringify. `uid` is required; everything else defaults.
#[derive(Debug, Clone, Deserialize)]
struct RawGameLaunch {
    uid: i32,
    #[serde(rename = "mod", default)]
    mod_name: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    mapname: String,
    #[serde(default)]
    game_type: String,
    #[serde(default)]
    rating_type: String,
    #[serde(default)]
    args: Vec<Value>,
}

impl RawGameLaunch {
    fn into_launch(self) -> GameLaunch {
        GameLaunch {
            uid: self.uid,
            mod_name: self.mod_name,
            name: self.name,
            mapname: self.mapname,
            game_type: self.game_type,
            rating_type: self.rating_type,
            args: self.args.iter().map(value_to_arg).collect(),
        }
    }
}

/// Render a launch arg as a string: bare for strings, JSON form for numbers/bools.
fn value_to_arg(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Parse a `game_launch` message into a [`GameLaunch`], or `None` if it lacks the
/// required `uid`.
fn parse_game_launch(message: &Value) -> Option<GameLaunch> {
    serde_json::from_value::<RawGameLaunch>(message.clone())
        .ok()
        .map(RawGameLaunch::into_launch)
}

/// The aggregated open-games list. Keyed by id so updates replace in place and
/// closed games are removed; snapshots are ordered by id for stable rendering.
#[derive(Debug, Default)]
struct GameSet {
    games: BTreeMap<i32, Game>,
}

impl GameSet {
    fn apply(&mut self, raw: RawGame) {
        if raw.is_open() {
            self.games.insert(raw.uid, raw.into_game());
        } else {
            self.games.remove(&raw.uid);
        }
    }

    fn snapshot(&self) -> Vec<Game> {
        self.games.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_game_json(uid: i32, state: &str, players: i32) -> Value {
        json!({
            "command": "game_info",
            "uid": uid,
            "state": state,
            "num_players": players,
            "max_players": 8,
            "title": format!("Game {uid}"),
            "host": "Stormlord",
            "mapname": "Theta Passage",
        })
    }

    #[test]
    fn extracts_single_game() {
        let raws = extract_raw_games(&open_game_json(7, "open", 3));
        assert_eq!(raws.len(), 1);
        assert_eq!(raws[0].uid, 7);
        assert_eq!(raws[0].num_players, 3);
    }

    #[test]
    fn extracts_batched_games() {
        let msg = json!({
            "command": "game_info",
            "games": [open_game_json(1, "open", 1), open_game_json(2, "open", 2)],
        });
        let raws = extract_raw_games(&msg);
        assert_eq!(raws.len(), 2);
        assert_eq!(raws[1].uid, 2);
    }

    #[test]
    fn raw_game_maps_to_domain_game() {
        let raw = extract_raw_games(&open_game_json(42, "open", 5)).pop().unwrap();
        let game = raw.into_game();
        assert_eq!(game.id, 42);
        assert_eq!(game.players, 5);
        assert_eq!(game.max_players, 8);
        assert_eq!(game.map, "Theta Passage");
        assert_eq!(game.host, "Stormlord");
    }

    #[test]
    fn gameset_adds_open_and_removes_closed() {
        let mut set = GameSet::default();
        for raw in extract_raw_games(&open_game_json(1, "open", 1)) {
            set.apply(raw);
        }
        for raw in extract_raw_games(&open_game_json(2, "open", 2)) {
            set.apply(raw);
        }
        assert_eq!(set.snapshot().len(), 2);

        // Game 1 transitions to playing → drops out of the open list.
        for raw in extract_raw_games(&open_game_json(1, "playing", 2)) {
            set.apply(raw);
        }
        let snap = set.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].id, 2); // ordered by id
    }

    #[test]
    fn gameset_update_replaces_in_place() {
        let mut set = GameSet::default();
        for raw in extract_raw_games(&open_game_json(5, "open", 1)) {
            set.apply(raw);
        }
        for raw in extract_raw_games(&open_game_json(5, "open", 4)) {
            set.apply(raw);
        }
        let snap = set.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].players, 4);
    }

    #[test]
    fn parses_game_launch_with_mixed_args() {
        let msg = json!({
            "command": "game_launch",
            "uid": 12345,
            "mod": "faf",
            "name": "Big Team Game",
            "mapname": "scmp_009",
            "game_type": "custom",
            "rating_type": "global",
            "args": ["/numgames", 137, "/init", true],
        });
        let launch = parse_game_launch(&msg).expect("should parse");
        assert_eq!(launch.uid, 12345);
        assert_eq!(launch.mod_name, "faf"); // `mod` renamed
        assert_eq!(launch.name, "Big Team Game");
        assert_eq!(launch.mapname, "scmp_009");
        // Mixed string/number/bool args all stringified.
        assert_eq!(launch.args, vec!["/numgames", "137", "/init", "true"]);
    }

    #[test]
    fn game_launch_requires_uid_but_tolerates_missing_optionals() {
        // No uid → cannot parse.
        assert!(parse_game_launch(&json!({ "command": "game_launch" })).is_none());

        // uid only → everything else defaults gracefully.
        let launch = parse_game_launch(&json!({ "uid": 7 })).expect("uid is enough");
        assert_eq!(launch.uid, 7);
        assert_eq!(launch.mod_name, "");
        assert!(launch.args.is_empty());
    }

    #[test]
    fn ensure_ws_path_inserts_missing_slash() {
        assert_eq!(
            ensure_ws_path("wss://ws.faforever.com?verify=a.b-c_d"),
            "wss://ws.faforever.com/?verify=a.b-c_d"
        );
        // Already has a path → unchanged (no double slash, token untouched).
        assert_eq!(
            ensure_ws_path("wss://ws.faforever.com/?verify=a.b-c_d"),
            "wss://ws.faforever.com/?verify=a.b-c_d"
        );
        assert_eq!(
            ensure_ws_path("wss://host/path?verify=x"),
            "wss://host/path?verify=x"
        );
        assert_eq!(ensure_ws_path("wss://host"), "wss://host");
    }

    #[test]
    fn extracts_access_url_top_level_and_nested() {
        assert_eq!(
            extract_access_url(&json!({ "accessUrl": "wss://ws.faforever.com/?verify=abc" })),
            Some("wss://ws.faforever.com/?verify=abc".to_string())
        );
        assert_eq!(
            extract_access_url(&json!({ "data": { "accessUrl": "wss://x/?verify=y" } })),
            Some("wss://x/?verify=y".to_string())
        );
        assert_eq!(extract_access_url(&json!({ "nope": 1 })), None);
    }

    #[test]
    fn session_to_string_handles_number_and_string() {
        assert_eq!(session_to_string(&json!(123456)), "123456");
        assert_eq!(session_to_string(&json!("abc-789")), "abc-789");
        assert_eq!(session_to_string(&Value::Null), "");
    }

    #[test]
    fn missing_fields_default_gracefully() {
        let msg = json!({ "command": "game_info", "uid": 9, "state": "open" });
        let raws = extract_raw_games(&msg);
        assert_eq!(raws.len(), 1);
        let game = raws.into_iter().next().unwrap().into_game();
        assert_eq!(game.id, 9);
        assert_eq!(game.title, "");
        assert_eq!(game.max_players, 0);
    }
}
