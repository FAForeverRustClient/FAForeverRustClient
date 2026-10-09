//! Real ICE adapter provider: runs FAF's Java adapter `faf-ice-adapter`.
//!
//! Unlike the Go adapter (a GPGNet relay), the Java adapter is driven over
//! **JSON-RPC** ([`jsonrpc`](crate::infra::jsonrpc)) and **hosts the GPGNet port
//! for the game itself** (so there is no relay server, and the adapter: not us,
//! answers `CreateLobby`). It also does not fetch ICE servers itself, so we poll
//! `GET {api}/ice/session/game/{id}` and push them via `setIceServers`. Mirrors the
//! Python client's `IceAdapterClient.py` / `IceAdapterProcess.py` / `IceServersPoller.py`.
//!
//! Located via `FAF_ICE_ADAPTER_JAR` (the `.jar`) + `FAF_JAVA_PATH` (default
//! `java`). Select with `FAF_ICE_ADAPTER_KIND=java` or the connectivity setting.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use faf_domain::state::{RelayPeer, RelaySnapshot, RelayStatus};

use crate::infra::connectivity::IceSessionMemory;
use crate::infra::jsonrpc::{JsonRpcClient, RpcNotification};
use crate::infra::session::TokenStore;
use crate::infra::{console_window, free_ports};
use crate::ports::{ConnectivitySession, IceDebugWindows, IceParams, IcePort, RelayMsg};

/// How long to wait for the adapter's RPC port to come up.
const RPC_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How many times a start is attempted before the ports are treated as the
/// user's problem rather than a race. Three is enough for a collision that
/// happens by chance and few enough that a machine with genuinely no free
/// ports still fails promptly.
const PORT_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone)]
pub struct JavaConfig {
    /// Path to the `java` executable.
    pub java_path: String,
    /// Path to `faf-ice-adapter.jar`.
    pub jar_path: String,
    /// FAF API base (`api.faforever.com`); ICE servers come from `{base}/ice/session/game/{id}`.
    pub api_base: String,
    /// Private adapter diagnostics directory, outside the source/install tree.
    pub log_dir: String,
}

impl JavaConfig {
    pub fn faf() -> Self {
        Self {
            java_path: super::java_runtime::preferred_java_path(),
            jar_path: default_jar_path(),
            api_base: env_or("FAF_API_BASE", "https://api.faforever.com"),
            log_dir: log_directory().to_string_lossy().into_owned(),
        }
    }
}

/// Where the adapters write their logs: `FAF_ICE_LOG_DIR`, or the default
/// below. One answer for the Java adapter, Pioneer, the connectivity check
/// and the shell's "open log folder", so they cannot point at different
/// folders.
pub fn log_directory() -> PathBuf {
    PathBuf::from(env_or("FAF_ICE_LOG_DIR", default_log_dir()))
}

pub(crate) fn default_jar_path() -> String {
    if let Ok(path) = std::env::var("FAF_ICE_ADAPTER_JAR") {
        if !path.trim().is_empty() {
            return path;
        }
    }

    // Never the working directory: see `infra::helper_search_roots`. This jar
    // is handed to a JVM, so a stray copy in a folder the client was started
    // from is code execution.
    let roots = crate::infra::helper_search_roots();

    resolve_jar_from_roots(&roots)
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn resolve_jar_from_roots(roots: &[PathBuf]) -> Option<PathBuf> {
    roots
        .iter()
        .flat_map(|root| {
            [
                root.join("natives")
                    .join("java-ice-adapter")
                    .join("faf-ice-adapter.jar"),
                root.join("resources")
                    .join("natives")
                    .join("java-ice-adapter")
                    .join("faf-ice-adapter.jar"),
                root.join("java-ice-adapter").join("faf-ice-adapter.jar"),
                root.join("faf-ice-adapter.jar"),
            ]
        })
        .find(|candidate| candidate.is_file())
}

fn default_log_dir() -> String {
    // Temp only, so this needs no migration: the old folder is disposable and
    // the OS clears it.
    std::env::temp_dir()
        .join(crate::infra::APP_SLUG)
        .join("iceAdapterLogs")
        .to_string_lossy()
        .into_owned()
}

fn env_or(key: &str, fallback: impl Into<String>) -> String {
    std::env::var(key)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| fallback.into())
}

