//! Real ICE adapter provider: runs FAF's Java adapter `faf-ice-adapter`.
//!
//! Unlike the Go adapter (a GPGNet relay), the Java adapter is driven over
//! **JSON-RPC** ([`jsonrpc`](crate::infra::jsonrpc)) and **hosts the GPGNet port
//! for the game itself** (so there is no relay server, and the adapter: not us,
//! answers `CreateLobby`). The game is launched before the adapter is up, on a
//! port this client holds and passes through to the adapter's, bytes untouched:
//! see [`gpgnet_proxy`](crate::infra::gpgnet_proxy). It also does not fetch ICE
//! servers itself, so we poll
//! `GET {api}/ice/session/game/{id}` and push them via `setIceServers`. Mirrors the
//! Python client's `IceAdapterClient.py` / `IceAdapterProcess.py` / `IceServersPoller.py`.
//!
//! Located via `FAF_ICE_ADAPTER_JAR` (the `.jar`) + `FAF_JAVA_PATH` (default
//! `java`). Select with `FAF_ICE_ADAPTER_KIND=java` or the connectivity setting.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

use faf_domain::state::{RelayPeer, RelaySnapshot, RelayStatus};

use crate::infra::connectivity::IceSessionMemory;
use crate::infra::gpgnet_proxy::GpgNetProxy;
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

    pub fn exp_faf() -> Self {
        Self {
            java_path: super::java_runtime::preferred_java_path(),
            jar_path: default_exp_jar_path(),
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

pub(crate) fn default_exp_jar_path() -> String {
    if let Ok(path) = std::env::var("FAF_EXP_JAVA_ICE_ADAPTER_JAR") {
        if !path.trim().is_empty() {
            return path;
        }
    }

    let roots = crate::infra::helper_search_roots();

    resolve_exp_jar_from_roots(&roots)
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

fn resolve_exp_jar_from_roots(roots: &[PathBuf]) -> Option<PathBuf> {
    roots
        .iter()
        .flat_map(|root| {
            [
                root.join("natives")
                    .join("exp-java-ice-adapter")
                    .join("faf-ice-adapter.jar"),
                root.join("resources")
                    .join("natives")
                    .join("exp-java-ice-adapter")
                    .join("faf-ice-adapter.jar"),
                root.join("exp-java-ice-adapter").join("faf-ice-adapter.jar"),
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
    /// The `forceRelay` of the last session, which the next adapter is
    /// started with: the session may arrive after the adapter, and the switch
    /// is a command-line flag. Server-wide in practice
    /// (`fafProperties.forceRelay()` in the icebreaker), and off.
    force_relay_seen: Arc<AtomicBool>,
    /// The adapter coming up behind a launched game, and the GPGNet port the
    /// game was given meanwhile: both stopped with the adapter, so a game that
    /// ended cannot be failed by what was still on its way.
    bring_up: Mutex<Option<(tokio::task::AbortHandle, GpgNetProxy)>>,
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
            force_relay_seen: Arc::new(AtomicBool::new(false)),
            bring_up: Mutex::new(None),
        }
    }

    pub fn faf(tokens: TokenStore) -> Self {
        Self::new(JavaConfig::faf(), tokens)
    }

    pub fn exp_faf(tokens: TokenStore) -> Self {
        Self::new(JavaConfig::exp_faf(), tokens)
    }

    /// Share the session memory the connectivity check reads.
    pub fn remembering(mut self, memory: IceSessionMemory) -> Self {
        self.memory = memory;
        self
    }

    /// Stop bringing an adapter up, and close the game's GPGNet port.
    fn halt_bring_up(&self) {
        if let Some((running, proxy)) = self.bring_up.lock().unwrap().take() {
            running.abort();
            drop(proxy);
        }
    }
}

/// How long the live relay view waits for the adapter's `status` answer. It
/// asks every couple of seconds, so a slower answer is as good as none.
const STATUS_TIMEOUT: Duration = Duration::from_secs(3);

/// What starting an adapter process needs: owned, so that the start can run
/// behind the game.
#[derive(Clone)]
struct AdapterProcess {
    config: JavaConfig,
    child: Arc<Mutex<Option<Child>>>,
    /// Read once per launch: a switch flipped mid-game applies to the next.
    windows: IceDebugWindows,
}

impl AdapterProcess {
    /// One attempt at starting the adapter on a given pair of ports.
    ///
    /// Split out so the caller can have another go: see the note at the call
    /// site about what `free_ports` can and cannot promise.
    async fn spawn_and_connect(
        &self,
        params: &IceParams,
        force_relay: bool,
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
        if force_relay {
            args.push("--force-relay".into());
        }
        let windows = self.windows;
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
        // An adapter still recorded here is one nothing speaks to any more:
        // stopped, not merely forgotten, which would leave its JVM running.
        if let Some(mut previous) = self.child.lock().unwrap().replace(child) {
            let _ = previous.start_kill();
        }

        // JSON-RPC control channel. A refusal here is usually the adapter
        // having failed to bind one of the ports it was handed, so the caller
        // takes the child with it: leaving a JVM alive that cannot be spoken
        // to would strand a process per attempt.
        match JsonRpcClient::connect("127.0.0.1", rpc_port, RPC_CONNECT_TIMEOUT).await {
            Ok(connected) => Ok(connected),
            Err(reason) => {
                self.kill_child();
                Err(reason)
            }
        }
    }

    /// Start the adapter on ports free at the time, trying fresh ones when it
    /// does not answer on the first.
    ///
    /// Reserving a port means binding it and letting it go, so the numbers
    /// are free when they are chosen and not necessarily when the adapter
    /// binds them a moment later. Losing that race cost a fifteen second wait
    /// on the RPC connect and then a join that failed with nothing in the log
    /// to say why, so it is worth another go with fresh numbers.
    async fn spawn_on_free_ports(
        &self,
        params: &IceParams,
        force_relay: bool,
        asked: std::time::Instant,
    ) -> Result<SpawnedAdapter, String> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            // Both at once, so they cannot come back as the same number: see
            // `infra::free_ports`.
            let ports = free_ports(2).ok_or("could not reserve the adapter's ports")?;
            let (rpc_port, gpg_port) = (ports[0], ports[1]);
            match self
                .spawn_and_connect(params, force_relay, rpc_port, gpg_port)
                .await
            {
                Ok((rpc, notifications)) => {
                    tracing::info!(
                        game_id = params.game_id,
                        attempt,
                        force_relay,
                        milliseconds = asked.elapsed().as_millis() as u64,
                        "the ICE adapter answered"
                    );
                    return Ok((gpg_port, rpc, notifications));
                }
                Err(reason) if attempt < PORT_ATTEMPTS => tracing::warn!(
                    attempt,
                    rpc_port,
                    gpgnet_port = gpg_port,
                    %reason,
                    "the ICE adapter did not answer on the ports it was given; retrying"
                ),
                Err(reason) => return Err(reason),
            }
        }
    }

    /// Stop the adapter process this start launched, if one is running.
    fn kill_child(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.start_kill();
        }
    }
}

/// A started adapter: its GPGNet port, its control channel and what it says.
type SpawnedAdapter = (u16, JsonRpcClient, mpsc::Receiver<RpcNotification>);

/// What [`adapter_and_session`] reads from a session.
trait ForcesRelay {
    fn force_relay(&self) -> bool;
}

impl ForcesRelay for IceServers {
    fn force_relay(&self) -> bool {
        self.force_relay
    }
}

/// How far [`adapter_and_session`] got before the game can be started.
enum Started<S, A, Session> {
    /// The session came first, and the adapter runs with what it says.
    Complete(S, A),
    /// The adapter answered first. The session is still on its way, and the
    /// game is started without waiting for it.
    Early(A, Session),
}

/// Start the adapter while the ICE session is fetched, and answer as soon as
/// the adapter does (#511).
///
/// The adapter needs its ICE servers only once it connects to a peer
/// (`PeerIceModule.gatherCandidates`), and `setIceServers` can be sent at
/// any time; Java and Python send it after the start anyway. The game, on the
/// other hand, takes a quarter of a minute to reach its lobby, and the session
/// has taken ten seconds of that on its own (FAF's icebreaker). So the game no
/// longer waits for it.
///
/// - The adapter is started with `force_relay`, the last thing a session
///   said: the flag is a command-line switch and cannot be sent later.
/// - A session that comes first and disagrees gets the adapter started again
///   with its own answer, before anything has been told to it.
/// - A session that cannot be had before the adapter answers stops the
///   adapter, whether it is already up or still starting.
/// - An adapter that cannot be started ends the wait for the session.
///
/// Generic over the two steps so that this ordering can be tested without a
/// JVM or the API.
async fn adapter_and_session<S, A, Session, Spawn>(
    mut session: Session,
    force_relay: bool,
    spawn: impl Fn(bool) -> Spawn,
    kill: impl Fn(),
) -> Result<Started<S, A, Session>, String>
where
    S: ForcesRelay,
    Session: std::future::Future<Output = Result<S, String>> + Unpin,
    Spawn: std::future::Future<Output = Result<A, String>>,
{
    let mut starting = Box::pin(spawn(force_relay));
    tokio::select! {
        fetched = &mut session => {
            let fetched = match fetched {
                Ok(fetched) => fetched,
                Err(reason) => {
                    drop(starting);
                    kill();
                    return Err(reason);
                }
            };
            let adapter = starting.await?;
            if fetched.force_relay() == force_relay {
                return Ok(Started::Complete(fetched, adapter));
            }
            tracing::info!(
                force_relay = fetched.force_relay(),
                "the ICE session asks for another relay switch; restarting the adapter before the game starts"
            );
            drop(adapter);
            kill();
            let adapter = spawn(fetched.force_relay()).await?;
            Ok(Started::Complete(fetched, adapter))
        }
        // Dropping `session` on a failed start is what stops the fetch.
        started = &mut starting => Ok(Started::Early(started?, session)),
    }
}

/// Wait out a session the game was started without, and say whether the
/// adapter can use it.
///
/// Usable unless it cannot be had, or it forces relaying on an adapter that
/// was started without `--force-relay`: the switch cannot be sent later, and
/// the adapter cannot be restarted under a game that is connected to it. Then
/// `failed` hears why, and the launcher stops the game. The answer is
/// remembered in `seen`, so the next launch starts the adapter with it and
/// this happens once, when FAF turns the switch on.
///
/// The other way round is left running: an adapter that relays although the
/// session would allow direct connections still connects.
async fn finish_late_session<S, Session>(
    session: Session,
    adapter_forces_relay: bool,
    seen: &AtomicBool,
    failed: oneshot::Sender<String>,
) -> Option<S>
where
    S: ForcesRelay,
    Session: std::future::Future<Output = Result<S, String>>,
{
    match session.await {
        Ok(fetched) => {
            seen.store(fetched.force_relay(), Ordering::SeqCst);
            if fetched.force_relay() && !adapter_forces_relay {
                tracing::warn!("forceRelay changed; launch abandoned");
                let _ = failed.send(
                    "the FAF server switched this game to relayed connections after it started; \
                     please join again"
                        .to_string(),
                );
                return None;
            }
            Some(fetched)
        }
        Err(reason) => {
            let _ = failed.send(reason);
            None
        }
    }
}

/// Lobby messages to the adapter, held back while it has no ICE servers.
///
/// What only concerns the game passes: `HostGame`, and the server's GPGNet
/// messages for it. The first message that concerns a peer, and everything
/// after it, is kept until the servers are set, then let through in the order
/// it came. Nothing later ever overtakes something earlier: an `IceMsg` ahead
/// of its `ConnectToPeer` is a peer that never connects.
#[derive(Debug, Default)]
struct RelayGate {
    open: bool,
    held: Vec<RelayMsg>,
}

impl RelayGate {
    /// `msg` if it may go to the adapter now; otherwise it is kept.
    fn pass(&mut self, msg: RelayMsg) -> Option<RelayMsg> {
        if self.open || (self.held.is_empty() && !needs_peers(&msg.command)) {
            return Some(msg);
        }
        self.held.push(msg);
        None
    }

    /// Open for good, and hand back what was kept, in order.
    fn open(&mut self) -> Vec<RelayMsg> {
        self.open = true;
        std::mem::take(&mut self.held)
    }
}

/// The lobby messages that make the adapter reach for a peer, which it does
/// with the ICE servers it was given.
fn needs_peers(command: &str) -> bool {
    matches!(
        command,
        "JoinGame" | "ConnectToPeer" | "IceMsg" | "DisconnectFromPeer"
    )
}

/// What the adapter needs from its control channel here: one call at a time,
/// in order. A trait so that the lobby forwarding can be tested without a JVM.
trait RpcCalls {
    fn call(&self, method: &str, params: Vec<Value>);
}

impl RpcCalls for JsonRpcClient {
    fn call(&self, method: &str, params: Vec<Value>) {
        JsonRpcClient::call(self, method, params);
    }
}

/// Lobby game-relay messages to the adapter, from the moment the game is
/// launched.
///
/// Until the adapter answers, everything is kept as it came. Then it goes
/// through the [`RelayGate`], which holds what concerns a peer until the ICE
/// servers are set, and `setIceServers` goes out the moment both the adapter
/// and the servers are there. One task for all of it, so nothing can overtake
/// `setIceServers` or anything that came before it.
///
/// An adapter that never answers leaves nothing to send to: the messages are
/// dropped from then on, still read so the lobby is never kept waiting, and
/// the launcher stops the game for it.
async fn forward_lobby_messages<R: RpcCalls>(
    mut from_lobby: mpsc::Receiver<RelayMsg>,
    mut answered: oneshot::Receiver<R>,
    mut servers: oneshot::Receiver<Vec<Value>>,
    asked: std::time::Instant,
) {
    let mut adapter: Option<R> = None;
    let mut awaiting_adapter = true;
    let mut awaiting_servers = true;
    let mut before_the_adapter: Vec<RelayMsg> = Vec::new();
    let mut gate = RelayGate::default();
    loop {
        tokio::select! {
            biased;
            up = &mut answered, if awaiting_adapter => {
                awaiting_adapter = false;
                let Ok(up) = up else {
                    before_the_adapter.clear();
                    continue;
                };
                for msg in before_the_adapter.drain(..) {
                    if let Some(msg) = gate.pass(msg) {
                        forward_to_adapter(&up, &msg);
                    }
                }
                adapter = Some(up);
            }
            arrived = &mut servers, if awaiting_servers && adapter.is_some() => {
                awaiting_servers = false;
                // None at all: the session failed, and the launcher stops the
                // game and this adapter.
                let (Ok(servers), Some(adapter)) = (arrived, adapter.as_ref()) else {
                    continue;
                };
                adapter.call("setIceServers", vec![Value::Array(servers)]);
                let held = gate.open();
                tracing::info!(
                    held = held.len(),
                    milliseconds = asked.elapsed().as_millis() as u64,
                    "ICE session arrived, releasing held messages"
                );
                for msg in &held {
                    forward_to_adapter(adapter, msg);
                }
            }
            msg = from_lobby.recv() => {
                let Some(msg) = msg else {
                    break;
                };
                match adapter.as_ref() {
                    Some(adapter) => {
                        if let Some(msg) = gate.pass(msg) {
                            forward_to_adapter(adapter, &msg);
                        }
                    }
                    None if awaiting_adapter => before_the_adapter.push(msg),
                    None => {}
                }
            }
        }
    }
}

/// Everything [`JavaAdapter::start`] hands to the task that brings the
/// adapter up behind the game.
struct BringUp {
    process: AdapterProcess,
    params: IceParams,
    asked: std::time::Instant,
    force_relay_seen: Arc<AtomicBool>,
    memory: IceSessionMemory,
    rpc: Arc<Mutex<Option<JsonRpcClient>>>,
    adapter_port: tokio::sync::watch::Sender<Option<u16>>,
    to_lobby: mpsc::Sender<RelayMsg>,
    answered: oneshot::Sender<JsonRpcClient>,
    servers: oneshot::Sender<Vec<Value>>,
    failed: oneshot::Sender<String>,
}

impl BringUp {
    /// Start the adapter and see the session through, while the game loads.
    ///
    /// Aborted by `stop`, which drops `failed` unanswered: a game that ended
    /// or was called off is not failed by what was still on its way.
    async fn run<Session>(self, session: Session)
    where
        Session: std::future::Future<Output = Result<IceServers, String>> + Unpin,
    {
        let Self {
            process,
            params,
            asked,
            force_relay_seen,
            memory,
            rpc: rpc_slot,
            adapter_port,
            to_lobby,
            answered,
            servers,
            failed,
        } = self;
        let game_id = params.game_id;
        let adapter_forces_relay = force_relay_seen.load(Ordering::SeqCst);
        let started = adapter_and_session(
            session,
            adapter_forces_relay,
            |force_relay| process.spawn_on_free_ports(&params, force_relay, asked),
            || process.kill_child(),
        )
        .await;
        let (adapter, late) = match started {
            Ok(Started::Complete(ice, adapter)) => {
                force_relay_seen.store(ice.force_relay, Ordering::SeqCst);
                memory.remember_servers(game_id, &ice.servers);
                let _ = servers.send(ice.servers);
                (adapter, None)
            }
            Ok(Started::Early(adapter, session)) => {
                tracing::info!(
                    game_id,
                    milliseconds = asked.elapsed().as_millis() as u64,
                    "the ICE adapter is up before the ICE session; the game does not wait for it"
                );
                (adapter, Some((session, servers)))
            }
            Err(reason) => {
                let _ = failed.send(reason);
                return;
            }
        };
        let (gpg_port, rpc, mut notifications) = adapter;

        rpc.call(
            "setLobbyInitMode",
            vec![Value::String(lobby_init_mode_name(params.init_mode))],
        );

        // adapter notifications → lobby.
        tokio::spawn(async move {
            while let Some(note) = notifications.recv().await {
                log_connectivity(&note);
                if let Some(relay) = relay_from_notification(&note) {
                    if to_lobby.send(relay).await.is_err() {
                        break;
                    }
                }
            }
            tracing::warn!("Java ICE adapter notification stream ended");
        });

        *rpc_slot.lock().unwrap() = Some(rpc.clone());
        let _ = answered.send(rpc);
        // The game's connection goes through from here, or right away when
        // the game connects later, which is the usual order.
        let _ = adapter_port.send(Some(gpg_port));

        let Some((session, servers)) = late else {
            return;
        };
        if let Some(ice) =
            finish_late_session(session, adapter_forces_relay, &force_relay_seen, failed).await
        {
            memory.remember_servers(game_id, &ice.servers);
            let _ = servers.send(ice.servers);
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
        // Whatever an earlier game left starting is no use to this one.
        self.halt_bring_up();

        // The game is launched as soon as this returns, on a GPGNet port this
        // client holds (`GpgNetProxy`), and loads for eleven seconds or more
        // before it connects there. The adapter, about two seconds of JVM
        // start, and the ICE session, ten seconds of FAF's icebreaker (#493,
        // #511), come up behind it, in `bring_up`. Anything that goes wrong
        // there reaches the launcher through `late_failure`, which stops the
        // game.
        //
        // Java fetches the session, then starts the adapter, then the game
        // (`GameRunner.startIceAdapter`), which is the sum of all three.
        let asked = std::time::Instant::now();
        let proxy = GpgNetProxy::open()
            .await
            .map_err(|error| format!("could not open the game's GPGNet port: {error}"))?;
        let game_port = proxy.port();
        let game_id = params.game_id;
        // The servers remembered for the last game are not this one's.
        self.memory.remember_game(game_id);

        let http = self.http.clone();
        let api_base = self.config.api_base.clone();
        // Owned, so that it can go on after this call.
        let session = Box::pin(async move {
            let ice = fetch_ice_servers_retrying(&http, &api_base, &token, game_id)
                .await
                // Said in so many words when they are missing: the bare status
                // read as if the adapter on the player's machine had failed,
                // when it was never run.
                .map_err(|reason| {
                    format!("the FAF server did not hand out this game's relay servers ({reason})")
                })?;
            tracing::info!(
                game_id,
                milliseconds = asked.elapsed().as_millis() as u64,
                "the ICE session arrived"
            );
            Ok::<_, String>(ice)
        });

        let (to_lobby_tx, to_lobby_rx) = mpsc::channel::<RelayMsg>(64);
        let (from_lobby_tx, from_lobby_rx) = mpsc::channel::<RelayMsg>(64);
        let (answered_tx, answered_rx) = oneshot::channel::<JsonRpcClient>();
        let (servers_tx, servers_rx) = oneshot::channel::<Vec<Value>>();
        let (failed_tx, failed_rx) = oneshot::channel::<String>();

        // lobby game-relay → adapter RPC calls. Started now, so the lobby is
        // never kept waiting on a full channel while the adapter starts.
        tokio::spawn(forward_lobby_messages(
            from_lobby_rx,
            answered_rx,
            servers_rx,
            asked,
        ));

        let bring_up = BringUp {
            process: AdapterProcess {
                config: self.config.clone(),
                child: self.child.clone(),
                windows: *self.debug_windows.lock().unwrap(),
            },
            params,
            asked,
            force_relay_seen: self.force_relay_seen.clone(),
            memory: self.memory.clone(),
            rpc: self.rpc.clone(),
            adapter_port: proxy.adapter_port(),
            to_lobby: to_lobby_tx,
            answered: answered_tx,
            servers: servers_tx,
            failed: failed_tx,
        };
        let running = tokio::spawn(bring_up.run(session));
        *self.bring_up.lock().unwrap() = Some((running.abort_handle(), proxy));
        tracing::info!(
            game_id,
            milliseconds = asked.elapsed().as_millis() as u64,
            "the game's GPGNet port is open; the ICE adapter starts behind the game"
        );

        Ok(ConnectivitySession {
            game_port,
            to_lobby: to_lobby_rx,
            from_lobby: from_lobby_tx,
            late_failure: Some(failed_rx),
        })
    }

    fn stop(&self) {
        // First, so that nothing it was about to start outlives the kill below.
        self.halt_bring_up();
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
    /// 503 or 429, the API's own "not now" and the two statuses Java retries,
    /// or 502 from the gateway in front of it.
    Busy(String),
    Failed(String),
}

impl IceSessionError {
    /// 502 is retried where Java does not retry it. `api.faforever.com` sits
    /// behind Cloudflare, and `502 Bad Gateway: error code: 502` is
    /// Cloudflare's own answer when it got nothing usable from FAF's ingress:
    /// a moment on the server's side, not a fault of the request, and it
    /// failed launches in clusters in October 2026. Cloudflare usually
    /// answers it at once, so the waits above still fit the launch. 504 is left out:
    /// Cloudflare sends it only after its hundred-second origin timeout, when
    /// the launch is lost already.
    fn for_status(status: reqwest::StatusCode, reason: String) -> Self {
        if status == reqwest::StatusCode::SERVICE_UNAVAILABLE
            || status == reqwest::StatusCode::TOO_MANY_REQUESTS
            || status == reqwest::StatusCode::BAD_GATEWAY
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

/// Hand one lobby message to the adapter, as the call it maps to.
fn forward_to_adapter(rpc: &impl RpcCalls, msg: &RelayMsg) {
    if let Some((method, params)) = rpc_call_for(msg) {
        rpc.call(&method, params);
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

    /// A fake session for [`adapter_and_session`].
    struct FakeSession(bool);

    impl ForcesRelay for FakeSession {
        fn force_relay(&self) -> bool {
            self.0
        }
    }

    /// Counts what [`adapter_and_session`] starts and stops: every start is
    /// one adapter process, every kill stops the one that is running.
    #[derive(Default)]
    struct Starts {
        started: std::sync::Mutex<Vec<bool>>,
        running: std::sync::atomic::AtomicI32,
        killed: std::sync::atomic::AtomicI32,
    }

    impl Starts {
        async fn spawn(&self, force_relay: bool, delay_ms: u64, fail: bool) -> Result<u32, String> {
            use std::sync::atomic::Ordering;
            self.started.lock().unwrap().push(force_relay);
            self.running.store(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            if fail {
                // As `spawn_and_connect` does: a start that fails stops its
                // own process.
                self.running.store(0, Ordering::SeqCst);
                return Err("the adapter did not answer".into());
            }
            Ok(7)
        }

        fn kill(&self) {
            use std::sync::atomic::Ordering;
            self.killed.fetch_add(1, Ordering::SeqCst);
            self.running.store(0, Ordering::SeqCst);
        }

        fn running(&self) -> i32 {
            self.running.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    fn session_after(
        delay_ms: u64,
        outcome: Result<bool, &'static str>,
    ) -> std::pin::Pin<Box<impl std::future::Future<Output = Result<FakeSession, String>>>> {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            outcome.map(FakeSession).map_err(str::to_string)
        })
    }

    #[tokio::test(start_paused = true)]
    async fn the_game_does_not_wait_for_a_session_slower_than_the_adapter() {
        // His log for #511: the adapter answered after about 2.5 seconds, the
        // session after ten.
        let starts = Starts::default();
        let begun = tokio::time::Instant::now();
        let started = adapter_and_session(
            session_after(10_000, Ok(false)),
            false,
            |force| starts.spawn(force, 2_500, false),
            || starts.kill(),
        )
        .await
        .unwrap();
        let Started::Early(adapter, session) = started else {
            panic!("the launch waited for the session");
        };
        assert_eq!(adapter, 7);
        assert_eq!(begun.elapsed(), Duration::from_millis(2_500));
        assert_eq!(*starts.started.lock().unwrap(), [false]);
        assert_eq!(starts.running(), 1, "the adapter is left running");

        // The session is still on its way, and arrives in its own time.
        let fetched = session.await.unwrap();
        assert!(!fetched.0);
        assert_eq!(begun.elapsed(), Duration::from_millis(10_000));
    }

    #[tokio::test(start_paused = true)]
    async fn a_session_that_comes_first_is_handed_over_with_the_adapter() {
        let starts = Starts::default();
        let begun = tokio::time::Instant::now();
        let started = adapter_and_session(
            session_after(800, Ok(false)),
            false,
            |force| starts.spawn(force, 2_500, false),
            || starts.kill(),
        )
        .await
        .unwrap();
        let Started::Complete(session, adapter) = started else {
            panic!("a session that was there is not handed over as pending");
        };
        assert!(!session.0);
        assert_eq!(adapter, 7);
        assert_eq!(
            begun.elapsed(),
            Duration::from_millis(2_500),
            "the longer of the two, not their sum"
        );
        assert_eq!(*starts.started.lock().unwrap(), [false]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_session_that_comes_first_and_forces_relaying_restarts_the_adapter() {
        let starts = Starts::default();
        let started = adapter_and_session(
            session_after(800, Ok(true)),
            false,
            |force| starts.spawn(force, 2_500, false),
            || starts.kill(),
        )
        .await
        .unwrap();
        assert!(matches!(started, Started::Complete(FakeSession(true), _)));
        assert_eq!(
            *starts.started.lock().unwrap(),
            [false, true],
            "started without the flag, then again with it"
        );
        assert_eq!(starts.killed.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(starts.running(), 1, "only the second one is running");
    }

    #[tokio::test(start_paused = true)]
    async fn the_adapter_starts_with_the_switch_the_last_session_asked_for() {
        let starts = Starts::default();
        let started = adapter_and_session(
            session_after(800, Ok(true)),
            true,
            |force| starts.spawn(force, 2_500, false),
            || starts.kill(),
        )
        .await
        .unwrap();
        assert!(matches!(started, Started::Complete(FakeSession(true), _)));
        assert_eq!(*starts.started.lock().unwrap(), [true], "started once");
        assert_eq!(starts.killed.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_session_that_fails_while_the_adapter_starts_stops_it_at_once() {
        let starts = Starts::default();
        let begun = tokio::time::Instant::now();
        let failed = adapter_and_session(
            session_after(300, Err("no access")),
            false,
            |force| starts.spawn(force, 2_500, false),
            || starts.kill(),
        )
        .await;
        assert_eq!(failed.err().as_deref(), Some("no access"));
        assert_eq!(
            begun.elapsed(),
            Duration::from_millis(300),
            "the start is not waited out"
        );
        assert_eq!(starts.running(), 0, "the process it launched is stopped");
    }

    #[tokio::test(start_paused = true)]
    async fn an_adapter_that_cannot_start_ends_the_wait_for_the_session() {
        let starts = Starts::default();
        let begun = tokio::time::Instant::now();
        let failed = adapter_and_session(
            session_after(20_000, Ok(false)),
            false,
            |force| starts.spawn(force, 1_000, true),
            || starts.kill(),
        )
        .await;
        assert_eq!(failed.err().as_deref(), Some("the adapter did not answer"));
        assert_eq!(begun.elapsed(), Duration::from_millis(1_000));
        assert_eq!(starts.running(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_late_session_that_arrives_is_handed_on_and_reports_nothing() {
        let seen = AtomicBool::new(false);
        let (failed, mut failure) = oneshot::channel();
        let late =
            finish_late_session(session_after(10_000, Ok(false)), false, &seen, failed).await;
        assert!(matches!(late, Some(FakeSession(false))));
        assert!(
            failure.try_recv().is_err(),
            "the launcher hears nothing and stops listening"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_late_session_that_fails_reaches_the_launcher() {
        let seen = AtomicBool::new(false);
        let (failed, failure) = oneshot::channel();
        let late = finish_late_session(
            session_after(21_000, Err("ice servers returned 503")),
            false,
            &seen,
            failed,
        )
        .await;
        assert!(late.is_none(), "nothing is handed to the adapter");
        assert_eq!(failure.await.as_deref(), Ok("ice servers returned 503"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_late_session_that_forces_relaying_fails_the_game_once_and_is_remembered() {
        let seen = AtomicBool::new(false);
        let (failed, failure) = oneshot::channel();
        let late = finish_late_session(session_after(10_000, Ok(true)), false, &seen, failed).await;
        assert!(late.is_none());
        assert!(failure.await.unwrap().contains("please join again"));
        assert!(
            seen.load(Ordering::SeqCst),
            "the next adapter starts with --force-relay"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn an_adapter_that_relays_when_it_need_not_is_left_running() {
        let seen = AtomicBool::new(true);
        let (failed, mut failure) = oneshot::channel();
        let late = finish_late_session(session_after(10_000, Ok(false)), true, &seen, failed).await;
        assert!(matches!(late, Some(FakeSession(false))));
        assert!(failure.try_recv().is_err());
        assert!(
            !seen.load(Ordering::SeqCst),
            "the next adapter starts without the flag"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_late_session_stopped_with_the_adapter_leaves_the_launcher_nothing_to_wait_for() {
        // `stop` aborts the task: a game that ended, or a launch called off,
        // must not be failed by a session that was still on its way.
        let seen = std::sync::Arc::new(AtomicBool::new(false));
        let (failed, failure) = oneshot::channel::<String>();
        let waiting = seen.clone();
        let pending = tokio::spawn(async move {
            finish_late_session(
                session_after(10_000, Err("too late")),
                false,
                &waiting,
                failed,
            )
            .await;
        });
        tokio::time::sleep(Duration::from_millis(3_000)).await;
        pending.abort();
        assert!(
            failure.await.is_err(),
            "closed without an answer, not left hanging"
        );
    }

    fn relay(command: &str) -> RelayMsg {
        RelayMsg {
            command: command.into(),
            args: Vec::new(),
        }
    }

    fn commands(msgs: &[RelayMsg]) -> Vec<&str> {
        msgs.iter().map(|msg| msg.command.as_str()).collect()
    }

    #[test]
    fn the_gate_lets_the_host_through_and_holds_from_the_first_peer_on() {
        let mut gate = RelayGate::default();
        assert_eq!(gate.pass(relay("HostGame")), Some(relay("HostGame")));
        assert_eq!(gate.pass(relay("GameOption")), Some(relay("GameOption")));

        assert_eq!(gate.pass(relay("JoinGame")), None);
        // Nothing overtakes what is held, a game-only message included.
        assert_eq!(gate.pass(relay("GameOption")), None);
        assert_eq!(gate.pass(relay("ConnectToPeer")), None);
        assert_eq!(gate.pass(relay("IceMsg")), None);

        assert_eq!(
            commands(&gate.open()),
            ["JoinGame", "GameOption", "ConnectToPeer", "IceMsg"],
            "released in the order they came"
        );
        assert_eq!(gate.pass(relay("IceMsg")), Some(relay("IceMsg")));
        assert!(gate.open().is_empty());
    }

    #[test]
    fn every_message_that_reaches_for_a_peer_is_held() {
        for command in ["JoinGame", "ConnectToPeer", "IceMsg", "DisconnectFromPeer"] {
            let mut gate = RelayGate::default();
            assert_eq!(gate.pass(relay(command)), None, "{command}");
        }
    }

    /// The adapter's calls, by name, in the order the forwarder made them.
    #[derive(Clone, Default)]
    struct Recorded(std::sync::Arc<std::sync::Mutex<Vec<String>>>);

    impl RpcCalls for Recorded {
        fn call(&self, method: &str, _params: Vec<Value>) {
            self.0.lock().unwrap().push(method.to_string());
        }
    }

    impl Recorded {
        fn calls(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
    }

    /// Let the forwarder catch up with what was just sent to it.
    async fn settle() {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    struct Forwarder {
        lobby: mpsc::Sender<RelayMsg>,
        answered: oneshot::Sender<Recorded>,
        servers: oneshot::Sender<Vec<Value>>,
    }

    fn forwarder() -> Forwarder {
        let (lobby, from_lobby) = mpsc::channel(64);
        let (answered, answered_rx) = oneshot::channel();
        let (servers, servers_rx) = oneshot::channel();
        tokio::spawn(forward_lobby_messages(
            from_lobby,
            answered_rx,
            servers_rx,
            std::time::Instant::now(),
        ));
        Forwarder {
            lobby,
            answered,
            servers,
        }
    }

    #[tokio::test]
    async fn what_the_lobby_sends_before_the_adapter_answers_is_kept_for_it() {
        let f = forwarder();
        f.lobby.send(relay("HostGame")).await.unwrap();
        f.lobby.send(relay("JoinGame")).await.unwrap();
        settle().await;

        let adapter = Recorded::default();
        assert!(f.answered.send(adapter.clone()).is_ok());
        settle().await;
        assert_eq!(
            adapter.calls(),
            ["hostGame"],
            "the host goes through, the peer waits for the servers"
        );

        f.lobby.send(relay("ConnectToPeer")).await.unwrap();
        settle().await;
        assert_eq!(adapter.calls(), ["hostGame"]);

        f.servers
            .send(vec![json!({ "urls": "turn:relay" })])
            .unwrap();
        settle().await;
        assert_eq!(
            adapter.calls(),
            ["hostGame", "setIceServers", "joinGame", "connectToPeer"]
        );
    }

    #[tokio::test]
    async fn servers_that_come_before_the_adapter_are_set_before_anything_it_held() {
        let f = forwarder();
        f.servers
            .send(vec![json!({ "urls": "turn:relay" })])
            .unwrap();
        f.lobby.send(relay("JoinGame")).await.unwrap();
        settle().await;

        let adapter = Recorded::default();
        assert!(f.answered.send(adapter.clone()).is_ok());
        settle().await;
        assert_eq!(adapter.calls(), ["setIceServers", "joinGame"]);
    }

    #[tokio::test]
    async fn an_adapter_that_never_answers_never_keeps_the_lobby_waiting() {
        let f = forwarder();
        drop(f.answered);
        tokio::time::timeout(Duration::from_secs(5), async {
            for _ in 0..500 {
                f.lobby.send(relay("IceMsg")).await.unwrap();
            }
        })
        .await
        .expect("the messages are read and dropped, not left to fill the channel");
    }

    #[test]
    fn only_the_not_now_answers_are_tried_again() {
        // Java's `apiRetrySpec` retries the first two; the gateway's 502 is
        // this client's addition.
        for busy in [
            reqwest::StatusCode::SERVICE_UNAVAILABLE,
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            reqwest::StatusCode::BAD_GATEWAY,
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
            reqwest::StatusCode::GATEWAY_TIMEOUT,
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
