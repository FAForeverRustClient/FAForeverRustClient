//! Real lobby provider: the FAF lobby WebSocket protocol.
//!
//! Connects to `wss://ws.faforever.com`, performs the session handshake and
//! streams the open-games list behind the same [`LobbyPort`] the fake implements.
//! The connection lifecycle (and graceful teardown via `disconnect`) lives here;
//! the lobby service, slice and UI are unchanged.
//!
//! ## Protocol
//! First, `GET {api}/lobby/access` (bearer token) returns `{ accessUrl }`: a
//! one-time verified `wss://…/?verify=…` URL (connecting to the bare host 403s).
//! Then, newline-delimited JSON messages (the Python client uses binary frames;
//! we accept/send the same wire form), keyed by `command`:
//!
//! 1. → `ask_session { version, user_agent }`
//! 2. ← `session { session }`
//! 3. → `auth { token, unique_id, session }`
//! 4. ← `welcome { me }` (or `authentication_failed`)
//! 5. ← `game_info { … }` / `game_info { games: [ … ] }`: pushed continuously
//!
//! ## `unique_id` (anti-smurf)
//! The lobby `auth` also requires a `unique_id`: a machine fingerprint produced by
//! FAF's `faf-uid` executable (we can't reproduce its encryption, but we don't need
//! to: we run the official binary). We invoke `faf-uid <session>` and use its
//! stdout. The binary path comes from `FAF_UID_PATH`; otherwise the provider
//! searches the development/package `natives` directory and finally `PATH`.
//! The live provider is selected for normal account sessions; without a working
//! `faf-uid`, lobby auth fails and the stream ends.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_domain::state::{
    AvailableAvatar, Game, GameLaunch, HostGameConfig, MatchmakerQueue, MatchmakingState,
    PartyMember, PartyState, PlayerLobbyRating, PlayerProfile, PlayerVeto, Relation,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use crate::infra::session::TokenStore;
use crate::infra::{env_or, fetch_access_url, validated_ws_url};
use crate::ports::{LobbyPort, LobbyUpdate, ServerNoticeStyle};

const MAX_SERVER_MESSAGE_CHARS: usize = 4_000;
// Keep the protocol identifier aligned with the established FAF client
// handshake. This value is stored by the lobby and shown on player cards.
const LOBBY_USER_AGENT: &str = "faf-client";

/// Configuration for the real lobby client.
#[derive(Debug, Clone)]
pub struct LobbyConfig {
    /// Explicit WebSocket URL override (e.g. a local test server). Empty means
    /// "derive a verified URL from the API" via `/lobby/access`, which FAF prod
    /// requires: connecting to the bare `wss://…` host returns 403.
    pub ws_url: String,
    /// FAF *user* API base (`user.faforever.com`), which serves `/lobby/access`.
    /// Note this is a different host from the main `api.faforever.com`.
    pub user_api_base: String,
    /// FAF data API base (`api.faforever.com`), for querying offline accounts.
    pub api_base: String,
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
            api_base: env_or("FAF_API_BASE", "https://api.faforever.com"),
            version: env_or("FAF_CLIENT_VERSION", env!("CARGO_PKG_VERSION")),
            uid_path: env_or("FAF_UID_PATH", default_uid_path()),
        }
    }
}

fn default_uid_path() -> String {
    let executable = if cfg!(windows) {
        "faf-uid.exe"
    } else if cfg!(target_os = "macos") {
        "faf-uid-macos"
    } else {
        "faf-uid"
    };

    let mut candidates = Vec::<PathBuf>::new();
    if let Ok(current_dir) = std::env::current_dir() {
        add_uid_candidates(&mut candidates, &current_dir, executable);
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            add_uid_candidates(&mut candidates, parent, executable);
        }
    }

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| executable.to_string())
}