/// The adapter's own window flags for one launch.
///
/// Off unless somebody is debugging a connection. `--info-window` is the
/// smaller of the two; the Java client offers exactly this pair. The console
/// is not a flag: it is decided when the process is spawned.
fn window_args(windows: IceDebugWindows) -> Vec<String> {
    let mut args = Vec::new();
    if windows.debug {
        args.push("--debug-window".to_string());
    }
    if windows.info {
        args.push("--info-window".to_string());
    }
    args
}

pub struct JavaAdapter {
    config: JavaConfig,
    tokens: TokenStore,
    http: reqwest::Client,
    child: Arc<Mutex<Option<Child>>>,
    rpc: Arc<Mutex<Option<JsonRpcClient>>>,
    /// Pushed by the settings service. Read at launch rather than at
    /// construction so a switch flipped mid-session applies to the next game.
    debug_windows: Arc<Mutex<IceDebugWindows>>,
    /// Where the relay URLs of each session go, for the connectivity check.
    memory: IceSessionMemory,
}

impl JavaAdapter {
    pub fn new(config: JavaConfig, tokens: TokenStore) -> Self {
        Self {
            config,
            tokens,
            http: super::http::shared_http_client(),
            child: Arc::new(Mutex::new(None)),
            rpc: Arc::new(Mutex::new(None)),
            debug_windows: Arc::new(Mutex::new(IceDebugWindows::default())),
            memory: IceSessionMemory::default(),
        }
    }

    pub fn faf(tokens: TokenStore) -> Self {
        Self::new(JavaConfig::faf(), tokens)
    }

    /// Share the session memory the connectivity check reads.
    pub fn remembering(mut self, memory: IceSessionMemory) -> Self {
        self.memory = memory;
        self
    }
}

/// How long the live relay view waits for the adapter's `status` answer. It
/// asks every couple of seconds, so a slower answer is as good as none.
const STATUS_TIMEOUT: Duration = Duration::from_secs(3);

impl JavaAdapter {
    /// One attempt at starting the adapter on a given pair of ports.
    ///
    /// Split out so the caller can have another go: see the note at the call
    /// site about what `free_ports` can and cannot promise.
    async fn spawn_and_connect(
        &self,
        params: &IceParams,
        ice: &IceServers,
        rpc_port: u16,
        gpg_port: u16,
    ) -> Result<(JsonRpcClient, mpsc::Receiver<RpcNotification>), String> {
        let mut args: Vec<String> = vec![
            "-jar".into(),
            self.config.jar_path.clone(),
            "--id".into(),
            params.player_id.to_string(),
            "--login".into(),
            params.player_login.clone(),
            "--game-id".into(),
            params.game_id.to_string(),
            "--rpc-port".into(),
            rpc_port.to_string(),
            "--gpgnet-port".into(),
            gpg_port.to_string(),
        ];
        if ice.force_relay {
            args.push("--force-relay".into());
        }
        let windows = *self.debug_windows.lock().unwrap();
        args.extend(window_args(windows));

        tracing::info!(
            game_id = params.game_id,
            rpc_port,
            gpgnet_port = gpg_port,
            "starting Java ICE adapter"
        );

        std::fs::create_dir_all(&self.config.log_dir)
            .map_err(|error| format!("could not create ICE log directory: {error}"))?;
        // Captured rather than discarded, but only surfaced at TRACE, which is
        // off under the default `faf_app=info` filter. ICE diagnostics can
        // include private network candidates and machine paths, so they stay
        // out of an ordinary log; when a join fails they are the only thing
        // that says why, and `FAF_LOG=faf_app=trace` turns them on. The Python
        // client logs the same stream at its own lowest level.
        let mut command = Command::new(&self.config.java_path);
        command
            .args(&args)
            .env("LOG_DIR", &self.config.log_dir)
            .current_dir(
                Path::new(&self.config.jar_path)
                    .parent()
                    .unwrap_or_else(|| Path::new(".")),
            )
            .stderr(std::process::Stdio::piped());
        // Its own switch: the adapter's windows are its view of the
        // connection, the console is the log it prints while forming one, and
        // wanting one is no reason to be given the other.
        console_window(&mut command, windows.console);
        let mut child = command
            .spawn()
            .map_err(|e| format!("could not start Java ICE adapter: {e}"))?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::trace!(target: "faf_app::ice_adapter", "{line}");
                }
            });
        }
        if let Some(prev) = self.child.lock().unwrap().replace(child) {
            drop(prev);
        }

        // JSON-RPC control channel. A refusal here is usually the adapter
        // having failed to bind one of the ports it was handed, so the caller
        // takes the child with it: leaving a JVM alive that cannot be spoken
        // to would strand a process per attempt.
        match JsonRpcClient::connect("127.0.0.1", rpc_port, RPC_CONNECT_TIMEOUT).await {
            Ok(connected) => Ok(connected),
            Err(reason) => {
                if let Some(mut failed) = self.child.lock().unwrap().take() {
                    let _ = failed.start_kill();
                }
                Err(reason)
            }
        }
    }
}

