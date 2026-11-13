//! Real lobby provider: the FAF lobby WebSocket protocol.
//!
//! Connects to `wss://ws.faforever.com`, performs the session handshake and
//! streams the open-games list behind the same [`LobbyPort`] the fake implements.
//! The connection lifecycle (and graceful teardown via `disconnect`) lives here;
//! the lobby service, slice and UI are unchanged.
//!
//! The messages themselves are `faf_domain::protocol::lobby`: `ServerMessage`
//! is what arrives, read, and `ClientMessage` is what is sent. What is left
//! here is the socket, the order of the handshake, reconnecting, and what a
//! session remembers from one message to the next: who is online
//! (`PlayerDirectory`), how they are rated, and which games are open
//! (`GameSet`).
//!
//! ## Protocol
//! First, `GET {api}/lobby/access` (bearer token) returns `{ accessUrl }`: a
//! one-time verified `wss://…/?verify=…` URL (connecting to the bare host 403s).
//! Then, newline-delimited JSON messages in WebSocket text frames, keyed by
//! `command`:
//!
//! 1. → `ask_session { version, user_agent }`
//! 2. ← `session { session }`
//! 3. → `auth { token, unique_id, session }`
//! 4. ← `welcome { me }` (or `authentication_failure` / `authentication_failed`)
//! 5. ← `game_info { … }` / `game_info { games: [ … ] }`: pushed continuously
//!
//! Since 2026-10-21 the socket ends at `faf-message-broker`, not at the lobby
//! server. The broker answers steps 1 to 3 itself and relays everything else
//! over RabbitMQ; `welcome` is the lobby server's, and arrives once it has
//! picked the new session up.
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
use faf_domain::protocol::lobby::{
    average_game_rating, split_messages, ClientMessage, GameInfo, PlayerEntry, PlayerRatings,
    ServerMessage, SocialLists,
};
use faf_domain::protocol::rating::whole_points;
use faf_domain::state::{
    Game, HostGameConfig, MatchmakingState, PartyState, PlayerLobbyRating, PlayerProfile,
    PlayerVeto, Relation, GLOBAL_LEADERBOARD,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use crate::infra::session::TokenStore;
use crate::infra::{env_or, fetch_access_url, validated_ws_url};
use crate::ports::{LobbyPort, LobbySendError, LobbyUpdate};

// Protocol identifier sent in the lobby handshake. This value is stored by
// the lobby server and shown on player cards to distinguish client types.
const LOBBY_USER_AGENT: &str = "faf-rust-client";

/// Reconnect schedule, from `handle_disconnected` in the Python client's
/// `ServerConnection`: the first few attempts go out immediately, because a
/// socket that has been working and then drops is usually a blip, and only a
/// run of failures backs off. The same shape the chat client already uses.
const RECONNECT_IMMEDIATE_ATTEMPTS: u32 = 3;
const RECONNECT_BACKOFF_STEP: std::time::Duration = std::time::Duration::from_secs(10);
const RECONNECT_BACKOFF_MAX: std::time::Duration = std::time::Duration::from_secs(60);
/// Give up, and close the update stream, after this many attempts in a row
/// that never reached an authenticated session: a bad token or a real outage
/// rather than a blip, and retrying forever would hide it.
const MAX_CONSECUTIVE_FAILURES: u32 = 10;

/// How long the lobby connection may stay silent before this client pings it,
/// and how long after that ping it may stay silent before the connection is
/// treated as dead.
///
/// Ten seconds because that is `keepalive_interval` in the Python client's
/// `ServerConnection`, and the interval has to be short enough to beat the
/// shortest idle timeout a home router is likely to apply to an open flow.
const LOBBY_KEEPALIVE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);

/// How long a connection may take from an open socket to `welcome` before it
/// is given up and opened again.
///
/// The lobby server used to enforce this itself (`LOGIN_TIMEOUT`, five
/// minutes) by closing the socket. The broker has no such limit, and it keeps
/// the socket open while the lobby server behind it is down: the sign-in the
/// broker announced in that time is lost, and the lobby server, once it is
/// back, takes the session over without a `welcome`. A client that waited for
/// one then waited for good, with no lobbies to show. A fresh connection is
/// announced again, and gets one. A minute leaves room for `faf-uid`, which
/// needs fifteen seconds on a cold first run.
const SIGN_IN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

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
    for root in crate::infra::helper_search_roots() {
        candidates.push(root.join("natives").join(executable));
        candidates.push(root.join(executable));
    }

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| executable.to_string())
}

/// See where the outgoing channel is made, in [`LobbyClient::connect`].
const OUTGOING_FRAME_CAPACITY: usize = 1024;

enum Outgoing {
    Message(ClientMessage),
    ContactRelation(faf_domain::state::Contact, bool),
    /// Local lookup results, never serialized to the lobby protocol.
    ContactNames(Vec<(i64, String)>),
}

pub struct LobbyClient {
    config: LobbyConfig,
    tokens: TokenStore,
    http: reqwest::Client,
    cancel: Arc<Mutex<Option<CancellationToken>>>,
    /// Outgoing frames for the live connection. `join` pushes a `game_join` here;
    /// `run_session` drains it and writes to the socket. `None` when not connected.
    outgoing: Arc<Mutex<Option<mpsc::Sender<Outgoing>>>>,
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

    /// Push a message onto the live connection's outgoing channel. Returns
    /// `false` if there is no active connection (so callers can log).
    fn send_message(&self, message: ClientMessage) -> bool {
        self.send(Outgoing::Message(message))
    }

    fn send(&self, request: Outgoing) -> bool {
        self.try_send(request).is_ok()
    }

    fn try_send(&self, request: Outgoing) -> Result<(), LobbySendError> {
        let guard = self.outgoing.lock().unwrap();
        let Some(tx) = guard.as_ref() else {
            return Err(LobbySendError::Disconnected);
        };
        match tx.try_send(request) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(request)) => {
                // Every caller logs a `false` as "disconnected", which is not
                // what happened here, so this says what did.
                tracing::warn!(
                    command = match &request {
                        Outgoing::Message(message) => message.command(),
                        Outgoing::ContactRelation(_, _) => "social",
                        Outgoing::ContactNames(_) => "contact_names",
                    },
                    "lobby frame dropped: the outgoing queue is full"
                );
                Err(LobbySendError::Busy)
            }
            Err(mpsc::error::TrySendError::Closed(_)) => Err(LobbySendError::Disconnected),
        }
    }
}

#[async_trait]
impl LobbyPort for LobbyClient {
    async fn resolve_contacts(&self, ids: &[i32]) -> Result<(), String> {
        let outgoing = self
            .outgoing
            .lock()
            .unwrap()
            .clone()
            .ok_or("not connected")?;
        let cancel = self.cancel.lock().unwrap().clone().ok_or("not connected")?;
        let token = self.tokens.get();
        let ids: Vec<i64> = ids.iter().map(|id| i64::from(*id)).collect();
        let names = tokio::select! {
            () = cancel.cancelled() => return Err("not connected".into()),
            result = fetch_player_logins(&self.http, &self.config.api_base, token.as_deref(), &ids) => result?,
        };
        tokio::select! {
            () = cancel.cancelled() => Err("not connected".into()),
            result = outgoing.send(Outgoing::ContactNames(names)) => result.map_err(|_| "not connected".into()),
        }
    }

    async fn connect(&self) -> mpsc::Receiver<LobbyUpdate> {
        let token = CancellationToken::new();
        if let Some(prev) = self.cancel.lock().unwrap().replace(token.clone()) {
            prev.cancel();
        }

        let (tx, rx) = mpsc::channel(8);
        // Channel for client→server frames (game_join, …). The receiver is drained
        // inside `run_session`; the sender is stored so `join` can reach the socket.
        //
        // Sized for a game, not for a click. The ICE adapter's candidates and
        // the game's own `GameState` / `GameResult` reports all leave through
        // here, `try_send` drops what does not fit, and eight slots were one
        // burst of candidates away from losing `GameState Ended`, the report
        // the server ends a player's game on. Java's lobby writer queues
        // without a bound.
        let (out_tx, out_rx) = mpsc::channel::<Outgoing>(OUTGOING_FRAME_CAPACITY);
        *self.outgoing.lock().unwrap() = Some(out_tx);

        let config = self.config.clone();
        let http = self.http.clone();
        let tokens = self.tokens.clone();
        tokio::spawn(async move {
            // The reconnect loop, which is `handle_disconnected` in the Python
            // client. A dropped lobby connection used to end the client's
            // session outright and wait for the user to press connect; the
            // reference clients retry on their own, which is most of why they
            // feel steadier on a flaky line even when they drop just as often.
            //
            // Giving up drops `tx`; the receiver closes and the lobby service
            // emits `Disconnected`, exactly as it did when every drop ended
            // here.
            let mut mid_flight = out_rx;
            let mut failures = 0_u32;
            loop {
                // The token is re-read per attempt: a refresh may have landed
                // while the backoff was sleeping.
                let end = run_session(
                    config.clone(),
                    http.clone(),
                    tokens.get(),
                    tx.clone(),
                    &mut mid_flight,
                    token.clone(),
                )
                .await;

                match end {
                    SessionEnd::Cancelled | SessionEnd::Hopeless => break,
                    SessionEnd::Dropped { authenticated } => {
                        // A session that worked and then dropped starts the
                        // count again, so the next attempt is immediate. Only
                        // a run of attempts that never came up backs off.
                        failures = if authenticated { 1 } else { failures + 1 };
                    }
                }

                if failures >= MAX_CONSECUTIVE_FAILURES {
                    tracing::error!(failures, "lobby reconnect limit reached");
                    break;
                }
                // A frame was addressed to the connection that just went. A
                // `game_join` queued while the socket was dying must not be
                // replayed minutes later onto its replacement, joining a game
                // the player has long since stopped waiting for.
                while mid_flight.try_recv().is_ok() {}

                // Tell the client it is between connections. Not
                // `Disconnected`: that is the end of the session, and this is
                // the middle of one.
                if tx.send(LobbyUpdate::Reconnecting).await.is_err() {
                    break;
                }

                let delay = reconnect_delay(failures);
                if !delay.is_zero() {
                    tracing::info!(
                        delay_seconds = delay.as_secs(),
                        failures,
                        "lobby reconnect scheduled"
                    );
                }
                tokio::select! {
                    _ = token.cancelled() => break,
                    _ = tokio::time::sleep(delay) => {}
                }
            }
        });
        rx
    }

