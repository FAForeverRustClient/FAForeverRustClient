//! Live spectating: relaying a game in progress from the replay server to FA.
//!
//! Separate from file playback because nothing here reads a replay file: the
//! stream is fetched, gated on its first frame and relayed byte for byte over
//! a local transport, and which transport is its own subject.
//!
//! ## Live-watch protocol
//! 1. `GET {user_api}/replay/access` (bearer token) → `{ accessUrl }` (same
//!    endpoint and response shape as the lobby's `/lobby/access`, see
//!    `infra::fetch_access_url`).
//! 2. Open a WebSocket to `accessUrl`; send one binary frame
//!    `G/{uid}/{player}.scfareplay\0` (the player name is irrelevant to the
//!    server, which merges every participant's stream: any non-empty string
//!    works, per the Python client's own comment).
//! 3. Wait for the first binary frame back before launching FA: otherwise FA
//!    connects to an empty stream (same ordering as the Python client).
//! 4. Bring the replay install up to the current build of the game's featured
//!    mod. A live stream carries no version of its own, and FA refuses a
//!    replay whose build does not match what is installed ("Ack! Unable to
//!    load replay from gpgnet"), so this asks for `latest` the way a live
//!    game launch does. It runs *before* the stream is opened: the server
//!    starts sending on the handshake, and a patch download after that point
//!    would be spent buffering frames nobody is reading.
//! 5. Launch FA with `/replay gpgnet://127.0.0.1:<port>/...` pointed at a
//!    local TCP proxy (mirrors the Java client's `LiveReplayProxyServer`).
//! 6. Once FA connects, feed it WebSocket frames until the connection closes.
//!
//! **Transport: a local TCP proxy by default; a named pipe only when the user
//! asks for it.** FA's engine has a confirmed bug: reading a replay's
//! `ScenarioInfo` (game options, often bloated by unused sim-mod options)
//! through a raw TCP/`gpgnet://` socket crashes it with "Premature EOF" once
//! that data exceeds roughly 2047 bytes (FAF Discord/Zulip, Gatsik, Jan 2026).
//! A Windows named pipe avoids that crash: we shipped that fix briefly: but it
//! introduced a worse regression: FA's named-pipe read is a *blocking* call on
//! (what appears to be) its main/render thread, so catching up to a live
//! game's current tick freezes the entire UI rather than just stalling the
//! simulation the way the TCP path does (confirmed both by community reports
//!: Nomander/Nuggets, FAF Discord, Jan 2026: and by reproducing it
//! ourselves). It also ends the replay abruptly, with no army selection or
//! post-game statistics, because FA never sees the stream close (see
//! [`PIPE_TERMINATOR`]). The actual fix for the root cause is upstream, in the
//! FA engine's lobby code (`FAForever/fa#7057`, stripping disabled mods' game
//! options before launch so `ScenarioInfo` never gets oversized in the first
//! place); once that lands, this TCP transport stops hitting the crash for
//! new games entirely, with none of the pipe's freeze downside.
//!
//! Neither transport is right for everyone until then, which is why the pipe
//! is a switch rather than a decision made here: Settings, "Live replays
//! workaround" (`GamePreferences::pipe_live_replay`, the Python client's
//! `game/pipe_live_replay`), off by default. A player whose games crash out of
//! live spectating turns it on and trades the ending for one that starts.
//!
//! Old replays recorded before the upstream fix may still have oversized
//! `ScenarioInfo` and could in principle still hit this crash live-spectating
//! them: but local *file* playback (see below) was never on this code path to
//! begin with: FA reads those directly from disk via `/replay "<path>"`, with
//! no TCP or pipe involved and no size limit or freeze concern either way.

use std::time::Duration;

use faf_domain::state::LiveReplayTarget;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::infra::session::TokenStore;
use crate::infra::{fetch_access_url, free_port, validated_ws_url};
use crate::ports::ProcessPort;

use super::names::normalize_mod;
use super::preparation::ReplayPreparation;
use super::ReplayConfig;

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// How long to wait for the replay server's first byte, or for FA to connect
/// to the local TCP proxy, before giving up.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// The pipe FA is pointed at when the "Live Replays Workaround" is on. Fixed
/// rather than per-game, and the same name the Python client uses, so the two
/// clients cannot end up streaming into each other's pipe: only one live
/// replay can run at a time either way (the playback lock).
#[cfg(windows)]
const LIVE_REPLAY_PIPE_PATH: &str = r"\\.\pipe\fafreplay";