#[async_trait]
impl IcePort for JavaAdapter {
    async fn start(&self, params: IceParams) -> Result<ConnectivitySession, String> {
        let Some(token) = self.tokens.get() else {
            return Err("no access token (not logged in?)".into());
        };
        if self.config.jar_path.is_empty() {
            return Err("the optional Java ICE adapter is not installed".into());
        }

        // ICE servers (the Java adapter doesn't fetch these itself).
        let ice =
            fetch_ice_servers_retrying(&self.http, &self.config.api_base, &token, params.game_id)
                .await?;
        self.memory.remember_servers(params.game_id, &ice.servers);

        // Reserving a port means binding it and letting it go, so the numbers
        // are free when they are chosen and not necessarily when the adapter
        // binds them a moment later. Losing that race cost a fifteen second
        // wait on the RPC connect and then a join that failed with nothing in
        // the log to say why, so it is worth another go with fresh numbers.
        let mut attempt = 0;
        let (gpg_port, rpc, mut notifications) = loop {
            attempt += 1;
            // Both at once, so they cannot come back as the same number: see
            // `infra::free_ports`.
            let ports = free_ports(2).ok_or("could not reserve the adapter's ports")?;
            let (rpc_port, gpg_port) = (ports[0], ports[1]);
            match self
                .spawn_and_connect(&params, &ice, rpc_port, gpg_port)
                .await
            {
                Ok((rpc, notifications)) => break (gpg_port, rpc, notifications),
                Err(reason) if attempt < PORT_ATTEMPTS => tracing::warn!(
                    attempt,
                    rpc_port,
                    gpgnet_port = gpg_port,
                    %reason,
                    "the ICE adapter did not answer on the ports it was given; retrying"
                ),
                Err(reason) => return Err(reason),
            }
        };

        rpc.call("setIceServers", vec![Value::Array(ice.servers)]);
        rpc.call(
            "setLobbyInitMode",
            vec![Value::String(lobby_init_mode_name(params.init_mode))],
        );

        let (to_lobby_tx, to_lobby_rx) = mpsc::channel::<RelayMsg>(64);
        let (from_lobby_tx, mut from_lobby_rx) = mpsc::channel::<RelayMsg>(64);

        // adapter notifications → lobby.
        tokio::spawn(async move {
            while let Some(note) = notifications.recv().await {
                log_connectivity(&note);
                if let Some(relay) = relay_from_notification(&note) {
                    if to_lobby_tx.send(relay).await.is_err() {
                        break;
                    }
                }
            }
            tracing::warn!("Java ICE adapter notification stream ended");
        });

        // lobby game-relay → adapter RPC calls.
        let rpc_for_calls = rpc.clone();
        tokio::spawn(async move {
            while let Some(msg) = from_lobby_rx.recv().await {
                if let Some((method, p)) = rpc_call_for(&msg) {
                    rpc_for_calls.call(&method, p);
                }
            }
        });

        *self.rpc.lock().unwrap() = Some(rpc);

        Ok(ConnectivitySession {
            game_port: gpg_port,
            to_lobby: to_lobby_rx,
            from_lobby: from_lobby_tx,
        })
    }

    fn stop(&self) {
        if let Some(rpc) = self.rpc.lock().unwrap().take() {
            rpc.call("quit", vec![]);
        }
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.start_kill();
        }
    }

    fn set_debug_windows(&self, windows: IceDebugWindows) {
        *self.debug_windows.lock().unwrap() = windows;
    }

    /// The adapter's `status` call, read into the live relay view. The Python
    /// client's connectivity dialog polls the same call for the same table.
    async fn relay_status(&self) -> RelayStatus {
        let Some(rpc) = self.rpc.lock().unwrap().clone() else {
            return RelayStatus::Idle;
        };
        match rpc.request("status", vec![], STATUS_TIMEOUT).await {
            Ok(answer) => match parse_status(&answer) {
                Some(snapshot) => RelayStatus::Live { snapshot },
                None => RelayStatus::Unavailable {
                    reason: "the adapter's status answer could not be read".into(),
                },
            },
            Err(reason) => RelayStatus::Unavailable { reason },
        }
    }
}

