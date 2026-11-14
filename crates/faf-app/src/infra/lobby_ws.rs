//! Real lobby provider: the FAF lobby WebSocket protocol.
//!
//! Connects to `wss://ws.faforever.com`, performs the session handshake and
//! streams the open-games list behind the same [`LobbyPort`] the fake implements.
//! The connection lifecycle (and graceful teardown via `disconnect`) lives here;
//! the lobby service, slice and UI are unchanged.
//!
//! The messages themselves are `faf_domain::protocol::lobby`: `ServerMessage`
//! is what arrives, read, and `ClientMessage` is what is sent. What is left
//! here is socket I/O, the handshake and reconnect timing. The pure session
//! fold in `session` owns player identities, ratings, game lists and matches,
//! returning ordered effects for this adapter to perform.
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

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_domain::protocol::lobby::{split_messages, ClientMessage, ServerMessage};
use faf_domain::state::{HostGameConfig, PlayerVeto, Relation};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use crate::infra::session::TokenStore;
use crate::infra::{env_or, fetch_access_url, validated_ws_url};
use crate::ports::{LobbyPort, LobbySendError, LobbyUpdate};

mod session;
use session::{Effect, SessionState};

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

    let mut state = SessionState::default();
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
                    Outgoing::ContactRelation(contact, member) => state.contact_relation_message(contact, member),
                    Outgoing::ContactNames(names) => {
                        for effect in state.contacts_resolved(names) {
                            if let Effect::Emit(update) = effect {
                                if tx.send(update).await.is_err() { break 'connection; }
                            }
                        }
                        continue;
                    }
                };
                for effect in state.outgoing(&frame) {
                    if let Effect::Emit(update) = effect {
                        if tx.send(update).await.is_err() { break 'connection; }
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
                    let effects = state.incoming(ServerMessage::decode(&value, chrono::Utc::now()));
                    authenticated = state.authenticated();
                    for effect in effects {
                        match effect {
                            Effect::Emit(update) => {
                                if tx.send(update).await.is_err() { break 'connection; }
                            }
                            Effect::Send(message) => {
                                if write.send(lobby_frame(&message)).await.is_err() { break 'connection; }
                            }
                            Effect::TrySend(message) => { let _ = write.send(lobby_frame(&message)).await; }
                            Effect::MachineProof(session) => {
                                session_id = session;
                                let proof_tx = proof_tx.clone();
                                let uid_path = config.uid_path.clone();
                                let session_arg = session_id.clone();
                                tokio::spawn(async move {
                                    let proof = generate_unique_id(&uid_path, &session_arg).await;
                                    let _ = proof_tx.send(proof).await;
                                });
                            }
                            Effect::ResolveContacts(ids) => {
                                let names = fetch_player_logins(&http, &config.api_base, Some(&access_token), &ids).await.unwrap_or_default();
                                for effect in state.contacts_resolved(names) {
                                    if let Effect::Emit(update) = effect {
                                        if tx.send(update).await.is_err() { break 'connection; }
                                    }
                                }
                            }
                            Effect::Stop { hopeless } => {
                                if hopeless { ending = SessionEnd::Hopeless; }
                                break 'connection;
                            }
                        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::extract_access_url;
    use serde_json::json;
    use std::time::Duration;
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
        let first = json!({"command":"game_info", "uid":1}).to_string();
        let second = json!({"command":"game_info", "uid":2}).to_string();
        let frame = Message::Binary(format!("{first}\n{second}\n").into_bytes());

        let messages = decode_lobby_messages(frame).expect("binary frames stay usable");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].get("uid").and_then(Value::as_i64), Some(1));
        assert_eq!(messages[1].get("uid").and_then(Value::as_i64), Some(2));
    }
}