/// Development launches can run with `src-tauri` or `target/debug` as their
/// working directory, while the helper is prepared in the workspace-level
/// `natives/` directory. Walk ancestors so all of those layouts resolve the
/// same bundled helper; packaged builds set `FAF_UID_PATH` from Tauri resources
/// before this fallback is reached.
fn add_uid_candidates(candidates: &mut Vec<PathBuf>, root: &std::path::Path, executable: &str) {
    for directory in root.ancestors() {
        candidates.push(directory.join("natives").join(executable));
        candidates.push(directory.join(executable));
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
            http: super::http::shared_http_client(),
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

    fn join(&self, id: i32, password: Option<String>) -> bool {
        let mut frame = json!({ "command": "game_join", "uid": id, "gameport": 0 });
        if let Some(password) = password.filter(|value| !value.is_empty()) {
            frame["password"] = Value::String(password);
        }
        let sent = self.send_frame(frame);
        if !sent {
            tracing::warn!(
                game_id = id,
                "join ignored because the lobby is disconnected"
            );
        }
        sent
    }

    fn host(&self, config: HostGameConfig) {
        let mut frame = json!({
            "command": "game_host",
            "title": config.title,
            "mod": config.mod_name,
            "visibility": config.visibility,
            "mapname": config.map,
            "password": config.password.unwrap_or_default(),
        });
        if config.enforce_rating_range {
            if let Some(min) = config.rating_min {
                frame["rating_min"] = json!(min);
            }
            if let Some(max) = config.rating_max {
                frame["rating_max"] = json!(max);
            }
        }
        if !self.send_frame(frame) {
            tracing::warn!("host request ignored because the lobby is disconnected");
        }
    }

    fn matchmake(&self, queue_name: String, start: bool) {
        let state = if start { "start" } else { "stop" };
        let frame = json!({
            "command": "game_matchmaking",
            "queue_name": queue_name,
            "state": state,
        });
        if !self.send_frame(frame) {
            tracing::warn!("matchmaker request ignored because the lobby is disconnected");
        }
    }

    fn leave_party(&self) {
        let _ = self.send_frame(json!({ "command": "leave_party" }));
    }

    fn kick_party_member(&self, player_id: i32) {
        let _ = self.send_frame(json!({
            "command": "kick_player_from_party",
            "kicked_player_id": player_id,
        }));
    }

    fn invite_to_party(&self, player_id: i32) {
        let _ = self.send_frame(json!({
            "command": "invite_to_party",
            "recipient_id": player_id,
        }));
    }

    fn accept_party_invite(&self, player_id: i32) {
        let _ = self.send_frame(json!({
            "command": "accept_party_invite",
            "sender_id": player_id,
        }));
    }

    fn set_party_factions(&self, factions: Vec<String>) {
        let _ = self.send_frame(party_factions_frame(factions));
    }

    fn set_relation(&self, player_id: i32, relation: Relation, member: bool) {
        let _ = self.send_frame(relation_frame(player_id, relation, member));
    }

    fn set_player_vetoes(&self, vetoes: Vec<PlayerVeto>) {
        let vetoes = vetoes
            .into_iter()
            .map(|veto| {
                json!({
                    "matchmaker_queue_map_pool_id": veto.matchmaker_queue_map_pool_id,
                    "map_pool_map_version_id": veto.map_pool_map_version_id,
                    "veto_tokens_applied": veto.veto_tokens_applied,
                })
            })
            .collect::<Vec<_>>();
        let _ = self.send_frame(json!({ "command": "set_player_vetoes", "vetoes": vetoes }));
    }

    fn request_avatars(&self) -> bool {
        self.send_frame(avatar_list_frame())
    }

    fn select_avatar(&self, url: Option<String>) -> bool {
        self.send_frame(avatar_select_frame(url))
    }

    fn send_game_relay(&self, command: String, args: Vec<Value>) {
        let frame = json!({ "command": command, "target": "game", "args": args });
        if !self.send_frame(frame) {
            tracing::warn!(%command, "game relay message dropped because the lobby is disconnected");
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
        tracing::warn!("lobby connection skipped because there is no access token");
        return; // not logged in: nothing to authenticate with
    };

    // Resolve the WebSocket URL. FAF prod requires a verified URL obtained from
    // the API (the bare host 403s); an explicit FAF_LOBBY_URL bypasses that.
    let ws_url = if config.ws_url.is_empty() {
        match fetch_access_url(&http, &config.user_api_base, "/lobby/access", &access_token).await {
            Ok(url) => url,
            Err(e) => {
                tracing::error!(error = %e, "could not obtain lobby access URL");
                return;
            }
        }
    } else {
        config.ws_url.clone()
    };
    // The server returns "wss://host?verify=…" with no path, which some clients
    // reject with 400. Insert the missing "/" (mirrors the reference client).
    let ws_url = match validated_ws_url(&ws_url) {
        Ok(url) => url,
        Err(error) => {
            tracing::error!(%error, "lobby access service returned an unsafe URL");
            return;
        }
    };

    // Note: ws_url carries a one-time verify token: never log it verbatim.
    let ws = match tokio_tungstenite::connect_async(ws_url.as_str()).await {
        Ok((ws, _)) => ws,
        Err(e) => {
            tracing::error!(error = %e, "could not open lobby WebSocket");
            return;
        }
    };
    tracing::info!("lobby WebSocket connected");
    let (mut write, mut read) = ws.split();

    // 1. Ask for a session.
    let ask = json!({
        "command": "ask_session",
        "version": config.version,
        "user_agent": LOBBY_USER_AGENT,
    });
    if write
        .send(Message::binary(encode_lobby_message(&ask).into_bytes()))
        .await
        .is_err()
    {
        tracing::error!("failed to request a lobby session");
        return;
    }

    let mut games = GameSet::default();
    // `game_info` carries team membership, while the actual player ratings
    // arrive separately in `player_info`. Keep the latest displayed global
    // rating by login so game rows can mirror the reference clients' live
    // average-rating column.
    let mut player_ratings = BTreeMap::<String, i32>::new();
    // Identity (rather than rating) side of the same `player_info` stream,
    // what chat needs to rank its roster. See `PlayerDirectory`.
    let mut directory = PlayerDirectory::default();
    let mut matchmaking = MatchmakingState::Idle;
    // The machine proof is computed off this loop. `faf-uid` needs seconds on a
    // cold first run (15s measured on a freshly installed client, ~2.4s warm),
    // and awaiting it inline left the connection unable to answer the server's
    // keepalive for that entire window. The server dropped us, and the client
    // only read the rejection once the helper returned: hence a "command
    // rejected" error timestamped seconds after the command it blamed.
    let (proof_tx, mut proof_rx) = mpsc::channel::<Result<String, String>>(1);
    // The session id the pending proof was computed for, sent back in `auth`.
    let mut session_id = String::new();
    // Gates client→server frames. The lobby only tolerates the handshake before
    // authentication and aborts the connection on anything else, so queued
    // frames wait in `outgoing` until `welcome` rather than racing `auth`.
    let mut authenticated = false;
    'connection: loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = write.send(Message::Close(None)).await;
                break;
            }
            // Client→server frames (e.g. game_join from `join`). `None` means the
            // sender was dropped by `disconnect`: tear down gracefully. Disabled
            // until `welcome`: see `authenticated`.
            frame = outgoing.recv(), if authenticated => {
                let Some(frame) = frame else {
                    let _ = write.send(Message::Close(None)).await;
                    break;
                };
                if write
                    .send(Message::binary(encode_lobby_message(&frame).into_bytes()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            // The machine proof finished: authenticate. A branch of its own so
            // the seconds it takes cost the connection nothing.
            proof = proof_rx.recv() => {
                let Some(proof) = proof else { break 'connection };
                let unique_id = match proof {
                    Ok(uid) => uid,
                    Err(e) => {
                        // Can't authenticate: end the stream (service emits
                        // Disconnected). Surfaced for the dev console.
                        tracing::error!(error = %e, "machine proof generation failed");
                        break 'connection;
                    }
                };
                let auth = json!({
                    "command": "auth",
                    "token": access_token,
                    "unique_id": unique_id,
                    "session": session_id,
                });
                if write
                    .send(Message::binary(encode_lobby_message(&auth).into_bytes()))
                    .await
                    .is_err()
                {
                    break 'connection;
                }
            }
            incoming = read.next() => {
                let Some(Ok(message)) = incoming else { break 'connection };
                let Some(values) = decode_lobby_messages(message) else { break 'connection };
                'message: for value in values {

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
                        break 'connection;
                    }
                    continue 'message;
                }

                match command_of(&value) {
                    "ping" => {
                        let pong = json!({ "command": "pong" });
                        if write
                            .send(Message::binary(encode_lobby_message(&pong).into_bytes()))
                            .await
                            .is_err()
                        {
                            break 'connection;
                        }
                    }
                    "session" => {
                        // Start the machine fingerprint; `auth` goes out from the
                        // proof branch below once the helper returns, so this loop
                        // keeps serving the socket in the meantime.
                        tracing::debug!("lobby session received; generating machine proof");
                        let session = value.get("session").cloned().unwrap_or(Value::Null);
                        // The Python client normalizes the server's numeric
                        // session id to a string before sending `auth`.
                        session_id = session_to_string(&session);
                        let proof_tx = proof_tx.clone();
                        let uid_path = config.uid_path.clone();
                        let session_arg = session_id.clone();
                        tokio::spawn(async move {
                            let proof = generate_unique_id(&uid_path, &session_arg).await;
                            let _ = proof_tx.send(proof).await;
                        });
                    }
                    "authentication_failed" => {
                        let reason = server_text(
                            &value,
                            "The lobby server rejected authentication.",
                        );
                        tracing::error!(%reason, "lobby authentication failed");
                        let _ = tx.send(LobbyUpdate::ConnectionRejected { reason }).await;
                        break 'connection;
                    }
                    "welcome" => {
                        tracing::info!("lobby authenticated");
                        authenticated = true;
                        if tx.send(LobbyUpdate::Authenticated).await.is_err() {
                            break 'connection;
                        }
                        if let Some(player) = value.get("me") {
                            update_player_ratings(&mut player_ratings, player);
                            if let Some(profile) = directory.observe(player) {
                                if tx.send(LobbyUpdate::PlayersSeen(vec![profile])).await.is_err() {
                                    break 'connection;
                                }
                            }
                        }
                        let _ = write
                            .send(Message::binary(
                                encode_lobby_message(&json!({ "command": "matchmaker_info" }))
                                    .into_bytes(),
                            ))
                            .await;
                    }
                    "player_info" => {
                        if let Some(players) = value.get("players").and_then(Value::as_array) {
                            let mut newly_seen = Vec::new();
                            let mut removed = Vec::new();
                            for player in players {
                                if player.get("state").and_then(Value::as_str) == Some("offline") {
                                    if let Some(profile) = directory.remove(player) {
                                        player_ratings.remove(&profile.login);
                                        removed.push(profile);
                                    }
                                    continue;
                                }
                                update_player_ratings(&mut player_ratings, player);
                                if let Some(profile) = directory.observe(player) {
                                    newly_seen.push(profile);
                                }
                            }
                            if !removed.is_empty()
                                && tx.send(LobbyUpdate::PlayersRemoved(removed)).await.is_err()
                            {
                                break 'connection;
                            }
                            if !newly_seen.is_empty() {
                                if tx.send(LobbyUpdate::PlayersSeen(newly_seen)).await.is_err() {
                                    break 'connection;
                                }
                                // Newly named accounts may be the friends whose
                                // ids we couldn't resolve when `social` arrived.
                                if directory.has_relations() {
                                    let (friends, foes) = directory.relations();
                                    if tx
                                        .send(LobbyUpdate::Relations { friends, foes })
                                        .await
                                        .is_err()
                                    {
                                        break 'connection;
                                    }
                                }
                            }
                            games.refresh_ratings(&player_ratings);
                            if tx.send(LobbyUpdate::Games(games.snapshot())).await.is_err() {
                                break 'connection;
                            }
                            if tx
                                .send(LobbyUpdate::LiveGames(games.snapshot_live()))
                                .await
                                .is_err()
                            {
                                break 'connection;
                            }
                        }
                    }
                    "notice" => {
                        let (style, text) = parse_server_notice(&value);
                        tracing::info!(?style, %text, "lobby notice received");
                        if tx.send(LobbyUpdate::Notice { style, text }).await.is_err() {
                            break 'connection;
                        }
                    }
                    "invalid" => {
                        let reason = server_text(
                            &value,
                            "The lobby server rejected an invalid client command.",
                        );
                        // FAF sends a bare `{"command": "invalid"}`, so `reason`
                        // is usually the fallback above and names nothing. Log the
                        // frame too: without it a field report cannot tell a
                        // malformed command from an abort we were too slow to stop.
                        tracing::error!(%reason, frame = %value, "lobby protocol command rejected");
                        let _ = tx.send(LobbyUpdate::ConnectionRejected { reason }).await;
                        break 'connection;
                    }
                    "game_info" => {
                        for raw in extract_raw_games(&value) {
                            games.apply(raw, &player_ratings);
                        }
                        if tx.send(LobbyUpdate::Games(games.snapshot())).await.is_err() {
                            break 'connection; // consumer gone
                        }
                        if tx
                            .send(LobbyUpdate::LiveGames(games.snapshot_live()))
                            .await
                            .is_err()
                        {
                            break 'connection;
                        }
                    }
                    "game_launch" => {
                        match parse_game_launch(&value) {
                            Some(launch) => {
                                tracing::info!(game_id = launch.uid, "lobby issued game launch");
                                if launch.game_type.eq_ignore_ascii_case("matchmaker") {
                                    if let Some(queue_name) =
                                        matchmaking.matched_queue().map(str::to_owned)
                                    {
                                        matchmaking = MatchmakingState::Launching { queue_name };
                                        if tx
                                            .send(LobbyUpdate::Matchmaking(matchmaking.clone()))
                                            .await
                                            .is_err()
                                        {
                                            break 'connection;
                                        }
                                    }
                                }
                                if tx.send(LobbyUpdate::Launch(launch)).await.is_err() {
                                    break 'connection;
                                }
                            }
                            None => tracing::warn!("game launch message was missing required fields"),
                        }
                    }
                    "game_join_failed" => {
                        let id = value.get("uid").and_then(Value::as_i64).unwrap_or(0) as i32;
                        let reason = value
                            .get("reason")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .to_string();
                        tracing::warn!(game_id = id, %reason, "game join rejected");
                        if tx
                            .send(LobbyUpdate::JoinFailed { id, reason })
                            .await
                            .is_err()
                        {
                            break 'connection;
                        }
                    }
                    "matchmaker_info" => {
                        let queues = parse_matchmaker_queues(&value);
                        if tx.send(LobbyUpdate::MatchmakerQueues(queues)).await.is_err() {
                            break 'connection;
                        }
                    }
                    "search_info" => {
                        let queue_name = value
                            .get("queue_name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let searching = value.get("state").and_then(Value::as_str) == Some("start");
                        matchmaking.update_search(queue_name, searching);
                        if tx
                            .send(LobbyUpdate::Matchmaking(matchmaking.clone()))
                            .await
                            .is_err()
                        {
                            break 'connection;
                        }
                    }
                    "match_found" => {
                        let queue_name = value
                            .get("queue_name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        matchmaking = MatchmakingState::MatchFound { queue_name };
                        if tx
                            .send(LobbyUpdate::Matchmaking(matchmaking.clone()))
                            .await
                            .is_err()
                        {
                            break 'connection;
                        }
                        let _ = write
                            .send(Message::binary(
                                encode_lobby_message(&json!({ "command": "match_ready" }))
                                    .into_bytes(),
                            ))
                            .await;
                    }
                    "match_cancelled" => {
                        matchmaking = MatchmakingState::Cancelled {
                            queue_name: matchmaking.matched_queue().map(str::to_owned),
                        };
                        if tx
                            .send(LobbyUpdate::Matchmaking(matchmaking.clone()))
                            .await
                            .is_err()
                        {
                            break 'connection;
                        }
                    }
                    "update_party" => {
                        if tx.send(LobbyUpdate::Party(parse_party(&value))).await.is_err() {
                            break 'connection;
                        }
                    }
                    "party_invite" => {
                        let player_id = value
                            .get("sender")
                            .or_else(|| value.get("sender_id"))
                            .and_then(|id| id.as_i64().or_else(|| id.as_str()?.parse().ok()))
                            .unwrap_or_default() as i32;
                        if player_id > 0 {
                            let login = directory
                                .login(player_id)
                                .unwrap_or_else(|| format!("Player {player_id}"));
                            if tx
                                .send(LobbyUpdate::PartyInvite { player_id, login })
                                .await
                                .is_err()
                            {
                                break 'connection;
                            }
                        }
                    }
                    "kicked_from_party" => {
                        match tx.send(LobbyUpdate::Party(PartyState::default())).await {
                            Ok(()) => {}
                            Err(_) => break 'connection,
                        }
                    }
                    "vetoes_info" => {
                        match tx.send(LobbyUpdate::Vetoes(parse_vetoes(&value))).await {
                            Ok(()) => {}
                            Err(_) => break 'connection,
                        }
                    }
                    "social" => {
                        directory.set_relations(&value);
                        let missing_ids = directory.unresolved_relation_ids();
                        if !missing_ids.is_empty() {
                            if let Ok(resolved) = fetch_player_logins(
                                &http,
                                &config.api_base,
                                Some(&access_token),
                                &missing_ids,
                            )
                            .await
                            {
                                for (id, login) in resolved {
                                    directory.record_login(id, login);
                                }
                            }
                        }
                        let (friends, foes) = directory.relations();
                        if tx
                            .send(LobbyUpdate::Relations { friends, foes })
                            .await
                            .is_err()
                        {
                            break 'connection;
                        }
                        // The same message assigns this account's channels
                        // (language, clan). Both reference clients take their
                        // auto-join list from here rather than deriving it.
                        if tx
                            .send(LobbyUpdate::AutoJoinChannels(parse_autojoin(&value)))
                            .await
                            .is_err()
                        {
                            break 'connection;
                        }
                    }
                    "avatar" => {
                        match tx
                            .send(LobbyUpdate::Avatars(parse_available_avatars(&value)))
                            .await
                        {
                            Ok(()) => {}
                            Err(_) => break 'connection,
                        }
                    }
                    _ => {} // player_info variants without ratings, …
                }
                }
            }
        }
    }
    tracing::info!("lobby connection closed");
}

fn command_of(value: &Value) -> &str {
    value.get("command").and_then(Value::as_str).unwrap_or("")
}

fn server_text(value: &Value, fallback: &str) -> String {
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or(fallback);
    text.chars().take(MAX_SERVER_MESSAGE_CHARS).collect()
}

fn parse_server_notice(value: &Value) -> (ServerNoticeStyle, String) {
    let style = match value.get("style").and_then(Value::as_str) {
        Some("warning" | "warn") => ServerNoticeStyle::Warning,
        Some("error") => ServerNoticeStyle::Error,
        Some("kill") => ServerNoticeStyle::Kill,
        Some("kick") => ServerNoticeStyle::Kick,
        _ => ServerNoticeStyle::Info,
    };
    (style, server_text(value, "The lobby server sent a notice."))
}

fn avatar_list_frame() -> Value {
    json!({ "command": "avatar", "action": "list_avatar" })
}

fn avatar_select_frame(url: Option<String>) -> Value {
    json!({ "command": "avatar", "action": "select", "avatar": url })
}

fn parse_available_avatars(message: &Value) -> Vec<AvailableAvatar> {
    let avatars = message
        .get("avatarlist")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            let url = value.get("url")?.as_str()?.trim();
            if url.is_empty() {
                return None;
            }
            Some(AvailableAvatar {
                url: url.to_string(),
                tooltip: value
                    .get("tooltip")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
            })
        })
        .take(500)
        .collect::<Vec<_>>();
    let mut by_url = BTreeMap::new();
    for avatar in avatars {
        by_url.entry(avatar.url.clone()).or_insert(avatar);
    }
    let mut avatars = by_url.into_values().collect::<Vec<_>>();
    avatars.sort_by(|left, right| {
        left.tooltip
            .to_lowercase()
            .cmp(&right.tooltip.to_lowercase())
            .then_with(|| left.url.cmp(&right.url))
    });
    avatars
}

/// The FAF lobby transport is newline-delimited JSON, including for WebSocket
/// text frames. The Python client appends this delimiter before every send and
/// the Java client uses a line encoder; keep the same wire contract here.
fn encode_lobby_message(value: &Value) -> String {
    format!("{value}\n")
}

/// Decode the lobby's newline-delimited JSON transport. The reference clients
/// accept both text and binary WebSocket frames, and a frame may contain more
/// than one JSON object; accepting both here prevents a valid game snapshot
/// from being silently discarded.
fn decode_lobby_messages(message: Message) -> Option<Vec<Value>> {
    let text = match message {
        Message::Text(text) => text.to_string(),
        Message::Binary(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Message::Close(_) => return None,
        _ => return Some(Vec::new()),
    };

    Some(
        serde_json::Deserializer::from_str(&text)
            .into_iter::<Value>()
            .filter_map(Result::ok)
            .collect(),
    )
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

/// Run `faf-uid <session>` and return its stdout: the `unique_id` blob. Errors
/// if the binary is missing, exits non-zero, or produces nothing.
async fn generate_unique_id(uid_path: &str, session: &str) -> Result<String, String> {
    let output = tokio::process::Command::new(uid_path)
        .arg(session)
        .output()
        .await
        .map_err(|e| format!("could not start machine proof helper: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "machine proof helper exited with {}",
            output.status
        ));
    }

    let uid = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if uid.is_empty() {
        return Err("machine proof helper produced no output".into());
    }
    Ok(uid)
}

/// One game as it arrives in a `game_info` message. Only the fields we surface.
#[derive(Debug, Clone, Deserialize)]
struct RawGame {
    /// Some lobby payloads omit optional fields or send them as JSON `null`.
    /// Keep the wire model permissive and apply the client defaults in
    /// `into_game` instead of dropping the complete game from the snapshot.
    uid: Option<i32>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    num_players: Option<i32>,
    #[serde(default)]
    max_players: Option<i32>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    mapname: Option<String>,
    #[serde(default)]
    featured_mod: Option<String>,
    #[serde(default)]
    average_rating: Option<f64>,
    #[serde(default)]
    password_protected: Option<bool>,
    #[serde(default)]
    visibility: Option<String>,
    #[serde(default)]
    game_type: Option<String>,
    #[serde(default)]
    launched_at: Option<f64>,
    #[serde(default)]
    hosted_at: Option<String>,
    #[serde(default)]
    rating_min: Option<f64>,
    #[serde(default)]
    rating_max: Option<f64>,
    #[serde(default)]
    teams: Option<std::collections::BTreeMap<String, Vec<String>>>,
    #[serde(default)]
    sim_mods: Option<std::collections::BTreeMap<String, String>>,
}

impl RawGame {
    /// Only games still open for joining belong in the list.
    fn is_open(&self) -> bool {
        self.state.as_deref() == Some("open")
    }

    /// Games actively in progress: not joinable, but watchable live.
    fn is_playing(&self) -> bool {
        self.state.as_deref() == Some("playing")
    }

    fn into_game(self, player_ratings: &BTreeMap<String, i32>) -> Option<Game> {
        let id = self.uid?;
        let average_rating = average_game_rating(self.teams.as_ref(), player_ratings);
        Some(Game {
            id,
            title: self.title.unwrap_or_default(),
            host: self.host.unwrap_or_default(),
            players: self.num_players.unwrap_or_default(),
            max_players: self.max_players.unwrap_or_default(),
            map: self.mapname.unwrap_or_default(),
            mod_name: self.featured_mod.unwrap_or_else(|| "faf".into()),
            average_rating: self
                .average_rating
                .map(|value| value.round() as i32)
                .filter(|value| *value > 0)
                .unwrap_or(average_rating),
            password_protected: self.password_protected.unwrap_or(false),
            visibility: self.visibility.unwrap_or_else(|| "public".into()),
            game_type: self.game_type.unwrap_or_else(|| "custom".into()),
            launched_at: self.launched_at.map(|value| value.round() as u32),
            hosted_at: self.hosted_at,
            rating_min: self.rating_min.map(|value| value.round() as i32),
            rating_max: self.rating_max.map(|value| value.round() as i32),
            teams: self.teams.unwrap_or_default(),
            sim_mods: self.sim_mods.unwrap_or_default(),
        })
    }
}

/// Compute the displayed global rating for a game from its active team
/// members. Observers (`-1`/`null`) are intentionally excluded, matching both
/// reference clients. A server-provided `average_rating` remains authoritative
/// when present; this is the fallback used by current lobby payloads.
fn average_game_rating(
    teams: Option<&BTreeMap<String, Vec<String>>>,
    player_ratings: &BTreeMap<String, i32>,
) -> i32 {
    let ratings = teams
        .into_iter()
        .flatten()
        .filter(|(team, _)| team.as_str() != "-1" && team.as_str() != "null")
        .flat_map(|(_, players)| players.iter())
        .filter_map(|login| player_ratings.get(login).copied())
        .collect::<Vec<_>>();

    if ratings.is_empty() {
        0
    } else {
        ratings.iter().sum::<i32>() / ratings.len() as i32
    }
}

/// Store the conservative displayed global rating from a lobby `player_info`
/// entry. FAF sends TrueSkill `[mean, deviation]`; the displayed value is
/// `max(0, mean - 3 * deviation)`, as implemented by the Python client.
/// Read the channel list out of a `social` message.
///
/// The server has used both `autojoin` and `channels` for this field, so both
/// are accepted; the Java client reads `channels` while the Python client reads
/// `autojoin`. Names arrive without the `#` prefix, which the domain adds when
/// it normalizes them.
fn parse_autojoin(value: &Value) -> Vec<String> {
    value
        .get("autojoin")
        .or_else(|| value.get("channels"))
        .and_then(Value::as_array)
        .map(|channels| {
            channels
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// Build the `social_add`/`social_remove` frame:
/// `{"command": "social_add"|"social_remove", "friend"|"foe": <id>}`. Verified
/// against both reference clients (`py-client`'s `IrcRelationController` and
/// the Java client's `ServerAccessorTest`).
fn relation_frame(player_id: i32, relation: Relation, member: bool) -> Value {
    let command = if member {
        "social_add"
    } else {
        "social_remove"
    };
    let key = match relation {
        Relation::Friend => "friend",
        Relation::Foe => "foe",
    };
    json!({ "command": command, key: player_id })
}

fn party_factions_frame(factions: Vec<String>) -> Value {
    let factions = factions
        .into_iter()
        .map(|faction| faction.to_ascii_lowercase())
        .collect::<Vec<_>>();
    json!({
        "command": "set_party_factions",
        "factions": factions,
    })
}

/// Tracks who's who, so the chat roster can tell a FAF account from an
/// IRC-only nickname and can rank friends above strangers.
///
/// The lobby announces relations (`social`) as account *ids* but announces
/// identities (`player_info`) separately, and in either order: so this keeps
/// the raw ids and re-resolves them each time the directory grows. Both
/// reference clients do the same join; the Java client's `PlayerService` is
/// this map under another name.
#[derive(Debug, Default)]
struct PlayerDirectory {
    /// Last known account name by stable player id. Unlike `profiles`, this is
    /// deliberately retained while a player is offline: social relation
    /// payloads contain ids, so forgetting the name would make an unrelated
    /// later player update silently drop offline friends from the social list.
    logins: BTreeMap<i64, String>,
    profiles: BTreeMap<i64, PlayerProfile>,
    friend_ids: Vec<i64>,
    foe_ids: Vec<i64>,
}

impl PlayerDirectory {
    fn login(&self, id: i32) -> Option<String> {
        self.logins.get(&(id as i64)).cloned()
    }

    /// Remove an authoritative offline entry, returning the last full profile.
    /// Repeated/unknown offline messages are no-ops, which prevents duplicate
    /// notifications and mirrors both reference clients' player maps.
    fn remove(&mut self, player: &Value) -> Option<PlayerProfile> {
        let id = player.get("id").and_then(Value::as_i64)?;
        if let Some(login) = player
            .get("login")
            .or_else(|| player.get("name"))
            .and_then(Value::as_str)
            .filter(|login| !login.is_empty())
        {
            self.logins.insert(id, login.to_string());
        }
        self.profiles.remove(&id)
    }

    /// Record one `player_info`/`me` entry. Returns the profile only when it is
    /// new or has actually changed, so a `player_info` that repeats what we
    /// already know costs nothing on the update stream: this arrives for every
    /// online player at login and then continuously.
    fn observe(&mut self, player: &Value) -> Option<PlayerProfile> {
        let login = player
            .get("login")
            .or_else(|| player.get("name"))
            .and_then(Value::as_str)
            .filter(|login| !login.is_empty())?
            .to_string();
        let id = player.get("id").and_then(Value::as_i64)?;
        self.logins.insert(id, login.clone());

        let string_field = |key: &str| {
            player
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        // `avatar` is `{"url": …, "tooltip": …}` when set, and `null` otherwise.
        let avatar = player.get("avatar");
        let avatar_field = |key: &str| {
            avatar
                .and_then(|a| a.get(key))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };

        let known = self.profiles.get(&id);
        let ratings = player_lobby_ratings(player)
            .or_else(|| known.map(|profile| profile.ratings.clone()))
            .unwrap_or_else(|| {
                player
                    .get("global_rating")
                    .and_then(value_as_f64)
                    .map(|rating| {
                        vec![PlayerLobbyRating {
                            leaderboard: "global".into(),
                            rating: rating.max(0.0).round() as i32,
                            mean: rating.round() as i32,
                            deviation: 0,
                            games_played: 0,
                        }]
                    })
                    .unwrap_or_default()
            });

        let profile = PlayerProfile {
            // Ids are database serials, comfortably inside i32 (see `Player`).
            id: id as i32,
            login,
            // Some incremental `player_info` variants omit ratings. Preserve
            // the last known estimate instead of making the UI flash unrated.
            global_rating: player_rating_estimate(player)
                .or_else(|| known.map(|profile| profile.global_rating))
                .unwrap_or_default(),
            ratings,
            // Flag filenames are lowercase; normalise here so the UI doesn't
            // have to care that the server sends "DE".
            country: string_field("country").to_lowercase(),
            clan: string_field("clan"),
            avatar_url: avatar_field("url"),
            avatar_tooltip: avatar_field("tooltip"),
        };

        match self.profiles.get(&id) {
            Some(known) if *known == profile => None,
            _ => {
                self.profiles.insert(id, profile.clone());
                Some(profile)
            }
        }
    }

    fn set_relations(&mut self, value: &Value) {
        self.friend_ids = id_list(value, "friends");
        self.foe_ids = id_list(value, "foes");
    }

    fn unresolved_relation_ids(&self) -> Vec<i64> {
        let mut missing = Vec::new();
        for &id in self.friend_ids.iter().chain(self.foe_ids.iter()) {
            if !self.logins.contains_key(&id) && !missing.contains(&id) {
                missing.push(id);
            }
        }
        missing
    }

    fn record_login(&mut self, id: i64, login: String) {
        self.logins.insert(id, login);
    }

    fn has_relations(&self) -> bool {
        !self.friend_ids.is_empty() || !self.foe_ids.is_empty()
    }

    /// Relations as logins, dropping ids we have never been able to name,
    /// they resolve on a later `player_info`, which re-emits. Known identities
    /// survive an offline transition even though their online profile does not.
    fn relations(&self) -> (Vec<String>, Vec<String>) {
        let resolve = |ids: &Vec<i64>| {
            ids.iter()
                .filter_map(|id| self.logins.get(id).cloned())
                .collect()
        };
        (resolve(&self.friend_ids), resolve(&self.foe_ids))
    }
}

/// Fetch usernames for player IDs from the FAF API so offline friends and foes
/// are resolved by name.
async fn fetch_player_logins(
    http: &reqwest::Client,
    api_base: &str,
    token: Option<&str>,
    ids: &[i64],
) -> Result<Vec<(i64, String)>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut results = Vec::new();
    for chunk in ids.chunks(100) {
        let id_str = chunk
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let filter = format!("id=in=({id_str})");
        let mut url =
            match url::Url::parse(&format!("{}/data/player", api_base.trim_end_matches('/'))) {
                Ok(url) => url,
                Err(e) => return Err(format!("invalid player URL: {e}")),
            };
        url.query_pairs_mut()
            .append_pair("filter", &filter)
            .append_pair("fields[player]", "login")
            .append_pair("page[size]", &chunk.len().to_string());

        let mut request = http.get(url);
        if let Some(tok) = token.filter(|t| !t.is_empty()) {
            request = request.bearer_auth(tok);
        }
        let response = match request.send().await {
            Ok(res) => res,
            Err(e) => return Err(format!("player query failed: {e}")),
        };
        if !response.status().is_success() {
            continue;
        }
        let doc: Value = match response.json().await {
            Ok(doc) => doc,
            Err(_) => continue,
        };
        if let Some(data) = doc.get("data").and_then(Value::as_array) {
            for item in data {
                let id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(|s| s.parse::<i64>().ok());
                let login = item
                    .get("attributes")
                    .and_then(|a| a.get("login"))
                    .and_then(Value::as_str);
                if let (Some(id), Some(login)) = (id, login) {
                    if !login.is_empty() {
                        results.push((id, login.to_string()));
                    }
                }
            }
        }
    }
    Ok(results)
}

/// The lobby sends relation ids as numbers, but has historically sent them as
/// strings too; accept both rather than silently losing a friends list.
fn id_list(value: &Value, key: &str) -> Vec<i64> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_i64().or_else(|| id.as_str()?.parse().ok()))
                .collect()
        })
        .unwrap_or_default()
}

fn update_player_ratings(ratings: &mut BTreeMap<String, i32>, player: &Value) {
    let Some(login) = player
        .get("login")
        .or_else(|| player.get("name"))
        .and_then(Value::as_str)
        .filter(|login| !login.is_empty())
    else {
        return;
    };

    if let Some(estimate) = player_rating_estimate(player) {
        ratings.insert(login.to_string(), estimate);
    }
}

fn player_rating_estimate(player: &Value) -> Option<i32> {
    player
        .get("ratings")
        .and_then(|all| all.get("global"))
        .and_then(|global| global.get("rating"))
        .and_then(Value::as_array)
        .and_then(|rating| {
            let mean = rating.first().and_then(Value::as_f64)?;
            let deviation = rating.get(1).and_then(Value::as_f64)?;
            Some((mean - 3.0 * deviation).max(0.0).floor() as i32)
        })
        .or_else(|| {
            player
                .get("global_rating")
                .and_then(value_as_f64)
                .map(|value| value.max(0.0).round() as i32)
        })
}

/// Preserve every rating queue from the live player directory for cheap UI
/// summaries. `None` means this was a partial update with no ratings field;
/// `Some([])` means the server explicitly supplied an empty rating map.
fn player_lobby_ratings(player: &Value) -> Option<Vec<PlayerLobbyRating>> {
    let ratings = player.get("ratings")?.as_object()?;
    let mut summaries = ratings
        .iter()
        .filter_map(|(leaderboard, entry)| {
            let rating = entry.get("rating")?.as_array()?;
            let mean = rating.first().and_then(Value::as_f64)?;
            let deviation = rating.get(1).and_then(Value::as_f64)?;
            let games_played = entry
                .get("number_of_games")
                .and_then(|value| {
                    value
                        .as_i64()
                        .or_else(|| value.as_str()?.parse::<i64>().ok())
                })
                .and_then(|value| i32::try_from(value).ok())
                .unwrap_or_default()
                .max(0);
            Some(PlayerLobbyRating {
                leaderboard: leaderboard.clone(),
                rating: (mean - 3.0 * deviation).max(0.0).floor() as i32,
                mean: mean.round() as i32,
                deviation: deviation.round() as i32,
                games_played,
            })
        })
        .collect::<Vec<_>>();
    summaries.sort_by(|left, right| left.leaderboard.cmp(&right.leaderboard));
    Some(summaries)
}

fn value_as_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse::<f64>().ok())
}