/// How a live replay stream reaches FA.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LiveTransport {
    /// A local TCP proxy behind a `gpgnet://` URL. The default: FA ends the
    /// replay cleanly and the spectator keeps army selection and statistics.
    Tcp,
    /// A Windows named pipe. Sidesteps the engine's oversized-`ScenarioInfo`
    /// bug on the TCP path at the cost of a frozen window while catching up
    /// and an abrupt end. See the module docs.
    #[cfg(windows)]
    Pipe,
}

/// FA does not notice a named pipe closing the way it notices a socket close:
/// it simply hangs. The Python client found that a couple of kilobytes of
/// invalid replay data ends the session instead, and this is the same
/// terminator, byte for byte (`fa/replaylivestreamer.py`). The simulation
/// still stops rather than ending properly, which is the "abrupt end" the
/// setting's hint warns about.
#[cfg(windows)]
const PIPE_TERMINATOR: [u8; 2048] = [0u8; 2048];

/// Relays a live game from the replay server to FA.
///
/// Holds what only live spectating needs: the user API that hands out replay
/// server access and the transport preference. The install it prepares and
/// the process it launches belong to playback, which passes them in while it
/// holds the one-launch-at-a-time lock.
pub(super) struct LiveStreamer {
    http: reqwest::Client,
    tokens: TokenStore,
    /// FAF *user* API base, which serves `/replay/access`.
    user_api_base: String,
    /// Whether a live replay stream is handed to FA over a named pipe instead
    /// of the local TCP proxy: the "Live Replays Workaround" setting, pushed in
    /// by the settings service (`ReplayPlaybackPort::set_live_replay_pipe`).
    pipe_live_replay: std::sync::atomic::AtomicBool,
}

