//! Real chat provider — the FAF chat IRC protocol tunneled over WebSocket.
//!
//! FAF chat is plain IRC (Ergochat) whose transport is the IRCv3 *binary*
//! WebSocket protocol (<https://ircv3.net/specs/extensions/websocket>):
//! connect to `wss://chat.faforever.com:443` with
//! `Sec-WebSocket-Protocol: binary.ircv3.net`, then send/receive one complete
//! IRC line per WS **binary** frame (not text — the spec requires binary, and
//! frames must NOT include a trailing CRLF). Confirmed against the actual
//! reference client (`py-client/src/chat/{ircconnection,socketadapter}.py`),
//! which is what's really deployed — an earlier draft of this file guessed
//! `irc.faforever.com:6697` with text frames from the (stale, for this
//! purpose) Java client checkout, which production doesn't listen on at all.
//!
//! Auth is SASL PLAIN using a one-time token from
//! `GET {user_api_base}/irc/ergochat/token` (`{"value": "<token>"}`), with an
//! empty authzid, `authcid = "<username>"` (plain, no suffix — confirmed by
//! `py-client`'s `sasl_login=username`), `password = "token:<token>"`.
//!
//! ## Handshake
//! 1. → `CAP REQ :sasl`
//! 2. ← `CAP * ACK :sasl` (NAK → abort)
//! 3. → `AUTHENTICATE PLAIN` ← `AUTHENTICATE +` → `AUTHENTICATE <base64 payload>`
//! 4. ← `903` success, or `904`/`905` failure (→ abort)
//! 5. → `CAP END`, `NICK <username>`, `USER <username> 0 * :<username>`
//! 6. ← `001` (registered) → → `JOIN #aeolus`
//! 7. ← `353` (accumulate names, stripping mode prefixes) / `366` (end of
//!    names) → emit a full users snapshot
//! 8. Ongoing: `JOIN`/`PART`/`QUIT` update the user set and re-emit a snapshot;
//!    `PRIVMSG` → a message; `PING` → `PONG` reply.
//!
//! `send_message` both sends the raw `PRIVMSG` line to the socket *and*
//! independently pushes a locally-built message onto the update channel —
//! this client doesn't negotiate `echo-message`, so the port owns the local
//! echo (mirrors `infra::chat::FakeChat`).

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_domain::protocol::irc;
use faf_domain::state::{ChatMessage, DEFAULT_CHANNEL};
use futures_util::{Sink, SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use crate::infra::session::TokenStore;
use crate::infra::env_or;
use crate::ports::{ChatPort, ChatUpdate};

/// The IRCv3 binary websocket subprotocol FAF's chat server requires.
/// <https://ircv3.net/specs/extensions/websocket>
const WS_SUBPROTOCOL: &str = "binary.ircv3.net";

/// Configuration for the real chat client.
#[derive(Debug, Clone)]
pub struct IrcConfig {
    pub host: String,
    pub port: u16,
    /// FAF *user* API base (`user.faforever.com`), which serves
    /// `/irc/ergochat/token` — the same host the lobby client already uses.
    pub user_api_base: String,
}

impl IrcConfig {
    pub fn faf() -> Self {
        Self {
            host: env_or("FAF_IRC_HOST", "chat.faforever.com"),
            port: env_or("FAF_IRC_PORT", "443").parse().unwrap_or(443),
            user_api_base: env_or("FAF_USER_API_BASE", "https://user.faforever.com"),
        }
    }
}

pub struct IrcClient {
    config: IrcConfig,
    tokens: TokenStore,
    http: reqwest::Client,
    cancel: Arc<Mutex<Option<CancellationToken>>>,
    /// Outgoing raw IRC lines for the live connection. `send_message` pushes
    /// here; `run_session` drains it and writes to the socket.
    outgoing: Arc<Mutex<Option<mpsc::Sender<String>>>>,
    /// The live connection's update sender, so `send_message` can push the
    /// local echo onto the same stream the service is draining.
    updates: Arc<Mutex<Option<mpsc::Sender<ChatUpdate>>>>,
    username: Arc<Mutex<String>>,
    next_id: Arc<AtomicU64>,
}

impl IrcClient {
    pub fn new(config: IrcConfig, tokens: TokenStore) -> Self {
        Self {
            config,
            tokens,
            http: reqwest::Client::new(),
            cancel: Arc::new(Mutex::new(None)),
            outgoing: Arc::new(Mutex::new(None)),
            updates: Arc::new(Mutex::new(None)),
            username: Arc::new(Mutex::new(String::new())),
            next_id: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn faf(tokens: TokenStore) -> Self {
        Self::new(IrcConfig::faf(), tokens)
    }

    /// Push a raw IRC line onto the live connection's outgoing channel.
    /// Returns `false` if there is no active connection.
    fn send_line(&self, line: String) -> bool {
        self.outgoing
            .lock()
            .unwrap()
            .as_ref()
            .map(|tx| tx.try_send(line).is_ok())
            .unwrap_or(false)
    }
}

#[async_trait]
impl ChatPort for IrcClient {
    async fn connect(&self, username: String) -> mpsc::Receiver<ChatUpdate> {
        let token = CancellationToken::new();
        if let Some(prev) = self.cancel.lock().unwrap().replace(token.clone()) {
            prev.cancel();
        }
        *self.username.lock().unwrap() = username.clone();

        let (tx, rx) = mpsc::channel(64);
        *self.updates.lock().unwrap() = Some(tx.clone());
        let (out_tx, out_rx) = mpsc::channel::<String>(32);
        *self.outgoing.lock().unwrap() = Some(out_tx);

        let config = self.config.clone();
        let http = self.http.clone();
        let access_token = self.tokens.get();
        let emitter = ChatEmitter {
            tx,
            next_id: self.next_id.clone(),
        };
        tokio::spawn(async move {
            run_session(config, http, access_token, username, emitter, out_rx, token).await;
        });
        rx
    }

    fn send_message(&self, content: String) {
        let line = irc::format_line("PRIVMSG", &[DEFAULT_CHANNEL, &content]);
        if !self.send_line(line) {
            eprintln!("[chat] send ignored: no active connection");
            return;
        }
        let message = ChatMessage {
            id: self.next_id.fetch_add(1, Ordering::SeqCst).to_string(),
            sender: self.username.lock().unwrap().clone(),
            content,
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        if let Some(tx) = self.updates.lock().unwrap().clone() {
            let _ = tx.try_send(ChatUpdate::MessageReceived(message));
        }
    }

    fn disconnect(&self) {
        if let Some(token) = self.cancel.lock().unwrap().take() {
            token.cancel();
        }
        *self.outgoing.lock().unwrap() = None;
        *self.updates.lock().unwrap() = None;
    }
}

/// Build the WS upgrade request with the `Sec-WebSocket-Protocol` header the
/// server requires — a bare URL (as `lobby_ws.rs` uses) isn't enough here.
fn build_request(
    url: &str,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, String> {
    use tokio_tungstenite::tungstenite::http::HeaderValue;

    let mut request = url
        .into_client_request()
        .map_err(|e| format!("invalid url: {e}"))?;
    request
        .headers_mut()
        .insert("Sec-WebSocket-Protocol", HeaderValue::from_static(WS_SUBPROTOCOL));
    Ok(request)
}

/// Send one IRC line as a WS **binary** frame — the IRCv3 binary websocket
/// spec requires binary frames and forbids a trailing CRLF. `true` on success.
async fn send_line<S>(write: &mut S, line: String) -> bool
where
    S: Sink<Message> + Unpin,
{
    write.send(Message::binary(line.into_bytes())).await.is_ok()
}

/// Bundles the update stream with the id counter that stamps outgoing
/// messages — also folds the repeated "build+send, bail on a closed
/// receiver" pattern into one call each for messages and user snapshots.
struct ChatEmitter {
    tx: mpsc::Sender<ChatUpdate>,
    next_id: Arc<AtomicU64>,
}

impl ChatEmitter {
    async fn message(&self, sender: &str, content: &str) -> bool {
        let message = ChatMessage {
            id: self.next_id.fetch_add(1, Ordering::SeqCst).to_string(),
            sender: sender.to_string(),
            content: content.to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        self.tx.send(ChatUpdate::MessageReceived(message)).await.is_ok()
    }

    async fn users(&self, users: &BTreeSet<String>) -> bool {
        self.tx
            .send(ChatUpdate::UsersUpdated(users.iter().cloned().collect()))
            .await
            .is_ok()
    }
}

/// Drive one chat connection from handshake to close. Returns when the socket
/// ends, auth fails, or `cancel` fires (which sends a graceful close frame).
async fn run_session(
    config: IrcConfig,
    http: reqwest::Client,
    access_token: Option<String>,
    username: String,
    emitter: ChatEmitter,
    mut outgoing: mpsc::Receiver<String>,
    cancel: CancellationToken,
) {
    let Some(access_token) = access_token else {
        eprintln!("[chat] not connecting: no access token (are you logged in?)");
        return;
    };

    let sasl_token = match fetch_irc_token(&http, &config.user_api_base, &access_token).await {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[chat] could not get irc token: {e}");
            return;
        }
    };

    let url = format!("wss://{}:{}", config.host, config.port);
    let request = match build_request(&url) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[chat] could not build websocket request: {e}");
            return;
        }
    };
    let ws = match tokio_tungstenite::connect_async(request).await {
        Ok((ws, _)) => ws,
        Err(e) => {
            eprintln!("[chat] could not open websocket: {e}");
            return;
        }
    };
    eprintln!("[chat] websocket connected");
    let (mut write, mut read) = ws.split();

    if !send_line(&mut write, irc::format_line("CAP", &["REQ", "sasl"])).await {
        eprintln!("[chat] failed to send CAP REQ");
        return;
    }

    let mut users: BTreeSet<String> = BTreeSet::new();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                let _ = write.send(Message::Close(None)).await;
                break;
            }
            frame = outgoing.recv() => {
                let Some(line) = frame else {
                    let _ = write.send(Message::Close(None)).await;
                    break;
                };
                if !send_line(&mut write, line).await {
                    break;
                }
            }
            incoming = read.next() => {
                let Some(Ok(message)) = incoming else { break };
                // The IRCv3 binary websocket spec carries lines as binary
                // frames (Text is accepted too, defensively — some
                // intermediaries have been known to rewrite frame types).
                let bytes = match message {
                    Message::Binary(b) => b,
                    Message::Text(t) => t.as_bytes().to_vec(),
                    Message::Close(_) => break,
                    _ => continue, // ping/pong — ignore
                };
                let Ok(text) = String::from_utf8(bytes) else { continue };
                let Some(parsed) = irc::parse_line(&text) else { continue };

                match parsed.command.as_str() {
                    "PING" => {
                        let payload = parsed.params.first().cloned().unwrap_or_default();
                        if !send_line(&mut write, irc::format_line("PONG", &[&payload])).await {
                            break;
                        }
                    }
                    "CAP" => match parsed.params.get(1).map(String::as_str) {
                        Some("ACK") => {
                            if !send_line(&mut write, "AUTHENTICATE PLAIN".to_string()).await {
                                break;
                            }
                        }
                        Some("NAK") => {
                            eprintln!("[chat] server rejected the sasl capability");
                            break;
                        }
                        _ => {}
                    },
                    "AUTHENTICATE" => {
                        if parsed.params.first().map(String::as_str) == Some("+") {
                            let payload = irc::sasl_plain_payload(
                                "",
                                &username,
                                &format!("token:{sasl_token}"),
                            );
                            if !send_line(&mut write, irc::format_line("AUTHENTICATE", &[&payload])).await {
                                break;
                            }
                        }
                    }
                    "903" => {
                        // RPL_SASLSUCCESS
                        if !send_line(&mut write, "CAP END".to_string()).await
                            || !send_line(&mut write, irc::format_line("NICK", &[&username])).await
                            || !send_line(
                                &mut write,
                                irc::format_line("USER", &[&username, "0", "*", &username]),
                            )
                            .await
                        {
                            break;
                        }
                    }
                    "904" | "905" => {
                        eprintln!("[chat] sasl authentication failed");
                        break;
                    }
                    "001" => {
                        // RPL_WELCOME — registered, join the default channel.
                        if !send_line(&mut write, irc::format_line("JOIN", &[DEFAULT_CHANNEL])).await {
                            break;
                        }
                    }
                    "353" => {
                        // RPL_NAMREPLY — trailing param is a space-separated nick list.
                        if let Some(names) = parsed.params.last() {
                            for name in names.split_whitespace() {
                                users.insert(irc::strip_nick_prefix(name).to_string());
                            }
                        }
                    }
                    "366" => {
                        // RPL_ENDOFNAMES
                        if !emitter.users(&users).await {
                            break;
                        }
                    }
                    "JOIN" => {
                        if let Some(nick) = parsed.prefix_nick() {
                            users.insert(nick.to_string());
                            if !emitter.users(&users).await {
                                break;
                            }
                        }
                    }
                    "PART" | "QUIT" => {
                        if let Some(nick) = parsed.prefix_nick() {
                            users.remove(nick);
                            if !emitter.users(&users).await {
                                break;
                            }
                        }
                    }
                    "PRIVMSG" => {
                        if let (Some(sender), Some(content)) =
                            (parsed.prefix_nick(), parsed.params.get(1))
                        {
                            if !emitter.message(sender, content).await {
                                break;
                            }
                        }
                    }
                    _ => {} // numeric replies / notices we don't need yet
                }
            }
        }
    }
    eprintln!("[chat] connection closed");
}

#[derive(Debug, Deserialize)]
struct IrcTokenResponse {
    value: String,
}

/// `GET {user_api_base}/irc/ergochat/token` — the one-time SASL token.
async fn fetch_irc_token(
    http: &reqwest::Client,
    user_api_base: &str,
    access_token: &str,
) -> Result<String, String> {
    let resp = http
        .get(format!("{user_api_base}/irc/ergochat/token"))
        .bearer_auth(access_token)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "irc/ergochat/token returned {status}: {}",
            body.chars().take(200).collect::<String>()
        ));
    }

    serde_json::from_str::<IrcTokenResponse>(&body)
        .map(|r| r.value)
        .map_err(|e| format!("invalid JSON: {e}"))
}