fn parse_matchmaker_queues(message: &Value) -> Vec<MatchmakerQueue> {
    message
        .get("queues")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|queue| MatchmakerQueue {
            queue_name: queue
                .get("queue_name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            team_size: queue.get("team_size").and_then(Value::as_i64).unwrap_or(1) as i32,
            num_players: queue
                .get("num_players")
                .and_then(Value::as_i64)
                .unwrap_or(0) as i32,
            queue_pop_time_seconds: queue
                .get("queue_pop_time_delta")
                .and_then(Value::as_f64)
                .unwrap_or_default()
                .round() as i32,
        })
        .filter(|queue| !queue.queue_name.is_empty())
        .collect()
}

fn parse_party(message: &Value) -> PartyState {
    let owner_id = message
        .get("owner")
        .and_then(Value::as_i64)
        .map(|id| id as i32);
    let members = message
        .get("members")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|member| {
            let player_id = member.get("player")?.as_i64()? as i32;
            let factions = member
                .get("factions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            Some(PartyMember {
                player_id,
                name: member
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("Player {player_id}")),
                factions,
            })
        })
        .collect();
    PartyState { owner_id, members }
}

fn parse_vetoes(message: &Value) -> Vec<PlayerVeto> {
    message
        .get("vetoes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|veto| {
            Some(PlayerVeto {
                matchmaker_queue_map_pool_id: veto.get("matchmaker_queue_map_pool_id")?.as_i64()?
                    as i32,
                map_pool_map_version_id: veto.get("map_pool_map_version_id")?.as_i64()? as i32,
                veto_tokens_applied: veto.get("veto_tokens_applied")?.as_i64()? as i32,
            })
        })
        .collect()
}