impl LiveStreamer {
    pub(super) fn new(config: &ReplayConfig, tokens: TokenStore) -> Self {
        Self {
            http: crate::infra::http::shared_http_client(),
            tokens,
            user_api_base: config.user_api_base.clone(),
            pipe_live_replay: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub(super) fn set_pipe(&self, enabled: bool) {
        self.pipe_live_replay
            .store(enabled, std::sync::atomic::Ordering::Relaxed);
    }

    /// Which transport the next live replay uses, resolving the preference
    /// against what this platform can actually do.
    fn live_transport(&self) -> LiveTransport {
        if !self
            .pipe_live_replay
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            return LiveTransport::Tcp;
        }
        #[cfg(windows)]
        {
            LiveTransport::Pipe
        }
        #[cfg(not(windows))]
        {
            // The Python client has a FIFO path for this; we do not, and
            // quietly ignoring the setting would be worse than saying so.
            tracing::warn!(
                "the live replay workaround uses a Windows named pipe; \
                 falling back to the TCP proxy on this platform"
            );
            LiveTransport::Tcp
        }
    }

    /// The body of `ReplayPlaybackPort::watch_live`, run while the caller
    /// holds the playback lock.
    pub(super) async fn start(
        &self,
        preparation: &ReplayPreparation,
        process: &dyn ProcessPort,
        target: LiveReplayTarget,
        player: String,
    ) -> Result<Option<String>, String> {
        // Same reason as `play_file`, plus one of its own on Windows: the live
        // transport's named pipe is created with `first_pipe_instance`, which
        // the previous live replay is still holding.
        process.stop_replay().await;
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;

        let mod_name = normalize_mod(&target.mod_name);

        // Preparation runs before the stream is opened, deliberately. The
        // replay server starts sending the moment the handshake lands, and FA
        // is launched on the first frame, so a multi-minute patch or map
        // download between those two points would be spent buffering a live
        // stream nobody is reading yet.
        let mut warning = None;
        match preparation.install_dir() {
            Some(target_dir) => {
                // The gap behind "Ack! Unable to load replay from gpgnet".
                // Live spectating never updated the install it launches, so
                // the replay install stayed on whatever build was last staged
                // into it: in practice some old replay's version, since that
                // path pins an exact one and nothing else ever touches this
                // directory. FA refuses a replay whose build does not match,
                // and a live stream is always the *current* build. `play_file`
                // has resolved its replay's exact version since it was
                // written; this is the same step for a stream that carries no
                // version of its own to read, so it asks for `latest` the way
                // a live game launch does.
                //
                // Fatal for the same reason it is fatal in `play_file`:
                // launching anyway just reproduces the refusal, with the user
                // dropped on the main menu and no diagnostic anywhere.
                preparation
                    .update_to_latest(&token, &target_dir, &mod_name)
                    .await
                    .map_err(|e| format!("could not prepare the game for live spectating: {e}"))?;

                // Same gap `play_file` had before it got `ensure_map_available`:
                // live-spectating never staged the game's map at all, so a custom
                // (non-base) map FA can't already find leaves it stuck the same
                // way: confirmed live (`map /maps/hoey.v0002/Hoey.scmap failed.
                // aborting session.`), silently dumping the user back to the main
                // menu with no crash dialog and no error surfaced here either.
                // `target.map` is the FAF technical map name (e.g. `hoey.v0002`),
                // the same shape `ensure_map_available` expects.
                if let Some(warn) = preparation
                    .ensure_replay_map(&target_dir, &target.map)
                    .await?
                {
                    warning = Some(warn);
                }
            }
            None => {
                tracing::warn!(
                    "no replay install is configured, so the engine version and map \
                     were not prepared; FA may refuse to load this live replay"
                );
            }
        }

        let transport = self.live_transport();

        let access_url =
            fetch_access_url(&self.http, &self.user_api_base, "/replay/access", &token).await?;
        let ws_url = validated_ws_url(&access_url)?;

        // Note: ws_url carries a one-time verify token: never log it verbatim.
        let (ws, _) = tokio_tungstenite::connect_async(ws_url.as_str())
            .await
            .map_err(|e| format!("could not open replay websocket: {e}"))?;
        let (mut write, mut read) = ws.split();

        let handshake = format!("G/{}/{}.scfareplay\0", target.uid, player).into_bytes();
        write
            .send(Message::Binary(handshake))
            .await
            .map_err(|e| format!("replay handshake failed: {e}"))?;

        // Gate FA's launch on the first byte actually arriving, mirroring the
        // Python client: otherwise FA connects to a proxy with nothing behind it.
        let first = wait_for_first_binary(&mut read).await?;

        let log_path = crate::infra::game_logs::next_path("live-replay", Some(target.uid))?;
        // Spelled the way the launched game can open it, which is not the same
        // string when the game runs through Wine: see
        // `ProcessPort::game_argument_path`. The source is a URL on both
        // transports here and needs no such treatment.
        let log_argument = process.game_argument_path(&log_path);
        // Everything but the replay source is the same on both transports.
        let launch_args = |source: String| {
            vec![
                "/replay".to_string(),
                source,
                "/init".to_string(),
                format!("init_{mod_name}.lua"),
                "/nobugreport".to_string(),
                "/log".to_string(),
                log_argument.clone(),
                "/replayid".to_string(),
                target.uid.to_string(),
            ]
        };

        match transport {
            LiveTransport::Tcp => {
                let port =
                    free_port().ok_or_else(|| "could not reserve a local port".to_string())?;
                let listener = TcpListener::bind(("127.0.0.1", port))
                    .await
                    .map_err(|e| format!("could not bind local replay proxy: {e}"))?;

                process
                    .launch_replay(launch_args(format!(
                        "gpgnet://127.0.0.1:{port}/{}/{player}.SCFAreplay",
                        target.uid
                    )))
                    .await?;

                let (stream, _) = tokio::time::timeout(READY_TIMEOUT, listener.accept())
                    .await
                    .map_err(|_| "timed out waiting for the game to connect".to_string())?
                    .map_err(|e| format!("accept failed: {e}"))?;

                tokio::spawn(relay_session(stream, write, read, first));
            }
            #[cfg(windows)]
            LiveTransport::Pipe => {
                // Created before FA is launched: a client opening a pipe that
                // does not exist yet fails outright, where a TCP connect to a
                // bound listener simply waits.
                let pipe = tokio::net::windows::named_pipe::ServerOptions::new()
                    .first_pipe_instance(true)
                    .max_instances(1)
                    .access_outbound(true)
                    .access_inbound(false)
                    .create(LIVE_REPLAY_PIPE_PATH)
                    .map_err(|e| {
                        format!("could not open the live replay pipe: {e} (is another live replay still running?)")
                    })?;

                process
                    .launch_replay(launch_args(LIVE_REPLAY_PIPE_PATH.to_string()))
                    .await?;

                tokio::time::timeout(READY_TIMEOUT, pipe.connect())
                    .await
                    .map_err(|_| "timed out waiting for the game to connect".to_string())?
                    .map_err(|e| format!("the game could not open the replay pipe: {e}"))?;

                tokio::spawn(pipe_relay_session(pipe, write, read, first));
            }
        }
        Ok(warning)
    }
}

/// Wait for the first binary WebSocket frame, ignoring ping/pong/text frames.
async fn wait_for_first_binary(read: &mut SplitStream<WsStream>) -> Result<Vec<u8>, String> {
    let wait = async {
        loop {
            match read.next().await {
                Some(Ok(Message::Binary(data))) => return Some(data),
                Some(Ok(_)) => continue,
                Some(Err(_)) | None => return None,
            }
        }
    };
    match tokio::time::timeout(READY_TIMEOUT, wait).await {
        Ok(Some(data)) => Ok(data),
        Ok(None) => Err("replay server closed the connection before sending data".to_string()),
        Err(_) => Err("timed out waiting for the replay server".to_string()),
    }
}

/// Bidirectionally pipe bytes between FA's local proxy socket and the replay
/// WebSocket (mirrors the Java client's `LiveReplayProxyServer`), starting
/// with the already-buffered first frame.
///
/// The WebSocket side runs in its own task, decoupled from the TCP write via
/// an mpsc queue: mirroring the Python client's `StreamWriter`, which pushes
/// server bytes onto a `Queue` from the Qt event loop and drains it on a
/// separate writer thread. FA is single-threaded and doesn't read from the
/// proxy socket while it's busy loading assets (tens of seconds at startup);
/// without this decoupling, `tcp.write_all` blocking on that meant we also
/// stopped polling the WebSocket, missed its keepalive pings, and the server
/// dropped the connection: the game then hit "Premature EOF" once it finally
/// got around to reading. TCP→WS (the game talking back) doesn't have the
/// same problem since replay playback is receive-only, but it's decoupled the
/// same way for symmetry and to keep this task cheap to reason about.
async fn relay_session(
    tcp: TcpStream,
    mut ws_write: SplitSink<WsStream, Message>,
    mut ws_read: SplitStream<WsStream>,
    first: Vec<u8>,
) {
    let (mut tcp_read, mut tcp_write) = tcp.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    if tx.send(first).is_err() {
        return;
    }

    // WS → queue. Never blocks on the (possibly slow-to-drain) TCP side, so
    // the server's keepalive pings always get answered promptly.
    let ws_to_queue = tokio::spawn(async move {
        while let Some(msg) = ws_read.next().await {
            match msg {
                Ok(Message::Binary(data)) => {
                    if tx.send(data).is_err() {
                        break;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {} // ping/pong/text: ignore
            }
        }
    });

    // Queue → TCP. Can block on FA being busy without affecting the above.
    let queue_to_tcp = tokio::spawn(async move {
        while let Some(data) = rx.recv().await {
            if tcp_write.write_all(&data).await.is_err() {
                break;
            }
        }
    });

    // TCP → WS: the game talking back (rare during pure playback, but the
    // wire protocol is nominally bidirectional: see the module docs).
    let tcp_to_ws = tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        loop {
            match tcp_read.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ws_write
                        .send(Message::Binary(buf[..n].to_vec()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });

    // The session ends as soon as any leg does: the other two are aborted.
    tokio::select! {
        _ = ws_to_queue => {}
        _ = queue_to_tcp => {}
        _ = tcp_to_ws => {}
    }
}

/// The named-pipe counterpart of [`relay_session`].
///
/// One leg fewer than the TCP version: the pipe is opened outbound-only, so
/// there is nothing to read back from FA. The other difference is the ending,
/// which the pipe does not deliver on its own (see [`PIPE_TERMINATOR`]).
#[cfg(windows)]
async fn pipe_relay_session(
    mut pipe: tokio::net::windows::named_pipe::NamedPipeServer,
    mut ws_write: SplitSink<WsStream, Message>,
    mut ws_read: SplitStream<WsStream>,
    first: Vec<u8>,
) {
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    if tx.send(first).is_err() {
        return;
    }

    // WS -> queue, exactly as on the TCP path: reading the socket must never
    // wait on FA draining the pipe, or the server's keepalive pings go
    // unanswered while the game is catching up.
    let ws_to_queue = tokio::spawn(async move {
        while let Some(msg) = ws_read.next().await {
            match msg {
                Ok(Message::Binary(data)) => {
                    if tx.send(data).is_err() {
                        break;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {} // ping/pong/text: ignore
            }
        }
    });

    let queue_to_pipe = tokio::spawn(async move {
        while let Some(data) = rx.recv().await {
            if pipe.write_all(&data).await.is_err() {
                return;
            }
        }
        // The stream ended rather than the pipe breaking, so FA is still
        // sitting there waiting for more. Unblock it.
        let _ = pipe.write_all(&PIPE_TERMINATOR).await;
        let _ = pipe.shutdown().await;
    });

    tokio::select! {
        _ = ws_to_queue => {}
        _ = queue_to_pipe => {}
    }

    // Nothing reads from FA on this transport, but the socket still has to be
    // closed rather than dropped mid-frame.
    let _ = ws_write.close().await;
}