/// Read the adapter's `status` answer.
///
/// `RPCHandler.status` returns its JSON as a *string*, so the result is parsed
/// a second time; an object is accepted too, in case a later build returns one
/// directly. The adapter spells its GPGNet block `gpgpnet` (a typo the Python
/// client works around in the same way), so both spellings are read.
pub(crate) fn parse_status(answer: &Value) -> Option<RelaySnapshot> {
    let parsed;
    let status = match answer {
        Value::String(text) => {
            parsed = serde_json::from_str::<Value>(text).ok()?;
            &parsed
        }
        Value::Object(_) => answer,
        _ => return None,
    };
    let text = |value: Option<&Value>| match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    };
    let gpgnet = status.get("gpgnet").or_else(|| status.get("gpgpnet"));
    let peers = status
        .get("relays")
        .and_then(Value::as_array)
        .map(|relays| {
            relays
                .iter()
                .map(|relay| {
                    let ice = relay.get("ice");
                    let field = |name: &str| text(ice.and_then(|ice| ice.get(name)));
                    RelayPeer {
                        player_id: relay
                            .get("remote_player_id")
                            .and_then(Value::as_i64)
                            .and_then(|id| i32::try_from(id).ok())
                            .unwrap_or(0),
                        login: text(relay.get("remote_player_login")),
                        state: field("state"),
                        connected: ice
                            .and_then(|ice| ice.get("connected"))
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        local_candidate: field("loc_cand_type"),
                        remote_candidate: field("rem_cand_type"),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    Some(RelaySnapshot {
        adapter_version: text(status.get("version")),
        game_state: text(gpgnet.and_then(|gpgnet| gpgnet.get("game_state"))),
        game_connected: gpgnet
            .and_then(|gpgnet| gpgnet.get("connected"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        peers,
    })
}

pub(crate) struct IceServers {
    pub(crate) servers: Vec<Value>,
    force_relay: bool,
}

/// Waits between attempts at the ICE session when the API answers "try again".
///
/// The API answers `/ice/session/game/{id}` with `503 Service Unavailable: no
/// available server` when it has momentarily no relay to hand out, and that
/// failed the whole launch at the first answer: the game was not started and
/// the other players waited on an empty seat. Java treats a 503 (and a 429) as
/// "API unreachable" and retries every request with a backoff
/// (`FafApiAccessor.apiRetrySpec`: 5 attempts, from 5 seconds, with jitter).
///
/// Shorter than Java's on purpose. Java fetches the session in parallel with
/// the map download and the replay server; here it is a step of the launch
/// itself, inside the server's sixty seconds for a matchmaker host
/// (`LadderService.launch_match`), so the waits add up to twenty-one seconds.
const ICE_SESSION_RETRY_WAITS: [std::time::Duration; 4] = [
    std::time::Duration::from_secs(1),
    std::time::Duration::from_secs(3),
    std::time::Duration::from_secs(7),
    std::time::Duration::from_secs(10),
];

/// [`fetch_ice_servers`], tried again while the API says it is busy.
async fn fetch_ice_servers_retrying(
    http: &reqwest::Client,
    api_base: &str,
    token: &str,
    game_id: i32,
) -> Result<IceServers, String> {
    let mut waits = ICE_SESSION_RETRY_WAITS.iter();
    loop {
        match fetch_ice_servers(http, api_base, token, game_id).await {
            Err(IceSessionError::Busy(reason)) => {
                let Some(wait) = waits.next() else {
                    return Err(reason);
                };
                tracing::warn!(
                    game_id,
                    %reason,
                    retry_in_seconds = wait.as_secs(),
                    "the ICE session is not available yet; trying again"
                );
                tokio::time::sleep(*wait).await;
            }
            Err(IceSessionError::Failed(reason)) => return Err(reason),
            Ok(servers) => return Ok(servers),
        }
    }
}

/// Why the ICE session could not be had: worth another try, or not.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum IceSessionError {
    /// 503 or 429: the API's own "not now". The two statuses Java retries.
    Busy(String),
    Failed(String),
}

impl IceSessionError {
    fn for_status(status: reqwest::StatusCode, reason: String) -> Self {
        if status == reqwest::StatusCode::SERVICE_UNAVAILABLE
            || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        {
            Self::Busy(reason)
        } else {
            Self::Failed(reason)
        }
    }
}

/// `GET {api}/ice/session/game/{id}` → `{ servers: [...], forceRelay: bool }`.
pub(crate) async fn fetch_ice_servers(
    http: &reqwest::Client,
    api_base: &str,
    token: &str,
    game_id: i32,
) -> Result<IceServers, IceSessionError> {
    let url = format!(
        "{}/ice/session/game/{game_id}",
        api_base.trim_end_matches('/')
    );
    let resp = http
        .get(&url)
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| IceSessionError::Failed(format!("ice servers request failed: {e}")))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| IceSessionError::Failed(format!("read failed: {e}")))?;
    if !status.is_success() {
        return Err(IceSessionError::for_status(
            status,
            format!(
                "ice servers returned {status}: {}",
                body.chars().take(200).collect::<String>()
            ),
        ));
    }
    let value: Value = serde_json::from_str(&body)
        .map_err(|e| IceSessionError::Failed(format!("invalid JSON: {e}")))?;
    Ok(IceServers {
        servers: value
            .get("servers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        force_relay: value
            .get("forceRelay")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn lobby_init_mode_name(init_mode: i32) -> String {
    if init_mode == 1 { "auto" } else { "normal" }.to_string()
}

/// Record the adapter's own view of connectivity.
///
/// These notifications carry no payload the lobby needs, so they are not
/// relayed; but they are the only thing that says whether ICE ever reached a
/// peer. Without them a failed join is indistinguishable from a working one
/// that the game ignored, which is exactly the position this client was in.
/// The Python client polls `status` on each of these for the same reason.
///
/// Peer ids only: candidate addresses are private network information and stay
/// in the adapter's own `LOG_DIR`.
fn log_connectivity(note: &RpcNotification) {
    match note.method.as_str() {
        "onConnectionStateChanged" => {
            let state = note.params.first().and_then(Value::as_str).unwrap_or("?");
            tracing::info!(state, "ICE adapter connection state");
        }
        "onConnected" => {
            let remote = note.params.get(1).and_then(Value::as_i64).unwrap_or(0);
            let connected = note.params.get(2).and_then(Value::as_bool).unwrap_or(false);
            tracing::info!(remote_player = remote, connected, "ICE peer state");
        }
        "onIceConnectionStateChanged" => {
            let remote = note.params.get(1).and_then(Value::as_i64).unwrap_or(0);
            let state = note.params.get(2).and_then(Value::as_str).unwrap_or("?");
            tracing::info!(remote_player = remote, state, "ICE negotiation state");
        }
        "onGpgNetMessageReceived" => {
            let header = note.params.first().and_then(Value::as_str).unwrap_or("?");
            tracing::debug!(header, "GPGNet message from the game");
        }
        _ => {}
    }
}

/// Map an adapter notification to a lobby relay message (or `None` to ignore).
/// Mirrors `IceAdapterClient.onGpgNetMessageReceived` / `onIceMsg`.
fn relay_from_notification(note: &RpcNotification) -> Option<RelayMsg> {
    match note.method.as_str() {
        // onGpgNetMessageReceived(header, chunks) → {header, chunks}
        "onGpgNetMessageReceived" => {
            let command = note.params.first()?.as_str()?.to_string();
            let args = note
                .params
                .get(1)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            Some(RelayMsg { command, args })
        }
        // onIceMsg(localId, remoteId, iceMsg) → IceMsg[remoteId, iceMsg]
        "onIceMsg" => {
            let remote = note.params.get(1)?.clone();
            let ice_msg = note.params.get(2)?.clone();
            Some(RelayMsg {
                command: "IceMsg".into(),
                args: vec![remote, ice_msg],
            })
        }
        // status/connection notifications aren't needed for connectivity.
        _ => None,
    }
}

/// Map a lobby game-relay message to a JSON-RPC call (method, params), or `None`
/// to ignore. Mirrors `IceAdapterClient.handle_message`.
fn rpc_call_for(msg: &RelayMsg) -> Option<(String, Vec<Value>)> {
    match msg.command.as_str() {
        "SendNatPacket" | "CreatePermission" => None,
        "JoinGame" => Some(("joinGame".into(), msg.args.clone())),
        "ConnectToPeer" => Some(("connectToPeer".into(), msg.args.clone())),
        "IceMsg" => Some(("iceMsg".into(), msg.args.clone())),
        "HostGame" => Some((
            "hostGame".into(),
            msg.args.iter().take(1).cloned().collect(),
        )),
        "DisconnectFromPeer" => Some((
            "disconnectFromPeer".into(),
            msg.args.iter().take(1).cloned().collect(),
        )),
        other => Some((
            "sendToGpgNet".into(),
            vec![
                Value::String(other.to_string()),
                Value::Array(msg.args.clone()),
            ],
        )),
    }
}

#[cfg(test)]
mod tests {
    use crate::ports::IceDebugWindows;

    #[test]
    fn no_windows_are_requested_by_default() {
        assert!(
            super::window_args(IceDebugWindows::default()).is_empty(),
            "a player who never asked for a debugger must not get one"
        );
    }

    #[test]
    fn each_switch_adds_its_own_adapter_flag() {
        assert_eq!(
            super::window_args(IceDebugWindows {
                debug: true,
                ..IceDebugWindows::default()
            }),
            vec!["--debug-window".to_string()]
        );
        assert_eq!(
            super::window_args(IceDebugWindows {
                info: true,
                ..IceDebugWindows::default()
            }),
            vec!["--info-window".to_string()]
        );
        assert_eq!(
            super::window_args(IceDebugWindows {
                debug: true,
                info: true,
                ..IceDebugWindows::default()
            }),
            vec!["--debug-window".to_string(), "--info-window".to_string()]
        );
    }

    /// The console is spawned, not asked for on the command line, so wanting it
    /// must not smuggle a window flag in with it.
    #[test]
    fn the_console_switch_adds_no_adapter_flag() {
        assert!(super::window_args(IceDebugWindows {
            console: true,
            ..IceDebugWindows::default()
        })
        .is_empty());
    }

    use super::*;

    #[test]
    fn only_the_apis_not_now_answers_are_tried_again() {
        // Java's `apiRetrySpec` retries exactly these two.
        for busy in [
            reqwest::StatusCode::SERVICE_UNAVAILABLE,
            reqwest::StatusCode::TOO_MANY_REQUESTS,
        ] {
            assert_eq!(
                IceSessionError::for_status(busy, "x".into()),
                IceSessionError::Busy("x".into())
            );
        }
        for failed in [
            reqwest::StatusCode::UNAUTHORIZED,
            reqwest::StatusCode::NOT_FOUND,
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            assert_eq!(
                IceSessionError::for_status(failed, "x".into()),
                IceSessionError::Failed("x".into())
            );
        }
        // Inside the server's sixty seconds for a matchmaker host.
        let total: u64 = ICE_SESSION_RETRY_WAITS
            .iter()
            .map(|wait| wait.as_secs())
            .sum();
        assert!(total < 30);
    }
    use crate::infra::jsonrpc::RpcNotification;
    use serde_json::json;

    #[test]
    fn maps_gpgnet_notification_to_relay() {
        let note = RpcNotification {
            method: "onGpgNetMessageReceived".into(),
            params: vec![json!("GameState"), json!(["Lobby"])],
        };
        assert_eq!(
            relay_from_notification(&note),
            Some(RelayMsg {
                command: "GameState".into(),
                args: vec![json!("Lobby")],
            })
        );
    }

    #[test]
    fn maps_ice_notification_dropping_local_id() {
        let note = RpcNotification {
            method: "onIceMsg".into(),
            params: vec![json!(7), json!(436001), json!({"type": "candidate"})],
        };
        assert_eq!(
            relay_from_notification(&note),
            Some(RelayMsg {
                command: "IceMsg".into(),
                args: vec![json!(436001), json!({"type": "candidate"})],
            })
        );
    }

    #[test]
    fn ignores_status_notifications() {
        let note = RpcNotification {
            method: "onConnectionStateChanged".into(),
            params: vec![json!("Connected")],
        };
        assert_eq!(relay_from_notification(&note), None);
    }

    #[test]
    fn maps_lobby_messages_to_rpc_calls() {
        let join = RelayMsg {
            command: "JoinGame".into(),
            args: vec![json!("Critren"), json!(436001)],
        };
        assert_eq!(
            rpc_call_for(&join),
            Some(("joinGame".into(), vec![json!("Critren"), json!(436001)]))
        );

        // Unknown command → sendToGpgNet[command, args].
        let other = RelayMsg {
            command: "Bottleneck".into(),
            args: vec![json!(1)],
        };
        assert_eq!(
            rpc_call_for(&other),
            Some(("sendToGpgNet".into(), vec![json!("Bottleneck"), json!([1])]))
        );

        // Ignored commands.
        assert_eq!(
            rpc_call_for(&RelayMsg {
                command: "SendNatPacket".into(),
                args: vec![]
            }),
            None
        );
    }

    #[test]
    fn init_mode_names() {
        assert_eq!(lobby_init_mode_name(0), "normal");
        assert_eq!(lobby_init_mode_name(1), "auto");
    }

    /// The shape `RPCHandler.status` returns: a JSON *string*, with the
    /// adapter's own `gpgpnet` spelling. Field names checked against the
    /// `IceStatus` classes in the bundled jar.
    #[test]
    fn reads_the_adapters_status_answer() {
        let answer = json!(json!({
            "version": "3.3.9",
            "ice_servers_size": 3,
            "lobby_port": 6112,
            "init_mode": "normal",
            "options": { "player_id": 7, "player_login": "Ada", "rpc_port": 7236, "gpgnet_port": 7237 },
            "gpgpnet": { "local_port": 7237, "connected": true, "game_state": "Lobby", "task_string": "-" },
            "relays": [
                {
                    "remote_player_id": 436001,
                    "remote_player_login": "Critren",
                    "local_game_udp_port": 52000,
                    "ice": {
                        "offerer": true,
                        "state": "connected",
                        "gathering_state": "complete",
                        "datachannel_state": "open",
                        "connected": true,
                        "loc_cand_addr": "203.0.113.7:6112",
                        "rem_cand_addr": "198.51.100.4:6112",
                        "loc_cand_type": "srflx",
                        "rem_cand_type": "relay",
                        "time_to_connected": 1.2
                    }
                },
                { "remote_player_id": 9, "remote_player_login": "Bert", "ice": { "state": "checking", "connected": false } }
            ]
        })
        .to_string());

        let snapshot = parse_status(&answer).expect("a status answer");
        assert_eq!(snapshot.adapter_version, "3.3.9");
        assert_eq!(snapshot.game_state, "Lobby");
        assert!(snapshot.game_connected);
        assert_eq!(
            snapshot.peers,
            vec![
                RelayPeer {
                    player_id: 436001,
                    login: "Critren".into(),
                    state: "connected".into(),
                    connected: true,
                    local_candidate: "srflx".into(),
                    remote_candidate: "relay".into(),
                },
                RelayPeer {
                    player_id: 9,
                    login: "Bert".into(),
                    state: "checking".into(),
                    connected: false,
                    local_candidate: String::new(),
                    remote_candidate: String::new(),
                },
            ]
        );
        // The candidate addresses are private network information and are not
        // carried into the state.
        assert!(!format!("{snapshot:?}").contains("203.0.113.7"));
    }

    #[test]
    fn a_status_answer_that_is_not_one_is_refused() {
        assert_eq!(parse_status(&json!("not json")), None);
        assert_eq!(parse_status(&json!(42)), None);
        // An object without the expected blocks still reads, as an empty view.
        assert_eq!(
            parse_status(&json!({ "version": 3 })),
            Some(RelaySnapshot {
                adapter_version: "3".into(),
                ..RelaySnapshot::default()
            })
        );
    }

    #[test]
    fn finds_the_verified_adapter_in_the_development_native_directory() {
        let directory = tempfile::tempdir().unwrap();
        let jar = directory
            .path()
            .join("natives")
            .join("java-ice-adapter")
            .join("faf-ice-adapter.jar");
        std::fs::create_dir_all(jar.parent().unwrap()).unwrap();
        std::fs::write(&jar, b"test adapter").unwrap();

        assert_eq!(
            resolve_jar_from_roots(&[directory.path().to_path_buf()]),
            Some(jar)
        );
    }
}