/// A `game_info` message is either a single game or a batch under `games`.
fn extract_raw_games(message: &Value) -> Vec<RawGame> {
    if let Some(array) = message.get("games").and_then(Value::as_array) {
        array
            .iter()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect()
    } else {
        serde_json::from_value(message.clone())
            .into_iter()
            .collect()
    }
}

/// A `game_launch` message: the server's order to start a game. `args` arrives as
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
    expected_players: Option<i32>,
    #[serde(default)]
    team: Option<i32>,
    #[serde(default)]
    faction: Option<i32>,
    #[serde(default)]
    map_position: Option<i32>,
    #[serde(default)]
    game_options: std::collections::BTreeMap<String, Value>,
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
            expected_players: self.expected_players,
            team: self.team,
            faction: self.faction,
            map_position: self.map_position,
            game_options: self
                .game_options
                .into_iter()
                .map(|(name, value)| (name, value_to_arg(&value)))
                .collect(),
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

/// The aggregated game lists, split into "open" (joinable) and "playing"
/// (watchable live). Keyed by id so updates replace in place and games that
/// leave a state are removed from it; snapshots are ordered by id for stable
/// rendering. A game moves between the two sets as its state changes (e.g.
/// `open` → `playing` when it launches).
#[derive(Debug, Default)]
struct GameSet {
    games: BTreeMap<i32, Game>,
    live_games: BTreeMap<i32, Game>,
}