    fn join(&self, id: i32, password: Option<String>) -> bool {
        let sent = self.send_message(ClientMessage::GameJoin { uid: id, password });
        if !sent {
            tracing::warn!(
                game_id = id,
                "join ignored because the lobby is disconnected"
            );
        }
        sent
    }

    fn host(&self, config: HostGameConfig) -> Result<(), LobbySendError> {
        self.try_send(Outgoing::Message(ClientMessage::GameHost(config)))
    }

    fn matchmake(&self, queue_names: &[String], start: bool) -> Result<(), LobbySendError> {
        let outgoing = self.outgoing.lock().unwrap();
        let tx = outgoing.as_ref().ok_or(LobbySendError::Disconnected)?;
        // Reserve before sending the first frame. A saturated queue must
        // never leave the player searching only some of the requested queues.
        let permits = tx
            .try_reserve_many(queue_names.len())
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(()) => LobbySendError::Busy,
                mpsc::error::TrySendError::Closed(()) => LobbySendError::Disconnected,
            })?;
        for (permit, queue_name) in permits.zip(queue_names) {
            permit.send(Outgoing::Message(ClientMessage::GameMatchmaking {
                queue_name: queue_name.clone(),
                searching: start,
            }));
        }
        Ok(())
    }

    fn leave_party(&self) {
        let _ = self.send_message(ClientMessage::LeaveParty);
    }

    fn kick_party_member(&self, player_id: i32) {
        let _ = self.send_message(ClientMessage::KickPlayerFromParty { player_id });
    }

    fn invite_to_party(&self, player_id: i32) {
        let _ = self.send_message(ClientMessage::InviteToParty { player_id });
    }

    fn accept_party_invite(&self, player_id: i32) -> Result<(), LobbySendError> {
        self.try_send(Outgoing::Message(ClientMessage::AcceptPartyInvite {
            player_id,
        }))
    }

    fn set_party_factions(&self, factions: Vec<String>) {
        let _ = self.send_message(ClientMessage::SetPartyFactions { factions });
    }

    fn set_contact_relation(
        &self,
        contact: faf_domain::state::Contact,
        member: bool,
        remove: Option<Relation>,
    ) -> bool {
        let outgoing = self.outgoing.lock().unwrap();
        let Some(tx) = outgoing.as_ref() else {
            return false;
        };
        let Ok(permits) = tx.try_reserve_many(1 + usize::from(remove.is_some())) else {
            return false;
        };
        let removal = remove.map(|relation| {
            Outgoing::ContactRelation(
                faf_domain::state::Contact {
                    relation,
                    ..contact.clone()
                },
                false,
            )
        });
        for (permit, change) in permits.zip(
            removal
                .into_iter()
                .chain(std::iter::once(Outgoing::ContactRelation(contact, member))),
        ) {
            permit.send(change);
        }
        true
    }

    fn set_player_vetoes(&self, vetoes: Vec<PlayerVeto>) {
        let _ = self.send_message(ClientMessage::SetPlayerVetoes { vetoes });
    }

    fn request_avatars(&self) -> bool {
        self.send_message(ClientMessage::ListAvatars)
    }

    fn select_avatar(&self, url: Option<String>) -> bool {
        self.send_message(ClientMessage::SelectAvatar { url })
    }

    fn restore_game_session(&self, game_id: i32) -> bool {
        let sent = self.send_message(ClientMessage::RestoreGameSession { game_id });
        if !sent {
            tracing::warn!(
                game_id,
                "could not ask the server to restore the game session"
            );
        }
        sent
    }

    fn send_game_relay(&self, command: String, args: Vec<Value>) {
        let name = command.clone();
        if !self.send_message(ClientMessage::GameRelay { command, args }) {
            tracing::warn!(command = %name, "game relay message dropped because the lobby is disconnected");
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

/// Why one lobby session ended, and what the reconnect loop should do next.
enum SessionEnd {
    /// `disconnect()`, or a newer `connect()` replacing this one. Stop.
    Cancelled,
    /// The socket ended, or the keepalive found it dead. Open another one.
    ///
    /// `authenticated` is whether this session ever became usable. A session
    /// that worked and then dropped reconnects at once; a run of attempts that
    /// never got that far is what the backoff is for. It is the same
    /// distinction `handle_connected` draws in the Python client by resetting
    /// `_connection_attempts` to zero once a connection is up.
    Dropped { authenticated: bool },
    /// Nothing another attempt would fix: nobody is signed in, or the access
    /// service answered with a URL that is not safe to open.
    Hopeless,
}

/// Drive one lobby connection from handshake to close. Returns when the socket
/// ends, auth fails, or `cancel` fires (which sends a graceful close frame).
async fn run_session(
    config: LobbyConfig,
    http: reqwest::Client,
    access_token: Option<String>,
    tx: mpsc::Sender<LobbyUpdate>,
    outgoing: &mut mpsc::Receiver<Outgoing>,
    cancel: CancellationToken,
) -> SessionEnd {
    // Borrowed rather than owned: the queue of client frames outlives any one
    // socket, so a `game_join` that was waiting when the connection dropped is
    // still there for the session that replaces it.
    let Some(access_token) = access_token else {
        tracing::warn!("lobby connection skipped because there is no access token");
        return SessionEnd::Hopeless; // not logged in: nothing to authenticate with
    };

    // Resolve the WebSocket URL. FAF prod requires a verified URL obtained from
    // the API (the bare host 403s); an explicit FAF_LOBBY_URL bypasses that.
    let ws_url = if config.ws_url.is_empty() {
        match fetch_access_url(&http, &config.user_api_base, "/lobby/access", &access_token).await {
            Ok(url) => url,
            Err(e) => {
                tracing::error!(error = %e, "could not obtain lobby access URL");
                // Worth another try: the access service having a bad minute is
                // not the same as this client being unable to sign in.
                return SessionEnd::Dropped {
                    authenticated: false,
                };
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
            return SessionEnd::Hopeless;
        }
    };

    // Note: ws_url carries a one-time verify token: never log it verbatim.
    let ws = match tokio_tungstenite::connect_async(ws_url.as_str()).await {
        Ok((ws, _)) => ws,
        Err(e) => {
            tracing::error!(error = %e, "could not open lobby WebSocket");
            return SessionEnd::Dropped {
                authenticated: false,
            };
        }
    };
    tracing::info!("lobby WebSocket connected");
    let (mut write, mut read) = ws.split();

    // 1. Ask for a session.
    let ask = ClientMessage::AskSession {
        version: config.version.clone(),
        user_agent: LOBBY_USER_AGENT.to_string(),
    };
    if write.send(lobby_frame(&ask)).await.is_err() {
        tracing::error!("failed to request a lobby session");
        return SessionEnd::Dropped {
            authenticated: false,
        };
    }

    let mut games = GameSet::default();
    // `game_info` carries team membership, while the actual player ratings
    // arrive separately in `player_info`. Keep the latest displayed global
    // rating by login so game rows can mirror the reference clients' live
    // average-rating column.
    let mut player_ratings = PlayerRatings::new();
    // Identity (rather than rating) side of the same `player_info` stream,
    // what chat needs to rank its roster. See `PlayerDirectory`.
    let mut directory = PlayerDirectory::default();
    // Who this session is, from `welcome`. Only used to refuse the one
    // `player_info` that must never be believed: our own account going
    // offline. See the `player_info` arm.
    let mut own_player_id: Option<i64> = None;
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
    // Gates client→server frames. The broker only tolerates the handshake
    // (and `ping` / `pong`) before authentication and closes the socket on
    // anything else, so queued frames wait in `outgoing` until `welcome`
    // rather than racing `auth`.
    let mut authenticated = false;
    // See `SIGN_IN_TIMEOUT`. Only armed until `welcome`.
    let sign_in_deadline = tokio::time::sleep(SIGN_IN_TIMEOUT);
    tokio::pin!(sign_in_deadline);
    // Keepalive, as `ServerConnection`'s timer does it in the Python client.
    //
    // Nothing was sent from this side before: the connection only ever
    // answered the server's `ping`. An idle lobby connection carries no
    // traffic for minutes at a time, and a NAT table or a middlebox drops an
    // idle flow long before either end notices -- the socket stays open here
    // while nothing can reach it, until a write finally fails or the OS gives
    // up on the TCP retransmits, which is hours. That is the shape of the
    // report: random disconnections every few hours, far rarer on the clients
    // that do send something.
    //
    // Two jobs, one timer, exactly as `_ping_connection` has it. Traffic every
    // ten seconds keeps the flow alive, and a tick that arrives with the
    // previous ping still unanswered means the connection is already dead:
    // closing it then is what makes the loss visible in twenty seconds instead
    // of whenever the kernel notices.
    let mut keepalive = tokio::time::interval(LOBBY_KEEPALIVE_INTERVAL);
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    keepalive.tick().await; // the first tick of an interval is immediate
    let mut ping_unanswered = false;
    // Every exit but the two deliberate ones is a drop worth reconnecting
    // after, so that is the default and only the deliberate ones assign.
    let mut ending = SessionEnd::Dropped {
        authenticated: false,
    };
    'connection: loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = write.send(Message::Close(None)).await;
                ending = SessionEnd::Cancelled;
                break;
            }
            () = &mut sign_in_deadline, if !authenticated => {
                tracing::warn!(
                    timeout_seconds = SIGN_IN_TIMEOUT.as_secs(),
                    session = %session_id,
                    "the lobby never confirmed the sign-in; opening a new connection"
                );
                let _ = write.send(Message::Close(None)).await;
                break 'connection;
            }
            // Ten seconds without a single frame from the server.
            _ = keepalive.tick(), if authenticated => {
                if ping_unanswered {
                    tracing::warn!(
                        "the lobby server went silent through two keepalive periods; \
                         treating the connection as dead"
                    );
                    break 'connection;
                }
                ping_unanswered = true;
                if write
                    .send(lobby_frame(&ClientMessage::Ping))
                    .await
                    .is_err()
                {
                    break 'connection;
                }
            }
            // Client→server frames (e.g. game_join from `join`). `None` means the
            // sender was dropped by `disconnect`: tear down gracefully. Disabled
            // until `welcome`: see `authenticated`.
            frame = outgoing.recv(), if authenticated => {
                let Some(frame) = frame else {
                    // `disconnect()` dropped the sender: asked for, not lost.
                    let _ = write.send(Message::Close(None)).await;
                    ending = SessionEnd::Cancelled;
                    break;
                };
                let frame = match frame {
                    Outgoing::Message(message) => message,
                    Outgoing::ContactRelation(contact, member) => directory.contact_relation_message(contact, member),
                    Outgoing::ContactNames(names) => {
                        for (id, login) in names { directory.record_login(id, login); }
                        if tx.send(directory.contact_update()).await.is_err() { break 'connection; }
                        continue;
                    }
                };
                // A relation the user just set is a change to state this
                // session re-broadcasts, and the server tells nobody about it.
                directory.note_local_relation(&frame);
                // The end of the game is the end of the match, and the server
                // says nothing about it: the search was over the moment the
                // match was made, so there is no `search_info` left to send.
                // This connection keeps its own copy of the matchmaking state
                // and would otherwise carry `Launching` for the rest of the
                // session, ready to be re-published by the next message that
                // touches it.
                //
                // `GameState Ended` is the client's own report that the process
                // is gone, relayed a few lines before `GameTerminated` reaches
                // the app state, so it is the same fact arriving on this side.
                if frame.reports_game_ended()
                    && matches!(
                        matchmaking,
                        MatchmakingState::Launching { .. } | MatchmakingState::MatchFound { .. }
                    )
                {
                    matchmaking = MatchmakingState::Idle;
                    if tx
                        .send(LobbyUpdate::Matchmaking(matchmaking.clone()))
                        .await
                        .is_err()
                    {
                        break 'connection;
                    }
                }
                if write
                    .send(lobby_frame(&frame))
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
                if session_id.is_empty() {
                    // The session is the server's own handle on this
                    // connection. Without it `auth` is refused as malformed,
                    // and the refusal names nothing.
                    tracing::error!(
                        "cannot authenticate: the lobby server sent no session id"
                    );
                    break 'connection;
                }
                // Neither the token nor the proof itself, which are
                // credentials: their shape is what a rejected sign-in needs.
                tracing::debug!(
                    session = %session_id,
                    proof_length = unique_id.len(),
                    "authenticating with the lobby server"
                );
                let auth = ClientMessage::Auth {
                    token: access_token.clone(),
                    unique_id,
                    session: session_id.clone(),
                };
                if write
                    .send(lobby_frame(&auth))
                    .await
                    .is_err()
                {
                    break 'connection;
                }
            }
            incoming = read.next() => {
                let Some(Ok(message)) = incoming else { break 'connection };
                // Anything at all counts as the connection being alive, which
                // is `_receive_message` restarting the timer in the Python
                // client. A WebSocket control frame decodes to no lobby
                // messages and still proves the flow is open, so this is
                // deliberately before the decode rather than after it.
                ping_unanswered = false;
                keepalive.reset();
                let Some(values) = decode_lobby_messages(message) else { break 'connection };
                for value in values {
                match ServerMessage::decode(&value, chrono::Utc::now()) {
                    // Connectivity messages addressed to the game are relayed to the
                    // local ICE adapter, regardless of their command name.
                    ServerMessage::GameRelay { command, args } => {
                        if tx
                            .send(LobbyUpdate::GameRelay { command, args })
                            .await
                            .is_err()
                        {
                            break 'connection;
                        }
                    }
                    ServerMessage::Ping => {
                        if write
                            .send(lobby_frame(&ClientMessage::Pong))
                            .await
                            .is_err()
                        {
                            break 'connection;
                        }
                    }
                    ServerMessage::Session { session } => {
                        // Start the machine fingerprint; `auth` goes out from the
                        // proof branch below once the helper returns, so this loop
                        // keeps serving the socket in the meantime.
                        tracing::debug!("lobby session received; generating machine proof");
                        // The Python client normalizes the server's numeric
                        // session id to a string before sending `auth`.
                        session_id = session;
                        let proof_tx = proof_tx.clone();
                        let uid_path = config.uid_path.clone();
                        let session_arg = session_id.clone();
                        tokio::spawn(async move {
                            let proof = generate_unique_id(&uid_path, &session_arg).await;
                            let _ = proof_tx.send(proof).await;
                        });
                    }
                    // `authentication_failure` is the broker's name for it,
                    // `authentication_failed` the lobby server's.
                    ServerMessage::AuthenticationFailed { reason } => {
                        tracing::error!(%reason, "lobby authentication failed");
                        let _ = tx.send(LobbyUpdate::ConnectionRejected { reason }).await;
                        break 'connection;
                    }
                    ServerMessage::Welcome { me } => {
                        tracing::info!("lobby authenticated");
                        authenticated = true;
                        if tx.send(LobbyUpdate::Authenticated).await.is_err() {
                            break 'connection;
                        }
                        if let Some(player) = &me {
                            own_player_id = player.id;
                            update_player_ratings(&mut player_ratings, player);
                            if let Some(profile) = directory.observe(player) {
                                if tx.send(LobbyUpdate::PlayersSeen(vec![profile])).await.is_err() {
                                    break 'connection;
                                }
                            }
                        }
                        let _ = write
                            .send(lobby_frame(&ClientMessage::MatchmakerInfo))
                            .await;
                    }
                    ServerMessage::PlayerInfo { players } => {
                        // The lists as names, before this frame renames or
                        // introduces anybody: see below.
                        let relations_before = directory.relations();
                        let mut newly_seen = Vec::new();
                        let mut removed = Vec::new();
                        for player in &players {
                            if player.offline {
                                // Never our own account. The server marks
                                // a dropped connection offline and
                                // broadcasts it, and a reconnect is
                                // exactly that: the old connection's
                                // notice arrives on the new one, after
                                // `welcome` has already introduced us. The
                                // client then forgot its own profile --
                                // avatar, country and clan all gone from a
                                // session that was plainly still online,
                                // which is what "my avatar got eaten"
                                // looked like. We are receiving this
                                // message, so we are not offline.
                                if player.id.is_some() && player.id == own_player_id {
                                    tracing::debug!(
                                        "ignoring an offline notice for our own account"
                                    );
                                    continue;
                                }
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
                        if !newly_seen.is_empty()
                            && tx.send(LobbyUpdate::PlayersSeen(newly_seen)).await.is_err()
                        {
                            break 'connection;
                        }
                        // Sent again whenever this frame changed what the
                        // lists say. Two ways it does: an account the
                        // `social` message named only by id has a name now,
                        // and a friend or foe has been renamed (#516). The
                        // server keeps the lists by id, but they cross to
                        // the UI as names, and only the first case used to
                        // re-send them. A friend who changed their name then
                        // stayed listed under the old one, and the new one
                        // looked like a stranger: "the rename removed them
                        // from my friends".
                        let relations = directory.relations();
                        if relations != relations_before {
                            let (friends, foes) = relations;
                            if tx
                                .send(LobbyUpdate::Relations { friends, foes, contacts: directory.contacts() })
                                .await
                                .is_err()
                            {
                                break 'connection;
                            }
                        }
                        // Almost always nothing: the player this frame
                        // describes is usually not in a lobby at all, and
                        // this used to answer every one of them with both
                        // lists in full.
                        let mut delta = GameDelta::default();
                        games.refresh_ratings(&player_ratings, &mut delta);
                        if send_game_delta(&tx, delta).await.is_err() {
                            break 'connection;
                        }
                    }
                    ServerMessage::Notice(notice) => {
                        tracing::info!(style = ?notice.style, text = %notice.text, "lobby notice received");
                        if notice.is_unofficial_client_greeting() {
                            // Logged above, shown nowhere: see the function.
                            continue;
                        }
                        if notice.is_ban() {
                            // The server closes the socket next, and every
                            // reconnect would be refused the same way: the
                            // session ends here, for good.
                            tracing::error!("lobby: this account is banned; not reconnecting");
                            let _ = tx
                                .send(LobbyUpdate::Banned {
                                    text: notice.plain_text(),
                                })
                                .await;
                            ending = SessionEnd::Hopeless;
                            break 'connection;
                        }
                        let update = LobbyUpdate::Notice { style: notice.style, text: notice.text };
                        if tx.send(update).await.is_err() {
                            break 'connection;
                        }
                    }
                    ServerMessage::Invalid { text } => {
                        // FAF sends a bare `{"command": "invalid"}`, so the text
                        // below is usually the fallback and names nothing. What
                        // narrows it down is *when* it arrives: before `welcome`
                        // the only frame the client has sent is its own sign-in,
                        // and saying so is the difference between a report that
                        // can be acted on and one that cannot.
                        let reason = text.unwrap_or_else(|| {
                            if authenticated {
                                "The lobby server rejected an invalid client command."
                            } else {
                                "The lobby server rejected this client's sign-in."
                            }
                            .to_string()
                        });
                        tracing::error!(
                            %reason,
                            authenticated,
                            frame = %value,
                            "lobby protocol command rejected"
                        );
                        let _ = tx.send(LobbyUpdate::ConnectionRejected { reason }).await;
                        break 'connection;
                    }
                    ServerMessage::GameInfo { games: raws } => {
                        // The opening dump arrives as one array and is the list,
                        // not a change to it. Anything else is an edit to a
                        // lobby this client already knows about.
                        let replaces_the_list = raws.len() > 1;
                        let mut delta = GameDelta::default();
                        for raw in raws {
                            games.apply(raw, &player_ratings, &mut delta);
                        }
                        let restored = directory.restore_seated(games.seated());
                        if !restored.is_empty() {
                            for profile in &restored {
                                restore_player_ratings(&mut player_ratings, profile);
                            }
                            games.refresh_ratings(&player_ratings, &mut delta);
                            if tx.send(LobbyUpdate::PlayersSeen(restored)).await.is_err() {
                                break 'connection;
                            }
                        }
                        if replaces_the_list {
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
                        } else if send_game_delta(&tx, delta).await.is_err() {
                            break 'connection;
                        }
                    }
                    ServerMessage::GameLaunch(launch) => {
                        match launch {
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
                    ServerMessage::GameJoinFailed { id, reason } => {
                        tracing::warn!(game_id = id, %reason, "game join rejected");
                        if tx
                            .send(LobbyUpdate::JoinFailed { id, reason })
                            .await
                            .is_err()
                        {
                            break 'connection;
                        }
                    }
                    ServerMessage::MatchmakerInfo { queues } => {
                        if tx.send(LobbyUpdate::MatchmakerQueues(queues)).await.is_err() {
                            break 'connection;
                        }
                    }
                    ServerMessage::SearchInfo { queue_name, searching } => {
                        // Only when it moved. `update_search` refuses to let a
                        // late `stop` erase a match that was already found, and
                        // sending the unchanged state anyway published that
                        // refusal as news: a `stop` arriving after the match had
                        // been played put `Launching` back into the app's state
                        // long after the game had ended, and the Play tab then
                        // sat on "Starting your match" until the client was
                        // restarted.
                        if matchmaking.update_search(queue_name, searching)
                            && tx
                                .send(LobbyUpdate::Matchmaking(matchmaking.clone()))
                                .await
                                .is_err()
                        {
                            break 'connection;
                        }
                    }
                    ServerMessage::MatchFound { queue_name } => {
                        matchmaking = MatchmakingState::MatchFound { queue_name };
                        if tx
                            .send(LobbyUpdate::Matchmaking(matchmaking.clone()))
                            .await
                            .is_err()
                        {
                            break 'connection;
                        }
                        let _ = write
                            .send(lobby_frame(&ClientMessage::MatchReady))
                            .await;
                    }
                    ServerMessage::MatchCancelled => {
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
                    ServerMessage::UpdateParty(party) => {
                        if tx.send(LobbyUpdate::Party(party)).await.is_err() {
                            break 'connection;
                        }
                    }
                    ServerMessage::PartyInvite { sender_id: player_id } => {
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
                    ServerMessage::KickedFromParty => {
                        match tx.send(LobbyUpdate::Party(PartyState::default())).await {
                            Ok(()) => {}
                            Err(_) => break 'connection,
                        }
                    }
                    ServerMessage::VetoesInfo { vetoes, forced } => {
                        match tx
                            .send(LobbyUpdate::Vetoes {
                                vetoes,
                                forced,
                            })
                            .await
                        {
                            Ok(()) => {}
                            Err(_) => break 'connection,
                        }
                    }
                    ServerMessage::Social(social) => {
                        directory.set_relations(&social);
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
                            .send(LobbyUpdate::Relations { friends, foes, contacts: directory.contacts() })
                            .await
                            .is_err()
                        {
                            break 'connection;
                        }
                        // The same message assigns this account's channels
                        // (language, clan). Both reference clients take their
                        // auto-join list from here rather than deriving it.
                        if tx
                            .send(LobbyUpdate::AutoJoinChannels(social.channels))
                            .await
                            .is_err()
                        {
                            break 'connection;
                        }
                    }
                    ServerMessage::Avatars(avatars) => {
                        match tx
                            .send(LobbyUpdate::Avatars(avatars))
                            .await
                        {
                            Ok(()) => {}
                            Err(_) => break 'connection,
                        }
                    }
                    ServerMessage::FailedMessage { reason, key, request } => {
                        // The broker refused to pass a frame on: a command it
                        // has no schema for, or one that does not match it.
                        // The connection stays up, and the frame is lost; this
                        // is the only trace of it, so it says what it can.
                        tracing::warn!(
                            reason = reason.as_str(),
                            key = key.as_str(),
                            request = request.as_str(),
                            "the message broker refused a frame from this client"
                        );
                    }
                    ServerMessage::Other { .. } => {} // pong, a player_info without players, …
                }
                }
            }
        }
    }
    tracing::info!("lobby connection closed");
    // `authenticated` is the loop's own flag: the session became usable the
    // moment the server said `welcome`.
    match ending {
        SessionEnd::Dropped { .. } => SessionEnd::Dropped { authenticated },
        other => other,
    }
}

/// How long to wait before the next attempt, given how many in a row have
/// failed to produce a working connection.
///
/// `handle_disconnected` in the Python client: the first few go out
/// immediately, then `attempts * 10s`. Capped, which the Python client does
/// not do, because its counter is reset by a user action that this loop has no
/// equivalent of.
fn reconnect_delay(failures: u32) -> std::time::Duration {
    if failures <= RECONNECT_IMMEDIATE_ATTEMPTS {
        return std::time::Duration::ZERO;
    }
    RECONNECT_BACKOFF_STEP
        .saturating_mul(failures - RECONNECT_IMMEDIATE_ATTEMPTS)
        .min(RECONNECT_BACKOFF_MAX)
}

/// One client frame as it goes onto the socket: a text frame, always.
///
/// These used to be binary frames, which the lobby server read as readily as
/// text. `faf-message-broker`, which took over the socket on 2026-10-21, has
/// only an `@OnTextMessage` handler, and Quarkus hands a binary frame to a
/// callback that does nothing. `ask_session` vanished without an answer, and
/// the client sat on "connecting" with no lobbies to show. The Java client
/// writes strings (`sendString` in `FafLobbyClient`).
fn lobby_frame(message: &ClientMessage) -> Message {
    Message::text(message.encode())
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

    Some(split_messages(&text))
}

/// Run `faf-uid <session>` and return its stdout: the `unique_id` blob. Errors
/// if the binary is missing, exits non-zero, or hands back something that is
/// not a proof.
async fn generate_unique_id(uid_path: &str, session: &str) -> Result<String, String> {
    let mut command = tokio::process::Command::new(uid_path);
    command.arg(session);
    // Runs on every launch. Without this it flashes a console window up in the
    // player's face each time.
    crate::infra::hide_console(&mut command);
    let output = command
        .output()
        .await
        .map_err(|e| format!("could not start machine proof helper: {e}"))?;

    // The helper's own message, which used to be discarded. When it fails it is
    // the only thing that says why.
    let complaint = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(match complaint.is_empty() {
            true => format!("machine proof helper exited with {}", output.status),
            false => format!(
                "machine proof helper exited with {}: {complaint}",
                output.status
            ),
        });
    }

    let uid = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if uid.is_empty() {
        return Err(match complaint.is_empty() {
            true => "machine proof helper produced no output".into(),
            false => format!("machine proof helper produced no output: {complaint}"),
        });
    }
    if !looks_like_machine_proof(&uid) {
        // Sending it anyway is how this surfaced in the field: the lobby server
        // cannot decode it, answers a bare `{"command": "invalid"}` and drops
        // the connection, which names neither the helper nor the reason.
        return Err(format!(
            "machine proof helper produced something that is not a proof: {}",
            preview(&uid)
        ));
    }
    Ok(uid)
}

/// Whether the helper's output can be the proof rather than a message about
/// failing to produce one.
///
/// The blob is a single encoded token: long, and with nothing in it that a
/// sentence has. Anything else would be sent to the lobby server as a
/// credential, so it is refused here where the reason is still known.
fn looks_like_machine_proof(uid: &str) -> bool {
    const SHORTEST_PLAUSIBLE_PROOF: usize = 32;
    uid.len() >= SHORTEST_PLAUSIBLE_PROOF && !uid.chars().any(char::is_whitespace)
}

/// A short, quoted head of a value for a log line, so an unexpected proof can
/// be recognised without the whole of it (which may be a real credential)
/// reaching the log.
fn preview(value: &str) -> String {
    let head: String = value.chars().take(60).collect();
    if head.chars().count() < value.chars().count() {
        format!("{head:?}...")
    } else {
        format!("{head:?}")
    }
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
    /// The last profile of each account an offline notice removed, until it
    /// is seen again: see `restore_seated`.
    departed: BTreeMap<i64, PlayerProfile>,
    friend_ids: Vec<i64>,
    foe_ids: Vec<i64>,
}

/// How many removed profiles the directory keeps. A day's coming and going on
/// FAF, at a few hundred bytes each.
const DEPARTED_LIMIT: usize = 4096;

impl PlayerDirectory {
    fn contact_relation_message(
        &mut self,
        contact: faf_domain::state::Contact,
        member: bool,
    ) -> ClientMessage {
        if let Some(login) = contact.login.filter(|login| !login.is_empty()) {
            // UI actions may outlive a rename; only seed an unknown identity.
            self.logins
                .entry(i64::from(contact.player_id))
                .or_insert(login);
        }
        ClientMessage::Relation {
            player_id: contact.player_id,
            relation: contact.relation,
            member,
        }
    }
    fn contacts(&self) -> Vec<faf_domain::state::Contact> {
        [
            (Relation::Friend, &self.friend_ids),
            (Relation::Foe, &self.foe_ids),
        ]
        .into_iter()
        .flat_map(|(relation, ids)| {
            ids.iter().filter_map(move |id| {
                let player_id = i32::try_from(*id).ok().filter(|id| *id > 0)?;
                Some(faf_domain::state::Contact {
                    player_id,
                    login: self.logins.get(id).cloned(),
                    relation,
                })
            })
        })
        .collect()
    }

    fn contact_update(&self) -> LobbyUpdate {
        let (friends, foes) = self.relations();
        LobbyUpdate::Relations {
            friends,
            foes,
            contacts: self.contacts(),
        }
    }

    fn login(&self, id: i32) -> Option<String> {
        self.logins.get(&(id as i64)).cloned()
    }

    /// Remove an authoritative offline entry, returning the last full profile.
    /// Repeated/unknown offline messages are no-ops, which prevents duplicate
    /// notifications and mirrors both reference clients' player maps.
    fn remove(&mut self, player: &PlayerEntry) -> Option<PlayerProfile> {
        let id = player.id?;
        if let Some(login) = &player.login {
            self.logins.insert(id, login.clone());
        }
        let profile = self.profiles.remove(&id)?;
        if self.departed.len() >= DEPARTED_LIMIT {
            self.departed.pop_first();
        }
        self.departed.insert(id, profile.clone());
        Some(profile)
    }

    /// Bring back the removed profiles of players a game lists, and return
    /// them.
    ///
    /// An offline notice is not always true. When an account signs in again,
    /// the server registers the new connection and only then drops the old
    /// one, and dropping it deletes the player by id, which by then is the
    /// new connection's entry, and broadcasts the old one as `offline`
    /// (`player_service.remove_player`). Everyone else's client forgets a
    /// player who is still online, and the server sends no new `player_info`
    /// for them until their avatar or rating changes. Seated in a lobby, they
    /// showed with no flag, no rating and an unrated average (#595).
    ///
    /// `game_info` lists only connected players, so a seat is proof enough.
    fn restore_seated<'a>(&mut self, seated: impl Iterator<Item = &'a str>) -> Vec<PlayerProfile> {
        if self.departed.is_empty() {
            return Vec::new();
        }
        let wanted: std::collections::BTreeSet<String> = seated.map(str::to_lowercase).collect();
        let ids: Vec<i64> = self
            .departed
            .iter()
            .filter(|(_, profile)| wanted.contains(&profile.login.to_lowercase()))
            .map(|(id, _)| *id)
            .collect();
        let mut restored = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(profile) = self.departed.remove(&id) {
                if let std::collections::btree_map::Entry::Vacant(slot) = self.profiles.entry(id) {
                    slot.insert(profile.clone());
                    restored.push(profile);
                }
            }
        }
        restored
    }

    /// Record one `player_info`/`me` entry. Returns the profile only when it is
    /// new or has actually changed, so a `player_info` that repeats what we
    /// already know costs nothing on the update stream: this arrives for every
    /// online player at login and then continuously.
    fn observe(&mut self, player: &PlayerEntry) -> Option<PlayerProfile> {
        let login = player.login.clone()?;
        let id = player.id?;
        self.logins.insert(id, login.clone());
        self.departed.remove(&id);

        let known = self.profiles.get(&id);
        let ratings = player
            .ratings
            .clone()
            .or_else(|| known.map(|profile| profile.ratings.clone()))
            .unwrap_or_else(|| {
                player
                    .legacy_global_rating
                    .and_then(|rating| {
                        Some(vec![PlayerLobbyRating {
                            leaderboard: "global".into(),
                            rating: whole_points(rating)?,
                            mean: whole_points(rating)?,
                            deviation: 0,
                            games_played: 0,
                        }])
                    })
                    .unwrap_or_default()
            });

        let profile = PlayerProfile {
            // Ids are database serials, comfortably inside i32 (see `Player`).
            id: id as i32,
            login,
            // Some incremental `player_info` variants omit ratings. Preserve
            // the last known estimate instead of making the UI flash unrated.
            global_rating: player
                .rating_estimate
                .or_else(|| known.map(|profile| profile.global_rating))
                .unwrap_or_default(),
            ratings,
            // Flag filenames are lowercase; normalise here so the UI doesn't
            // have to care that the server sends "DE".
            country: player.country.to_lowercase(),
            clan: player.clan.clone(),
            avatar_url: player.avatar_url.clone(),
            avatar_tooltip: player.avatar_tooltip.clone(),
        };

        match self.profiles.get(&id) {
            Some(known) if *known == profile => None,
            _ => {
                self.profiles.insert(id, profile.clone());
                Some(profile)
            }
        }
    }

    fn set_relations(&mut self, social: &SocialLists) {
        self.friend_ids = social.friends.clone();
        self.foe_ids = social.foes.clone();
    }

    /// Fold a `social_add`/`social_remove` this client is *sending* into the
    /// directory's own lists.
    ///
    /// The server acknowledges neither command and never sends a second
    /// `social` message, so the connection would otherwise never learn what
    /// the user just did: the id lists stay exactly as they arrived at login.
    /// That was invisible until the next `player_info` named an account the
    /// relation lists had been waiting for, because the resolved lists are
    /// re-sent then -- and they are built from these ids, so they replaced the
    /// change the user had just made with the state from login. Adding a foe
    /// put a friend back, removing a friend restored them, and adding a friend
    /// held for a second or two and then vanished.
    ///
    /// The two lists are kept mutually exclusive here, as they are in the
    /// slice: `services::social` sends the matching `social_remove` for the
    /// other list, so this is the local half of the same decision.
    fn note_local_relation(&mut self, message: &ClientMessage) {
        let ClientMessage::Relation {
            player_id,
            relation,
            member,
        } = message
        else {
            return;
        };
        let id = i64::from(*player_id);
        let (list, other) = match relation {
            Relation::Friend => (&mut self.friend_ids, &mut self.foe_ids),
            Relation::Foe => (&mut self.foe_ids, &mut self.friend_ids),
        };
        list.retain(|known| *known != id);
        if *member {
            list.push(id);
            other.retain(|known| *known != id);
        }
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
        // A lookup started before a rename must not replace a live profile.
        let login = self
            .profiles
            .get(&id)
            .map(|profile| profile.login.clone())
            .unwrap_or(login);
        self.logins.insert(id, login);
    }

    #[cfg(test)]
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

/// Put a restored player's ratings back, from the profile that kept them.
fn restore_player_ratings(ratings: &mut PlayerRatings, profile: &PlayerProfile) {
    if ratings.contains_key(&profile.login) {
        return;
    }
    let boards: BTreeMap<String, i32> = if profile.ratings.is_empty() {
        // Only the estimate `update_player_ratings` falls back to, if any.
        if profile.global_rating == 0 {
            return;
        }
        BTreeMap::from([(GLOBAL_LEADERBOARD.to_string(), profile.global_rating)])
    } else {
        profile
            .ratings
            .iter()
            .map(|rating| (rating.leaderboard.clone(), rating.rating))
            .collect()
    };
    ratings.insert(profile.login.clone(), boards);
}

fn update_player_ratings(ratings: &mut PlayerRatings, player: &PlayerEntry) {
    let Some(login) = player.login.as_deref() else {
        return;
    };

    // A partial `player_info` that carries no ratings at all must not erase
    // what the last full one said, which is the same rule `observe` follows
    // for the profile it keeps.
    if let Some(boards) = player.ratings.clone() {
        if !boards.is_empty() {
            ratings.insert(
                login.to_string(),
                boards
                    .into_iter()
                    .map(|rating| (rating.leaderboard, rating.rating))
                    .collect(),
            );
            return;
        }
    }
    if let Some(estimate) = player.rating_estimate {
        ratings
            .entry(login.to_string())
            .or_default()
            .insert(GLOBAL_LEADERBOARD.to_string(), estimate);
    }
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

/// Send whichever halves of a delta actually carry something.
///
/// Returns `Err` when the consumer is gone, so the caller can break the
/// connection loop the same way an ordinary `send` lets it.
async fn send_game_delta(
    tx: &tokio::sync::mpsc::Sender<LobbyUpdate>,
    delta: GameDelta,
) -> Result<(), ()> {
    let GameDelta {
        open_upserted,
        open_removed,
        live_upserted,
        live_removed,
    } = delta;
    if !open_upserted.is_empty() || !open_removed.is_empty() {
        tx.send(LobbyUpdate::GamesChanged {
            upserted: open_upserted,
            removed: open_removed,
        })
        .await
        .map_err(|_| ())?;
    }
    if !live_upserted.is_empty() || !live_removed.is_empty() {
        tx.send(LobbyUpdate::LiveGamesChanged {
            upserted: live_upserted,
            removed: live_removed,
        })
        .await
        .map_err(|_| ())?;
    }
    Ok(())
}

/// What one batch of `game_info` frames did to the two lists.
///
/// Accumulated across the frames in a batch and sent once, so a server dump of
/// fifty lobbies is one event rather than fifty. Empty halves are not sent at
/// all: the common frame touches the open list and leaves the live list alone,
/// and re-sending an unchanged live list is most of what this replaces.
#[derive(Default)]
struct GameDelta {
    open_upserted: Vec<Game>,
    open_removed: Vec<i32>,
    live_upserted: Vec<Game>,
    live_removed: Vec<i32>,
}

impl GameSet {
    fn apply(&mut self, raw: GameInfo, player_ratings: &PlayerRatings, delta: &mut GameDelta) {
        let Some(uid) = raw.uid else {
            return;
        };
        let (open, playing) = (raw.is_open(), raw.is_playing());
        if open {
            if let Some(game) = raw.into_game(player_ratings) {
                // An unchanged repeat is not a change. The server re-announces a
                // lobby on any edit, including ones that leave everything this
                // client shows identical.
                if self.games.get(&uid) != Some(&game) {
                    delta.open_upserted.push(game.clone());
                    self.games.insert(uid, game);
                }
            }
            if self.live_games.remove(&uid).is_some() {
                delta.live_removed.push(uid);
            }
        } else if playing {
            if let Some(game) = raw.into_game(player_ratings) {
                if self.live_games.get(&uid) != Some(&game) {
                    delta.live_upserted.push(game.clone());
                    self.live_games.insert(uid, game);
                }
            }
            if self.games.remove(&uid).is_some() {
                delta.open_removed.push(uid);
            }
        } else {
            if self.games.remove(&uid).is_some() {
                delta.open_removed.push(uid);
            }
            if self.live_games.remove(&uid).is_some() {
                delta.live_removed.push(uid);
            }
        }
    }

    /// Re-average every game against ratings that just arrived, reporting only
    /// the games whose number actually moved.
    ///
    /// This runs on every `player_info`, which is the most frequent frame the
    /// lobby sends. It used to be followed by a full resend of both lists;
    /// almost always nothing had changed, because the player it described was
    /// not in a lobby at all.
    fn refresh_ratings(&mut self, player_ratings: &PlayerRatings, delta: &mut GameDelta) {
        for game in self.games.values_mut() {
            let average = average_game_rating(Some(&game.teams), player_ratings, &game.rating_type);
            if average > 0 && average != game.average_rating {
                game.average_rating = average;
                delta.open_upserted.push(game.clone());
            }
        }
        for game in self.live_games.values_mut() {
            let average = average_game_rating(Some(&game.teams), player_ratings, &game.rating_type);
            if average > 0 && average != game.average_rating {
                game.average_rating = average;
                delta.live_upserted.push(game.clone());
            }
        }
    }

    fn snapshot(&self) -> Vec<Game> {
        self.games.values().cloned().collect()
    }

    /// Every player in an open or a running game, observers included.
    fn seated(&self) -> impl Iterator<Item = &str> {
        self.games
            .values()
            .chain(self.live_games.values())
            .flat_map(|game| game.teams.values().flatten())
            .map(String::as_str)
    }

    fn snapshot_live(&self) -> Vec<Game> {
        self.live_games.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn outgoing_lobby_refusals_distinguish_saturation_and_reserve_whole_searches() {
        use super::{LobbyClient, LobbyPort, LobbySendError, Outgoing, TokenStore};
        use tokio::sync::mpsc;

        let lobby = LobbyClient::faf(TokenStore::new());
        let queues = ["ladder1v1".into(), "tmm2v2".into()];
        assert_eq!(
            lobby.accept_party_invite(7),
            Err(LobbySendError::Disconnected)
        );
        assert_eq!(
            lobby.matchmake(&queues, true),
            Err(LobbySendError::Disconnected)
        );

        let (tx, mut rx) = mpsc::channel(2);
        *lobby.outgoing.lock().unwrap() = Some(tx);
        lobby.accept_party_invite(7).unwrap();
        assert_eq!(lobby.matchmake(&queues, true), Err(LobbySendError::Busy));
        let Outgoing::Message(invite) = rx.try_recv().unwrap() else {
            panic!("party frame")
        };
        assert_eq!(
            invite,
            super::ClientMessage::AcceptPartyInvite { player_id: 7 }
        );
        assert!(
            rx.try_recv().is_err(),
            "a refused batch must leave no partial search"
        );

        lobby.matchmake(&queues, true).unwrap();
        assert_eq!(lobby.accept_party_invite(7), Err(LobbySendError::Busy));
        for queue in &queues {
            let Outgoing::Message(search) = rx.try_recv().unwrap() else {
                panic!("search frame")
            };
            assert_eq!(
                search,
                super::ClientMessage::GameMatchmaking {
                    queue_name: queue.clone(),
                    searching: true
                }
            );
        }
        drop(rx);
        assert_eq!(
            lobby.matchmake(&queues, true),
            Err(LobbySendError::Disconnected)
        );
    }

    #[test]
    fn contact_switch_needs_space_for_both_frames() {
        use super::{LobbyClient, LobbyPort, Outgoing, Relation, TokenStore};
        use faf_domain::state::Contact;
        use tokio::sync::mpsc;

        let lobby = LobbyClient::faf(TokenStore::new());
        let contact = Contact {
            player_id: 7,
            login: Some("OfflineFixture".into()),
            relation: Relation::Foe,
        };
        let (tx, mut rx) = mpsc::channel(2);
        assert!(tx.try_send(Outgoing::Message(ClientMessage::Ping)).is_ok());
        *lobby.outgoing.lock().unwrap() = Some(tx);

        assert!(!lobby.set_contact_relation(contact.clone(), true, Some(Relation::Friend)));
        assert!(matches!(rx.try_recv().unwrap(), Outgoing::Message(_)));
        assert!(rx.try_recv().is_err());

        assert!(lobby.set_contact_relation(contact, true, Some(Relation::Friend)));
        let Outgoing::ContactRelation(old, false) = rx.try_recv().unwrap() else {
            panic!("expected removal of the old friend relation");
        };
        let Outgoing::ContactRelation(new, true) = rx.try_recv().unwrap() else {
            panic!("expected the new foe relation");
        };
        assert_eq!(old.relation, Relation::Friend);
        assert_eq!(new.relation, Relation::Foe);
        assert_eq!(new.player_id, old.player_id);
    }

    #[test]
    fn contacts_preserve_unresolved_ids_and_never_turn_lookups_into_online_profiles() {
        let mut directory = super::PlayerDirectory::default();
        directory.set_relations(&social(serde_json::json!({ "friends": [7], "foes": [99] })));
        let before = directory.contacts();
        assert_eq!(before.len(), 2);
        assert!(before.iter().all(|contact| contact.login.is_none()));
        directory.record_login(7, "Offline".into());
        let after = directory.contacts();
        assert_eq!(after[0].login.as_deref(), Some("Offline"));
        assert!(directory.profiles.is_empty());
        directory.note_local_relation(&relation_frame(99, faf_domain::state::Relation::Foe, false));
        // A lookup completing after removal must not put the contact back.
        directory.record_login(99, "Removed".into());
        assert_eq!(directory.contacts().len(), 1);
        let frame = directory.contact_relation_message(
            faf_domain::state::Contact {
                player_id: 42,
                login: Some("NewOffline".into()),
                relation: faf_domain::state::Relation::Friend,
            },
            true,
        );
        directory.note_local_relation(&frame);
        assert_eq!(
            frame.to_value(),
            serde_json::json!({ "command": "social_add", "friend": 42 })
        );
        assert!(directory
            .contacts()
            .iter()
            .any(|contact| contact.login.as_deref() == Some("NewOffline")));
        assert!(directory.profiles.is_empty());
        directory.record_login(42, "Renamed".into());
        directory.contact_relation_message(
            faf_domain::state::Contact {
                player_id: 42,
                login: Some("Stale".into()),
                relation: faf_domain::state::Relation::Friend,
            },
            true,
        );
        assert_eq!(directory.login(42).as_deref(), Some("Renamed"));
        directory.observe(&player(
            serde_json::json!({ "id": 42, "login": "LiveName" }),
        ));
        directory.record_login(42, "StaleLookup".into());
        assert_eq!(directory.login(42).as_deref(), Some("LiveName"));
    }
    use super::*;
    use faf_domain::protocol::lobby::games_in;
    use serde_json::json;
    use std::time::Duration;

    /// One `player_info` entry, read the way the session receives it.
    fn player(value: Value) -> PlayerEntry {
        PlayerEntry::decode(&value)
    }

    /// A `social` message, likewise.
    fn social(value: Value) -> SocialLists {
        SocialLists::decode(&value)
    }

    /// The message `set_contact_relation` puts on the outgoing queue.
    fn relation_frame(player_id: i32, relation: Relation, member: bool) -> ClientMessage {
        ClientMessage::Relation {
            player_id,
            relation,
            member,
        }
    }

    use crate::infra::extract_access_url;

    #[test]
    fn directory_reports_only_profiles_that_are_new_or_changed() {
        // `player_info` repeats every online player at login and then keeps
        // arriving; re-emitting unchanged profiles would flood the UI.
        let mut directory = PlayerDirectory::default();
        assert_eq!(
            directory
                .observe(&player(json!({ "id": 1, "login": "Aurora" })))
                .map(|p| p.login),
            Some("Aurora".to_string())
        );
        assert_eq!(
            directory.observe(&player(json!({ "id": 1, "login": "Aurora" }))),
            None
        );
        // A rename under the same id is a change.
        assert_eq!(
            directory
                .observe(&player(json!({ "id": 1, "login": "Aurora_" })))
                .map(|p| p.login),
            Some("Aurora_".to_string())
        );
        // So is gaining an avatar.
        assert_eq!(
            directory
                .observe(&player(json!({
                    "id": 1,
                    "login": "Aurora_",
                    "avatar": { "url": "https://x/a.png", "tooltip": "Cat" },
                })))
                .map(|p| p.avatar_url),
            Some("https://x/a.png".to_string())
        );
    }

    #[test]
    fn directory_reads_country_clan_and_avatar() {
        let mut directory = PlayerDirectory::default();
        let profile = directory
            .observe(&player(json!({
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
            })))
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
            directory.observe(&player(json!({
                "id": 7,
                "login": "Stormlord",
                "country": "DE",
                "clan": "BC",
                "avatar": { "url": "https://content/a.png", "tooltip": "Aeon" },
            }))),
            None,
            "a partial update must retain the last known rating"
        );
    }

    #[test]
    fn directory_tolerates_a_null_avatar_and_missing_country() {
        let mut directory = PlayerDirectory::default();
        let profile = directory
            .observe(&player(
                json!({ "id": 8, "login": "Aurora", "avatar": Value::Null }),
            ))
            .unwrap();
        assert_eq!(profile.country, "");
        assert_eq!(profile.clan, "");
        assert_eq!(profile.avatar_url, "");
    }

    #[test]
    fn directory_ignores_entries_without_an_id_or_login() {
        let mut directory = PlayerDirectory::default();
        assert_eq!(
            directory.observe(&player(json!({ "login": "Aurora" }))),
            None
        );
        assert_eq!(directory.observe(&player(json!({ "id": 7 }))), None);
        assert_eq!(
            directory.observe(&player(json!({ "id": 7, "login": "" }))),
            None
        );
    }

    #[test]
    fn directory_offline_removal_is_authoritative_and_idempotent() {
        let mut directory = PlayerDirectory::default();
        directory.set_relations(&social(json!({ "friends": [7], "foes": [] })));
        directory
            .observe(&player(
                json!({ "id": 7, "login": "Aurora", "country": "DE" }),
            ))
            .unwrap();

        let removed = directory
            .remove(&player(
                json!({ "id": 7, "login": "Aurora", "state": "offline" }),
            ))
            .unwrap();
        assert_eq!(removed.login, "Aurora");
        assert_eq!(removed.country, "de");
        assert_eq!(directory.login(7).as_deref(), Some("Aurora"));
        assert_eq!(directory.relations().0, vec!["Aurora"]);
        assert!(directory
            .remove(&player(
                json!({ "id": 7, "login": "Aurora", "state": "offline" })
            ))
            .is_none());
    }

    #[test]
    fn a_player_a_game_seats_comes_back_after_a_false_offline_notice() {
        // #595: a re-login's old connection is broadcast offline after the
        // new one registered. The player is still online, and a game lists
        // them; their profile and ratings come back from what was kept.
        let mut directory = PlayerDirectory::default();
        directory
            .observe(&player(json!({
                "id": 480156, "login": "OGlobal2500lader", "country": "DE",
                "ratings": { "global": { "rating": [2016.0, 95.0], "number_of_games": 4200 } }
            })))
            .unwrap();
        directory
            .remove(&player(
                json!({ "id": 480156, "login": "OGlobal2500lader", "state": "offline" }),
            ))
            .unwrap();

        // Not seated anywhere: stays gone.
        assert!(directory
            .restore_seated(["Somebody"].into_iter())
            .is_empty());

        let restored = directory.restore_seated(["oglobal2500lader"].into_iter());
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].country, "de");
        let mut ratings = PlayerRatings::new();
        restore_player_ratings(&mut ratings, &restored[0]);
        assert_eq!(ratings["OGlobal2500lader"]["global"], 1731);

        // Once only: the profile is back in the directory.
        assert!(directory
            .restore_seated(["OGlobal2500lader"].into_iter())
            .is_empty());
    }

    #[test]
    fn a_player_seen_again_is_no_longer_waiting_to_be_restored() {
        let mut directory = PlayerDirectory::default();
        directory
            .observe(&player(json!({ "id": 7, "login": "Aurora" })))
            .unwrap();
        directory
            .remove(&player(
                json!({ "id": 7, "login": "Aurora", "state": "offline" }),
            ))
            .unwrap();
        directory
            .observe(&player(json!({ "id": 7, "login": "Aurora" })))
            .unwrap();
        assert!(directory.departed.is_empty());
        assert!(directory.restore_seated(["Aurora"].into_iter()).is_empty());
    }

    #[test]
    fn a_relation_the_user_sets_survives_the_next_player_info() {
        // The report: adding a foe made them a friend, removing a friend put
        // them back, and adding a friend held for a moment and vanished. All
        // three are this re-broadcast, which used to replay the login state.
        let mut directory = PlayerDirectory::default();
        directory.record_login(7, "Aurora".into());
        directory.record_login(9, "Nomander".into());
        directory.set_relations(&social(json!({ "friends": [7], "foes": [] })));

        directory.note_local_relation(&relation_frame(7, Relation::Foe, true));
        assert_eq!(directory.relations(), (vec![], vec!["Aurora".to_string()]));

        directory.note_local_relation(&relation_frame(9, Relation::Friend, true));
        assert_eq!(
            directory.relations(),
            (vec!["Nomander".to_string()], vec!["Aurora".to_string()])
        );

        directory.note_local_relation(&relation_frame(9, Relation::Friend, false));
        assert_eq!(directory.relations(), (vec![], vec!["Aurora".to_string()]));

        // Anything else on the outgoing channel leaves the lists alone.
        directory.note_local_relation(&ClientMessage::GameJoin {
            uid: 7,
            password: None,
        });
        assert_eq!(directory.relations(), (vec![], vec!["Aurora".to_string()]));
    }

    #[test]
    fn a_connection_that_worked_is_retried_at_once_and_a_dead_one_backs_off() {
        // `handle_disconnected` in the Python client: the first few attempts
        // are immediate, because a socket that has been working and then drops
        // is usually a blip and waiting ten seconds to find that out is ten
        // seconds of the client being wrong about its own state.
        assert_eq!(reconnect_delay(1), Duration::ZERO);
        assert_eq!(
            reconnect_delay(RECONNECT_IMMEDIATE_ATTEMPTS),
            Duration::ZERO
        );

        // Past that it is a real outage rather than a blip, and the schedule
        // is the reference client's `attempts * 10s`.
        assert_eq!(
            reconnect_delay(RECONNECT_IMMEDIATE_ATTEMPTS + 1),
            Duration::from_secs(10)
        );
        assert_eq!(
            reconnect_delay(RECONNECT_IMMEDIATE_ATTEMPTS + 2),
            Duration::from_secs(20)
        );

        // Capped, so a server that is down all evening is still polled once a
        // minute rather than once an hour.
        assert_eq!(reconnect_delay(1_000), RECONNECT_BACKOFF_MAX);
        // And it cannot overflow its way back to an immediate retry.
        assert_eq!(reconnect_delay(u32::MAX), RECONNECT_BACKOFF_MAX);
    }

    #[test]
    fn every_client_frame_is_a_newline_terminated_text_frame() {
        // The message broker drops binary frames without a word: see
        // `lobby_frame`.
        let frame = lobby_frame(&ClientMessage::Ping);
        let Message::Text(text) = frame else {
            panic!("the broker only reads text frames, got {frame:?}");
        };
        assert_eq!(text.as_str(), "{\"command\":\"ping\"}\n");
    }

    #[test]
    fn relations_resolve_ids_that_arrive_after_the_social_message() {
        // `social` routinely lands before the `player_info` naming those ids.
        let mut directory = PlayerDirectory::default();
        directory.set_relations(&social(json!({ "friends": [2, 3], "foes": [4] })));
        assert_eq!(directory.relations(), (vec![], vec![]));

        directory.observe(&player(json!({ "id": 2, "login": "Stormlord" })));
        directory.observe(&player(json!({ "id": 4, "login": "Griefer" })));
        assert_eq!(
            directory.relations(),
            (vec!["Stormlord".to_string()], vec!["Griefer".to_string()])
        );

        directory.observe(&player(json!({ "id": 3, "login": "Sheikah" })));
        assert_eq!(
            directory.relations().0,
            vec!["Stormlord".to_string(), "Sheikah".to_string()]
        );
    }

    /// A friend renamed while this client runs: the lists are kept by id, so
    /// the next `player_info` moves the friend to the new name, and the lists
    /// read differently afterwards, which is what has them sent again (#516).
    #[test]
    fn a_renamed_friend_stays_a_friend_under_the_new_name() {
        let mut directory = PlayerDirectory::default();
        directory.set_relations(&social(json!({ "friends": [2], "foes": [4] })));
        directory.observe(&player(json!({ "id": 2, "login": "Stormlord" })));
        directory.observe(&player(json!({ "id": 4, "login": "Griefer" })));
        let before = directory.relations();

        directory.observe(&player(json!({ "id": 2, "login": "StormlordTheSecond" })));
        directory.observe(&player(json!({ "id": 4, "login": "Reformed" })));
        let after = directory.relations();

        assert_eq!(
            after,
            (
                vec!["StormlordTheSecond".to_string()],
                vec!["Reformed".to_string()]
            )
        );
        assert_ne!(after, before, "a rename has to re-send the lists");
    }

    #[test]
    fn relation_ids_are_accepted_as_numbers_or_strings() {
        let mut directory = PlayerDirectory::default();
        directory.set_relations(&social(
            json!({ "friends": [2, "3", "not-a-number"], "foes": [] }),
        ));
        directory.observe(&player(json!({ "id": 2, "login": "Stormlord" })));
        directory.observe(&player(json!({ "id": 3, "login": "Sheikah" })));
        assert_eq!(
            directory.relations().0,
            vec!["Stormlord".to_string(), "Sheikah".to_string()]
        );
    }

    #[test]
    fn a_social_message_without_relations_is_not_treated_as_having_any() {
        let mut directory = PlayerDirectory::default();
        assert!(!directory.has_relations());
        directory.set_relations(&social(
            json!({ "command": "social", "autojoin": ["#aeolus"] }),
        ));
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
    fn computes_average_rating_from_player_info_and_ignores_observers() {
        let mut ratings = PlayerRatings::new();
        update_player_ratings(
            &mut ratings,
            &player(json!({
                "login": "Alpha",
                "ratings": { "global": { "rating": [1800, 200] } }
            })),
        );
        update_player_ratings(
            &mut ratings,
            &player(json!({
                "login": "Bravo",
                "ratings": { "global": { "rating": [1700, 100] } }
            })),
        );
        update_player_ratings(
            &mut ratings,
            &player(json!({
                "login": "Spectator",
                "ratings": { "global": { "rating": [2500, 0] } }
            })),
        );

        let mut message = open_game_json(43, "open", 3);
        message["teams"] = json!({
            "1": ["Alpha"],
            "2": ["Bravo"],
            "-1": ["Spectator"]
        });
        let game = games_in(&message)
            .pop()
            .unwrap()
            .into_game(&ratings)
            .unwrap();

        // Alpha = 1200 and Bravo = 1400; observer is excluded.
        assert_eq!(game.average_rating, 1300);
    }

    #[test]
    fn accepts_legacy_player_rating_field() {
        let mut ratings = PlayerRatings::new();
        update_player_ratings(
            &mut ratings,
            &player(json!({ "login": "Legacy", "global_rating": 1234 })),
        );
        assert_eq!(ratings["Legacy"][GLOBAL_LEADERBOARD], 1234);
    }

    #[test]
    fn averages_a_matchmaker_game_over_the_queue_it_is_rated_on() {
        // The reported case: a 1v1 ladder game listing global ratings, which
        // are the numbers the game is not being played for.
        let mut ratings = PlayerRatings::new();
        update_player_ratings(
            &mut ratings,
            &player(json!({
                "login": "Valkyra",
                "ratings": {
                    "global": { "rating": [1100, 98] },
                    "ladder_1v1": { "rating": [662, 65] },
                }
            })),
        );
        update_player_ratings(
            &mut ratings,
            &player(json!({
                "login": "Rival",
                "ratings": {
                    "global": { "rating": [1600, 200] },
                    "ladder_1v1": { "rating": [1000, 100] },
                }
            })),
        );

        let mut message = open_game_json(44, "playing", 2);
        message["rating_type"] = json!("ladder_1v1");
        message["teams"] = json!({ "2": ["Valkyra"], "3": ["Rival"] });
        let game = games_in(&message)
            .pop()
            .unwrap()
            .into_game(&ratings)
            .unwrap();

        assert_eq!(game.rating_type, "ladder_1v1");
        // Ladder: 467 and 700, not global's 806 and 1000. 583.5 rounds up,
        // the way the server's own average does when it sends one.
        assert_eq!(game.average_rating, 584);
    }

    #[test]
    fn a_game_without_a_rating_type_is_a_global_one() {
        let mut ratings = PlayerRatings::new();
        update_player_ratings(
            &mut ratings,
            &player(
                json!({ "login": "Alpha", "ratings": { "global": { "rating": [1800, 200] } } }),
            ),
        );
        let mut message = open_game_json(45, "open", 1);
        message["teams"] = json!({ "1": ["Alpha"] });
        let game = games_in(&message)
            .pop()
            .unwrap()
            .into_game(&ratings)
            .unwrap();

        assert_eq!(game.rating_type, GLOBAL_LEADERBOARD);
        assert_eq!(game.average_rating, 1200);
    }

    #[test]
    fn a_partial_player_info_does_not_erase_the_ratings_already_known() {
        let mut ratings = PlayerRatings::new();
        update_player_ratings(
            &mut ratings,
            &player(json!({
                "login": "Alpha",
                "ratings": { "ladder_1v1": { "rating": [900, 100] } }
            })),
        );
        update_player_ratings(
            &mut ratings,
            &player(json!({ "login": "Alpha", "country": "de" })),
        );
        assert_eq!(ratings["Alpha"]["ladder_1v1"], 600);
    }

    #[test]
    fn gameset_adds_open_and_removes_closed() {
        let mut set = GameSet::default();
        for raw in games_in(&open_game_json(1, "open", 1)) {
            set.apply(raw, &PlayerRatings::new(), &mut GameDelta::default());
        }
        for raw in games_in(&open_game_json(2, "open", 2)) {
            set.apply(raw, &PlayerRatings::new(), &mut GameDelta::default());
        }
        assert_eq!(set.snapshot().len(), 2);

        // Game 1 transitions to playing → drops out of the open list.
        for raw in games_in(&open_game_json(1, "playing", 2)) {
            set.apply(raw, &PlayerRatings::new(), &mut GameDelta::default());
        }
        let snap = set.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].id, 2); // ordered by id
    }

    #[test]
    fn gameset_update_replaces_in_place() {
        let mut set = GameSet::default();
        for raw in games_in(&open_game_json(5, "open", 1)) {
            set.apply(raw, &PlayerRatings::new(), &mut GameDelta::default());
        }
        for raw in games_in(&open_game_json(5, "open", 4)) {
            set.apply(raw, &PlayerRatings::new(), &mut GameDelta::default());
        }
        let snap = set.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].players, 4);
    }

    #[test]
    fn gameset_ignores_forming_matchmaker_games_until_playing() {
        let mut set = GameSet::default();
        let forming_mm = json!({
            "command": "game_info",
            "uid": 99,
            "title": "Team DietTaco Vs Team Balde",
            "state": "open",
            "game_type": "matchmaker",
            "num_players": 4,
            "max_players": 6,
        });
        for raw in games_in(&forming_mm) {
            set.apply(raw, &PlayerRatings::new(), &mut GameDelta::default());
        }
        assert_eq!(set.snapshot().len(), 0);
        assert_eq!(set.snapshot_live().len(), 0);

        let playing_mm = json!({
            "command": "game_info",
            "uid": 99,
            "title": "Team DietTaco Vs Team Balde",
            "state": "playing",
            "game_type": "matchmaker",
            "num_players": 6,
            "max_players": 6,
        });
        for raw in games_in(&playing_mm) {
            set.apply(raw, &PlayerRatings::new(), &mut GameDelta::default());
        }
        assert_eq!(set.snapshot().len(), 0);
        assert_eq!(set.snapshot_live().len(), 1);
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

    /// A proof is one long encoded token. Anything with a space in it is a
    /// sentence about failing to produce one, and sending that to the lobby
    /// server buys a bare `{"command": "invalid"}` and a closed connection.
    #[test]
    fn a_machine_proof_is_one_long_token() {
        assert!(looks_like_machine_proof(&"a".repeat(64)));
        assert!(looks_like_machine_proof(
            "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.abcdefghijklmnop"
        ));
    }

    #[test]
    fn a_message_is_not_a_machine_proof() {
        for output in [
            "",
            "error: could not read the machine id",
            "Zugriff verweigert",
            // Long enough, but a proof is a single token.
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbb",
            // A plausible looking but far too short answer.
            "no",
        ] {
            assert!(
                !looks_like_machine_proof(output),
                "{output:?} must not be sent as a credential"
            );
        }
    }

    #[test]
    fn a_preview_keeps_the_head_and_marks_the_rest() {
        assert_eq!(preview("short"), "\"short\"");
        let long = "x".repeat(80);
        let shown = preview(&long);
        assert!(shown.ends_with("\"..."), "{shown}");
        assert!(
            shown.len() < long.len(),
            "the whole value must not be logged"
        );
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
}