impl GameSet {
    fn apply(&mut self, raw: RawGame, player_ratings: &BTreeMap<String, i32>) {
        let Some(uid) = raw.uid else {
            return;
        };
        let (open, playing) = (raw.is_open(), raw.is_playing());
        if open {
            if let Some(game) = raw.into_game(player_ratings) {
                self.games.insert(uid, game);
            }
            self.live_games.remove(&uid);
        } else if playing {
            if let Some(game) = raw.into_game(player_ratings) {
                self.live_games.insert(uid, game);
            }
            self.games.remove(&uid);
        } else {
            self.games.remove(&uid);
            self.live_games.remove(&uid);
        }
    }

    fn refresh_ratings(&mut self, player_ratings: &BTreeMap<String, i32>) {
        for game in self.games.values_mut().chain(self.live_games.values_mut()) {
            let average = average_game_rating(Some(&game.teams), player_ratings);
            if average > 0 {
                game.average_rating = average;
            }
        }
    }

    fn snapshot(&self) -> Vec<Game> {
        self.games.values().cloned().collect()
    }

    fn snapshot_live(&self) -> Vec<Game> {
        self.live_games.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::extract_access_url;

    #[test]
    fn server_notices_preserve_actions_and_bound_untrusted_text() {
        let (style, text) = parse_server_notice(&json!({
            "style": "kill",
            "text": "  maintenance  "
        }));
        assert_eq!(style, ServerNoticeStyle::Kill);
        assert_eq!(text, "maintenance");

        let oversized = "ü".repeat(MAX_SERVER_MESSAGE_CHARS + 10);
        let (_, text) = parse_server_notice(&json!({ "style": "warning", "text": oversized }));
        assert_eq!(text.chars().count(), MAX_SERVER_MESSAGE_CHARS);
        assert!(text.is_char_boundary(text.len()));
    }

    #[test]
    fn unknown_notice_styles_are_safe_info_and_missing_text_has_context() {
        assert_eq!(
            parse_server_notice(&json!({ "style": "future-style" })),
            (
                ServerNoticeStyle::Info,
                "The lobby server sent a notice.".into()
            )
        );
        assert_eq!(
            server_text(&json!({ "text": "  " }), "fallback"),
            "fallback"
        );
    }

    #[test]
    fn directory_reports_only_profiles_that_are_new_or_changed() {
        // `player_info` repeats every online player at login and then keeps
        // arriving; re-emitting unchanged profiles would flood the UI.
        let mut directory = PlayerDirectory::default();
        assert_eq!(
            directory
                .observe(&json!({ "id": 1, "login": "Aurora" }))
                .map(|p| p.login),
            Some("Aurora".to_string())
        );
        assert_eq!(
            directory.observe(&json!({ "id": 1, "login": "Aurora" })),
            None
        );
        // A rename under the same id is a change.
        assert_eq!(
            directory
                .observe(&json!({ "id": 1, "login": "Aurora_" }))
                .map(|p| p.login),
            Some("Aurora_".to_string())
        );
        // So is gaining an avatar.
        assert_eq!(
            directory
                .observe(&json!({
                    "id": 1,
                    "login": "Aurora_",
                    "avatar": { "url": "https://x/a.png", "tooltip": "Cat" },
                }))
                .map(|p| p.avatar_url),
            Some("https://x/a.png".to_string())
        );
    }

    #[test]
    fn directory_reads_country_clan_and_avatar() {
        let mut directory = PlayerDirectory::default();
        let profile = directory
            .observe(&json!({
                "id": 7,
                "login": "Stormlord",
                // The server sends the country uppercased; flag assets are lowercase.
                "country": "DE",
                "clan": "BC",
                "avatar": { "url": "https://content/a.png", "tooltip": "Aeon" },
                "ratings": {
                    "global": { "rating": [1800, 200], "number_of_games": 374 },
                    "ladder_1v1": { "rating": [1500, 100], "number_of_games": "42" }
                },
            }))
            .unwrap();
        assert_eq!(profile.country, "de");
        assert_eq!(profile.clan, "BC");
        assert_eq!(profile.avatar_url, "https://content/a.png");
        assert_eq!(profile.avatar_tooltip, "Aeon");
        assert_eq!(profile.global_rating, 1200);
        assert_eq!(
            profile.ratings,
            vec![
                PlayerLobbyRating {
                    leaderboard: "global".into(),
                    rating: 1200,
                    mean: 1800,
                    deviation: 200,
                    games_played: 374,
                },
                PlayerLobbyRating {
                    leaderboard: "ladder_1v1".into(),
                    rating: 1200,
                    mean: 1500,
                    deviation: 100,
                    games_played: 42,
                },
            ]
        );

        assert_eq!(
            directory.observe(&json!({
                "id": 7,
                "login": "Stormlord",
                "country": "DE",
                "clan": "BC",
                "avatar": { "url": "https://content/a.png", "tooltip": "Aeon" },
            })),
            None,
            "a partial update must retain the last known rating"
        );
    }

    #[test]
    fn directory_tolerates_a_null_avatar_and_missing_country() {
        let mut directory = PlayerDirectory::default();
        let profile = directory
            .observe(&json!({ "id": 8, "login": "Aurora", "avatar": Value::Null }))
            .unwrap();
        assert_eq!(profile.country, "");
        assert_eq!(profile.clan, "");
        assert_eq!(profile.avatar_url, "");
    }

    #[test]
    fn directory_ignores_entries_without_an_id_or_login() {
        let mut directory = PlayerDirectory::default();
        assert_eq!(directory.observe(&json!({ "login": "Aurora" })), None);
        assert_eq!(directory.observe(&json!({ "id": 7 })), None);
        assert_eq!(directory.observe(&json!({ "id": 7, "login": "" })), None);
    }

    #[test]
    fn directory_offline_removal_is_authoritative_and_idempotent() {
        let mut directory = PlayerDirectory::default();
        directory.set_relations(&json!({ "friends": [7], "foes": [] }));
        directory
            .observe(&json!({ "id": 7, "login": "Aurora", "country": "DE" }))
            .unwrap();

        let removed = directory
            .remove(&json!({ "id": 7, "login": "Aurora", "state": "offline" }))
            .unwrap();
        assert_eq!(removed.login, "Aurora");
        assert_eq!(removed.country, "de");
        assert_eq!(directory.login(7).as_deref(), Some("Aurora"));
        assert_eq!(directory.relations().0, vec!["Aurora"]);
        assert!(directory
            .remove(&json!({ "id": 7, "login": "Aurora", "state": "offline" }))
            .is_none());
    }

    #[test]
    fn relation_frames_match_the_server_protocol() {
        assert_eq!(
            relation_frame(7, Relation::Friend, true),
            json!({ "command": "social_add", "friend": 7 })
        );
        assert_eq!(
            relation_frame(7, Relation::Foe, true),
            json!({ "command": "social_add", "foe": 7 })
        );
        assert_eq!(
            relation_frame(7, Relation::Friend, false),
            json!({ "command": "social_remove", "friend": 7 })
        );
        assert_eq!(
            relation_frame(7, Relation::Foe, false),
            json!({ "command": "social_remove", "foe": 7 })
        );
    }

    #[test]
    fn avatar_frames_match_the_reference_protocol() {
        assert_eq!(
            avatar_list_frame(),
            json!({ "command": "avatar", "action": "list_avatar" })
        );
        assert_eq!(
            avatar_select_frame(Some("https://content.test/a.png".into())),
            json!({
                "command": "avatar",
                "action": "select",
                "avatar": "https://content.test/a.png"
            })
        );
        assert_eq!(
            avatar_select_frame(None),
            json!({ "command": "avatar", "action": "select", "avatar": null })
        );
    }

    #[test]
    fn available_avatars_are_sanitized_deduplicated_and_sorted() {
        let avatars = parse_available_avatars(&json!({
            "command": "avatar",
            "avatarlist": [
                { "url": "https://content.test/z.png", "tooltip": "Zulu" },
                { "url": "", "tooltip": "Invalid" },
                { "url": "https://content.test/a.png", "tooltip": "Alpha" },
                { "url": "https://content.test/a.png", "tooltip": "Duplicate" }
            ]
        }));
        assert_eq!(avatars.len(), 2);
        assert_eq!(avatars[0].tooltip, "Alpha");
        assert_eq!(avatars[1].tooltip, "Zulu");
    }

    #[test]
    fn faction_frame_matches_the_server_protocol() {
        assert_eq!(
            party_factions_frame(vec!["UEF".into(), "Cybran".into()]),
            json!({
                "command": "set_party_factions",
                "factions": ["uef", "cybran"],
            })
        );
    }

    #[test]
    fn relations_resolve_ids_that_arrive_after_the_social_message() {
        // `social` routinely lands before the `player_info` naming those ids.
        let mut directory = PlayerDirectory::default();
        directory.set_relations(&json!({ "friends": [2, 3], "foes": [4] }));
        assert_eq!(directory.relations(), (vec![], vec![]));

        directory.observe(&json!({ "id": 2, "login": "Stormlord" }));
        directory.observe(&json!({ "id": 4, "login": "Griefer" }));
        assert_eq!(
            directory.relations(),
            (vec!["Stormlord".to_string()], vec!["Griefer".to_string()])
        );

        directory.observe(&json!({ "id": 3, "login": "Sheikah" }));
        assert_eq!(
            directory.relations().0,
            vec!["Stormlord".to_string(), "Sheikah".to_string()]
        );
    }

    #[test]
    fn relation_ids_are_accepted_as_numbers_or_strings() {
        let mut directory = PlayerDirectory::default();
        directory.set_relations(&json!({ "friends": [2, "3", "not-a-number"], "foes": [] }));
        directory.observe(&json!({ "id": 2, "login": "Stormlord" }));
        directory.observe(&json!({ "id": 3, "login": "Sheikah" }));
        assert_eq!(
            directory.relations().0,
            vec!["Stormlord".to_string(), "Sheikah".to_string()]
        );
    }

    #[test]
    fn a_social_message_without_relations_is_not_treated_as_having_any() {
        let mut directory = PlayerDirectory::default();
        assert!(!directory.has_relations());
        directory.set_relations(&json!({ "command": "social", "autojoin": ["#aeolus"] }));
        assert!(!directory.has_relations());
    }

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
            "launched_at": 1_700_000_000.4,
        })
    }

    #[test]
    fn parses_server_veto_allocations() {
        let vetoes = parse_vetoes(&json!({
            "vetoes": [{
                "matchmaker_queue_map_pool_id": 4,
                "map_pool_map_version_id": 91,
                "veto_tokens_applied": 2
            }]
        }));
        assert_eq!(vetoes.len(), 1);
        assert_eq!(vetoes[0].matchmaker_queue_map_pool_id, 4);
        assert_eq!(vetoes[0].map_pool_map_version_id, 91);
        assert_eq!(vetoes[0].veto_tokens_applied, 2);
    }

    #[test]
    fn extracts_single_game() {
        let raws = extract_raw_games(&open_game_json(7, "open", 3));
        assert_eq!(raws.len(), 1);
        assert_eq!(raws[0].uid, Some(7));
        assert_eq!(raws[0].num_players, Some(3));
    }

    #[test]
    fn extracts_batched_games() {
        let msg = json!({
            "command": "game_info",
            "games": [open_game_json(1, "open", 1), open_game_json(2, "open", 2)],
        });
        let raws = extract_raw_games(&msg);
        assert_eq!(raws.len(), 2);
        assert_eq!(raws[1].uid, Some(2));
    }

    #[test]
    fn raw_game_maps_to_domain_game() {
        let raw = extract_raw_games(&open_game_json(42, "open", 5))
            .pop()
            .unwrap();
        let game = raw.into_game(&BTreeMap::new()).unwrap();
        assert_eq!(game.id, 42);
        assert_eq!(game.players, 5);
        assert_eq!(game.max_players, 8);
        assert_eq!(game.map, "Theta Passage");
        assert_eq!(game.host, "Stormlord");
        assert_eq!(game.launched_at, Some(1_700_000_000));
    }

    #[test]
    fn computes_average_rating_from_player_info_and_ignores_observers() {
        let mut ratings = BTreeMap::new();
        update_player_ratings(
            &mut ratings,
            &json!({
                "login": "Alpha",
                "ratings": { "global": { "rating": [1800, 200] } }
            }),
        );
        update_player_ratings(
            &mut ratings,
            &json!({
                "login": "Bravo",
                "ratings": { "global": { "rating": [1700, 100] } }
            }),
        );
        update_player_ratings(
            &mut ratings,
            &json!({
                "login": "Spectator",
                "ratings": { "global": { "rating": [2500, 0] } }
            }),
        );

        let mut message = open_game_json(43, "open", 3);
        message["teams"] = json!({
            "1": ["Alpha"],
            "2": ["Bravo"],
            "-1": ["Spectator"]
        });
        let game = extract_raw_games(&message)
            .pop()
            .unwrap()
            .into_game(&ratings)
            .unwrap();

        // Alpha = 1200 and Bravo = 1400; observer is excluded.
        assert_eq!(game.average_rating, 1300);
    }

    #[test]
    fn accepts_legacy_player_rating_field() {
        let mut ratings = BTreeMap::new();
        update_player_ratings(
            &mut ratings,
            &json!({ "login": "Legacy", "global_rating": 1234 }),
        );
        assert_eq!(ratings.get("Legacy"), Some(&1234));
    }

    #[test]
    fn gameset_adds_open_and_removes_closed() {
        let mut set = GameSet::default();
        for raw in extract_raw_games(&open_game_json(1, "open", 1)) {
            set.apply(raw, &BTreeMap::new());
        }
        for raw in extract_raw_games(&open_game_json(2, "open", 2)) {
            set.apply(raw, &BTreeMap::new());
        }
        assert_eq!(set.snapshot().len(), 2);

        // Game 1 transitions to playing → drops out of the open list.
        for raw in extract_raw_games(&open_game_json(1, "playing", 2)) {
            set.apply(raw, &BTreeMap::new());
        }
        let snap = set.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].id, 2); // ordered by id
    }

    #[test]
    fn gameset_update_replaces_in_place() {
        let mut set = GameSet::default();
        for raw in extract_raw_games(&open_game_json(5, "open", 1)) {
            set.apply(raw, &BTreeMap::new());
        }
        for raw in extract_raw_games(&open_game_json(5, "open", 4)) {
            set.apply(raw, &BTreeMap::new());
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
            "game_type": "matchmaker",
            "rating_type": "ladder_1v1",
            "expected_players": 2,
            "team": 1,
            "faction": 3,
            "map_position": 2,
            "game_options": { "Timeouts": 3, "Share": "FullShare" },
            "args": ["/numgames", 137, "/init", true],
        });
        let launch = parse_game_launch(&msg).expect("should parse");
        assert_eq!(launch.uid, 12345);
        assert_eq!(launch.mod_name, "faf"); // `mod` renamed
        assert_eq!(launch.name, "Big Team Game");
        assert_eq!(launch.mapname, "scmp_009");
        assert_eq!(launch.game_type, "matchmaker");
        assert_eq!(launch.rating_type, "ladder_1v1");
        assert_eq!(launch.expected_players, Some(2));
        assert_eq!(launch.team, Some(1));
        assert_eq!(launch.faction, Some(3));
        assert_eq!(launch.map_position, Some(2));
        assert_eq!(
            launch.game_options.get("Timeouts").map(String::as_str),
            Some("3")
        );
        assert_eq!(
            launch.game_options.get("Share").map(String::as_str),
            Some("FullShare")
        );
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
            validated_ws_url("wss://ws.faforever.com?verify=a.b-c_d").unwrap(),
            "wss://ws.faforever.com/?verify=a.b-c_d"
        );
        // Already has a path → unchanged (no double slash, token untouched).
        assert_eq!(
            validated_ws_url("wss://ws.faforever.com/?verify=a.b-c_d").unwrap(),
            "wss://ws.faforever.com/?verify=a.b-c_d"
        );
        assert_eq!(
            validated_ws_url("wss://host/path?verify=x").unwrap(),
            "wss://host/path?verify=x"
        );
        assert_eq!(validated_ws_url("wss://host").unwrap(), "wss://host/");
        assert!(validated_ws_url("ws://remote.example/verify").is_err());
        assert!(validated_ws_url("wss://user:password@remote.example/verify").is_err());
        assert!(validated_ws_url("ws://127.0.0.1:9876/verify").is_ok());
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
    fn decodes_binary_frames_and_multiple_json_messages() {
        let first = open_game_json(1, "open", 1).to_string();
        let second = open_game_json(2, "open", 2).to_string();
        let frame = Message::Binary(format!("{first}\n{second}\n").into_bytes());

        let messages = decode_lobby_messages(frame).expect("binary frames stay usable");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].get("uid").and_then(Value::as_i64), Some(1));
        assert_eq!(messages[1].get("uid").and_then(Value::as_i64), Some(2));
    }

    #[test]
    fn encodes_outgoing_lobby_messages_with_line_delimiter() {
        let encoded = encode_lobby_message(&json!({ "command": "ask_session" }));
        assert!(encoded.ends_with('\n'));
        let decoded: Value =
            serde_json::from_str(&encoded).expect("newline is valid JSON whitespace");
        assert_eq!(command_of(&decoded), "ask_session");
    }

    #[test]
    fn missing_fields_default_gracefully() {
        let msg = json!({ "command": "game_info", "uid": 9, "state": "open" });
        let raws = extract_raw_games(&msg);
        assert_eq!(raws.len(), 1);
        let game = raws
            .into_iter()
            .next()
            .unwrap()
            .into_game(&BTreeMap::new())
            .unwrap();
        assert_eq!(game.id, 9);
        assert_eq!(game.title, "");
        assert_eq!(game.max_players, 0);
    }

    #[test]
    fn accepts_nullable_fields_from_reference_lobby_payload() {
        // The reference clients receive these fields as null for some open
        // games (notably sim_mods, visibility and game_type). A null optional
        // field must not make serde drop the entire game from the list.
        let msg = json!({
            "command": "game_info",
            "uid": 12,
            "state": "open",
            "num_players": 1,
            "max_players": 4,
            "title": "Open game",
            "host": "Commander",
            "mapname": "scmp_007",
            "featured_mod": "faf",
            "password_protected": false,
            "visibility": null,
            "game_type": null,
            "sim_mods": null,
            "teams": null,
            "rating_min": 0,
            "rating_max": 3000
        });

        let game = extract_raw_games(&msg)
            .into_iter()
            .next()
            .and_then(|raw| raw.into_game(&BTreeMap::new()))
            .expect("nullable game payload should be retained");
        assert_eq!(game.id, 12);
        assert_eq!(game.visibility, "public");
        assert_eq!(game.game_type, "custom");
        assert!(game.sim_mods.is_empty());
        assert!(game.teams.is_empty());
    }
}
