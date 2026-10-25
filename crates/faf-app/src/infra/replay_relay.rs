//! Forwards a live game's replay stream on to FAF's replay service.
//!
//! [`replay_recorder`](super::replay_recorder) writes the stream FA produces to
//! a local `.fafreplay`. That file is the player's own copy and reaches nobody
//! else: the vault entry for a game is built by FAF's replay server out of the
//! streams the *clients* post to it while the game is being played. A client
//! that only records locally therefore leaves every game it hosts sitting at
//! "not uploaded yet" in the archive forever, with no file for anyone to
//! download and nothing for any client to launch. That was this client until
//! now, and it is what this module fixes.
//!
//! ## The protocol
//!
//! Exactly the Python client's `fa/replayserver.py`:
//!
//! 1. `GET {user_api}/replay/access` with the bearer token → `{ accessUrl }`,
//!    a `wss://` URL carrying a one-time verify token (same endpoint shape as
//!    `/lobby/access`, so [`fetch_access_url`] is shared with it).
//! 2. Open a WebSocket to it and forward every byte FA sends, **verbatim**, as
//!    binary frames.
//!
//! "Verbatim" is the part worth stating: FA opens its stream with
//! `P/<uid>/<player>\0`, and where the local file strips that prefix (it would
//! corrupt the replay body), the relay must keep it. It is the handshake that
//! tells the server which game this stream belongs to, and a stream missing it
//! is a stream the server cannot file.
//!
//! ## Reconnects
//!
//! A game is twenty minutes of streaming over a connection nobody promised to
//! keep, so a drop is expected rather than exceptional. The replay server
//! accepts a reconnecting writer and takes the longest stream it was sent for
//! any given game, which is why the recovery here is to send the whole stream
//! again from the beginning on every fresh connection rather than trying to
//! resume at an offset: the server reconciles, the client does not have to.
//! The Python client does the same thing for the same documented reason.
//!
//! Capture and retransmission share a disk spool; only one frame is buffered.
//!
//! ## What is deliberately not here
//!
//! Nothing is read back off the socket except to notice that it closed. The
//! recorder's connection is always the posting (`P/`) direction; the fetching
//! (`G/`) direction, where the server does send bytes that have to reach FA, is
//! live spectating and lives in [`super::replay`].

use std::time::Duration;

use super::replay_spool::ReplaySpool;
use futures_util::{SinkExt, StreamExt};
use tokio::io::AsyncReadExt;
use tokio_tungstenite::tungstenite::Message;

use super::session::TokenStore;
use super::{env_or, fetch_access_url, validated_ws_url};

/// How long to keep trying to hand the server a finished game's stream after FA
/// has exited.
///
/// The stream is worth more at this point than at any other: the game is over,
/// so this is the last chance to file it, and the reconnect loop is no longer
/// competing with a game for the network. It is still bounded, because a client
/// that never gives up is a client that never shuts down.
const FINAL_FLUSH_ATTEMPTS: u32 = 5;

/// Pause between connection attempts. Deliberately not a backoff: the whole
/// window is short and a game's stream is time-sensitive.
const RETRY_DELAY: Duration = Duration::from_secs(3);

/// Largest frame the catch-up send puts on the wire. Comfortably under the
/// 16 MiB a tungstenite peer accepts by default, and large enough that even a
/// long game is only a handful of frames.
const CATCH_UP_FRAME_BYTES: usize = 1024 * 1024;

/// What the relay needs to reach the replay service on the user's behalf.
///
/// The token is read from the store at each connection attempt rather than
/// copied once: a game outlives an access token, and a reconnect halfway
/// through one has to use whatever the session has refreshed to by then.
#[derive(Clone)]
pub(crate) struct ReplayRelayConfig {
    http: reqwest::Client,
    user_api_base: String,
    tokens: TokenStore,
    /// The two numbers above, as fields rather than constants, so a test can
    /// walk the whole give-up path in milliseconds instead of half a minute.
    retry_delay: Duration,
    final_flush_attempts: u32,
}

impl ReplayRelayConfig {
    /// Production configuration: the same user API the lobby connection uses.
    pub(crate) fn faf(tokens: TokenStore) -> Self {
        Self {
            http: super::http::shared_http_client(),
            user_api_base: env_or("FAF_USER_API_BASE", "https://user.faforever.com"),
            tokens,
            retry_delay: RETRY_DELAY,
            final_flush_attempts: FINAL_FLUSH_ATTEMPTS,
        }
    }

    #[cfg(test)]
    fn for_test(user_api_base: &str, tokens: TokenStore) -> Self {
        Self {
            http: reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            user_api_base: user_api_base.to_string(),
            tokens,
            retry_delay: Duration::from_millis(1),
            final_flush_attempts: 2,
        }
    }
}

/// A relay reading the recorder's durable spool without blocking capture.
pub(crate) struct ReplayRelay {
    task: tokio::task::JoinHandle<()>,
}

impl ReplayRelay {
    pub(super) fn start(config: ReplayRelayConfig, game_id: i32, spool: ReplaySpool) -> Self {
        Self {
            task: tokio::spawn(relay(config, game_id, spool)),
        }
    }

    pub(crate) async fn finish(mut self, timeout: Duration) {
        if tokio::time::timeout(timeout, &mut self.task).await.is_err() {
            self.task.abort();
            let _ = (&mut self.task).await;
            tracing::warn!("gave up waiting for the replay upload to finish");
        }
    }
}

impl Drop for ReplayRelay {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Outcome of one connection's worth of forwarding.
enum Pumped {
    /// FA is done and the server has everything: nothing left to do.
    Finished,
    /// The connection went away. Whatever has been buffered is re-sent on the
    /// next one.
    Lost,
}

/// Connect, forward, reconnect, until the game ends and the stream is delivered.
async fn relay(config: ReplayRelayConfig, game_id: i32, mut spool: ReplaySpool) {
    let mut attempts_after_game = 0u32;
    loop {
        match connect(&config).await {
            Ok(ws) => match pump(ws, &mut spool).await {
                Pumped::Finished => {
                    tracing::info!(
                        game_id,
                        bytes = spool.progress().len,
                        "replay uploaded to FAF"
                    );
                    return;
                }
                Pumped::Lost => {
                    tracing::warn!(game_id, "replay upload connection dropped; retrying")
                }
            },
            Err(error) => tracing::warn!(%error, game_id, "could not reach the FAF replay service"),
        }
        if spool.progress().finished {
            attempts_after_game += 1;
            if attempts_after_game >= config.final_flush_attempts {
                tracing::warn!(
                    game_id,
                    "replay upload stopped; local capture is independent"
                );
                return;
            }
        }
        tokio::time::sleep(config.retry_delay).await;
    }
}

/// Open one authenticated WebSocket to the replay service.
async fn connect(config: &ReplayRelayConfig) -> Result<WsStream, String> {
    let token = config
        .tokens
        .get()
        .ok_or_else(|| "not logged in".to_string())?;
    let access_url = fetch_access_url(
        &config.http,
        &config.user_api_base,
        "/replay/access",
        &token,
    )
    .await?;
    let ws_url = validated_ws_url(&access_url)?;
    // Note: ws_url carries a one-time verify token: never log it verbatim.
    let (ws, _) = tokio_tungstenite::connect_async(ws_url.as_str())
        .await
        .map_err(|error| format!("could not open the replay websocket: {error}"))?;
    Ok(ws)
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Send everything buffered, then everything that arrives, until one side ends.
async fn pump(ws: WsStream, spool: &mut ReplaySpool) -> Pumped {
    let (mut write, mut read) = ws.split();
    let Ok(mut file) = spool.open_async().await else {
        return Pumped::Lost;
    };
    let mut offset = 0;
    let mut buffer = vec![0; CATCH_UP_FRAME_BYTES];
    loop {
        let progress = spool.progress();
        if offset < progress.len {
            let count = (progress.len - offset).min(buffer.len() as u64) as usize;
            if file.read_exact(&mut buffer[..count]).await.is_err()
                || write
                    .send(Message::Binary(buffer[..count].to_vec()))
                    .await
                    .is_err()
            {
                return Pumped::Lost;
            }
            offset += count as u64;
        } else if progress.finished {
            return close(write).await;
        } else {
            tokio::select! {
                () = spool.changed() => {},
                message = read.next() => match message {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return Pumped::Lost,
                    Some(Ok(_)) => { if write.flush().await.is_err() { return Pumped::Lost; } }
                },
            }
        }
    }
}

/// End the upload cleanly, so the server files the game rather than waiting on
/// a writer that will not come back.
async fn close(mut write: futures_util::stream::SplitSink<WsStream, Message>) -> Pumped {
    if write.send(Message::Close(None)).await.is_err() {
        return Pumped::Lost;
    }
    let _ = write.close().await;
    Pumped::Finished
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn performance_finishing_a_stalled_relay_aborts_and_joins_its_task() {
        struct Dropped(std::sync::Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let dropped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let guard = Dropped(dropped.clone());
        let (started, ready) = tokio::sync::oneshot::channel();
        let relay = ReplayRelay {
            task: tokio::spawn(async move {
                let _guard = guard;
                let _ = started.send(());
                std::future::pending::<()>().await;
            }),
        };
        ready.await.unwrap();
        relay.finish(Duration::from_millis(1)).await;
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
    }

    fn oneshot() -> (
        tokio::sync::oneshot::Sender<()>,
        tokio::sync::oneshot::Receiver<()>,
    ) {
        tokio::sync::oneshot::channel()
    }

    #[tokio::test]
    async fn a_relay_without_a_login_gives_up_once_the_game_is_over() {
        // No token in the store, so every attempt fails at the first step,
        // before any socket is opened. The point is that the task *ends*: the
        // recorder waits on it before it is done with the game, and a relay
        // that retried forever would be a client that never stops trying to
        // upload a replay nobody can authenticate.
        let config = ReplayRelayConfig::for_test("http://127.0.0.1:1", TokenStore::new());
        let (spool, mut writer) = ReplaySpool::create().await.unwrap();
        let relay = ReplayRelay::start(config, 4711, spool);
        writer.append(b"P/4711/me\0payload").await.unwrap();
        drop(writer);
        tokio::time::timeout(
            Duration::from_secs(10),
            relay.finish(Duration::from_secs(10)),
        )
        .await
        .expect("the relay should stop trying once the game is over");
    }

    /// A stand-in for `/replay/access` and the replay service behind it.
    ///
    /// Returns the API base to point a relay at, and a handle that yields every
    /// byte the service was sent once the relay closes the stream.
    async fn fake_replay_service(
        hang_up_first: bool,
        accepted: tokio::sync::oneshot::Sender<()>,
    ) -> (String, tokio::task::JoinHandle<Vec<u8>>) {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let service = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let service_port = service.local_addr().unwrap().port();
        let received = tokio::spawn(async move {
            if hang_up_first {
                let (socket, _) = service.accept().await.unwrap();
                let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
                // A close frame rather than a bare disconnect: it is the one
                // way to end a connection that the relay notices at a known
                // moment, which keeps this test from racing the operating
                // system's socket buffers.
                let _ = ws.close(None).await;
                drop(ws);
            }
            let (socket, _) = service.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
            // Fired only for the connection whose bytes are collected, so a
            // test can order its sends against the reconnect rather than
            // against the clock.
            let _ = accepted.send(());
            let mut bytes = Vec::new();
            while let Some(Ok(message)) = ws.next().await {
                match message {
                    Message::Binary(data) => bytes.extend_from_slice(&data),
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            bytes
        });

        let api = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let api_port = api.local_addr().unwrap().port();
        tokio::spawn(async move {
            // A loop, not a single accept: the relay asks for a fresh access
            // URL on every connection attempt, and a test that only answered
            // the first would hide a reconnect that never got off the ground.
            while let Ok((mut socket, _)) = api.accept().await {
                let mut request = Vec::new();
                let mut buffer = [0u8; 1024];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => request.extend_from_slice(&buffer[..read]),
                    }
                }
                let body = format!(r#"{{"accessUrl":"ws://127.0.0.1:{service_port}/"}}"#);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len(),
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });

        (format!("http://127.0.0.1:{api_port}"), received)
    }

    #[tokio::test]
    async fn the_service_is_sent_the_stream_with_fa_s_handshake_intact() {
        // The whole of issue #273 in one assertion. FA's `P/<uid>/<player>\0`
        // prefix is what tells the replay service which game it is being given;
        // the local file strips it, and a relay that stripped it too would hand
        // the vault a stream it cannot file -- which looks, from the outside,
        // exactly like not uploading at all.
        let (_accepted, accepted_rx) = oneshot();
        let (api_base, received) = fake_replay_service(false, _accepted).await;
        let tokens = TokenStore::new();
        tokens.set("a-token");
        drop(accepted_rx);

        let (spool, mut writer) = ReplaySpool::create().await.unwrap();
        let relay = ReplayRelay::start(ReplayRelayConfig::for_test(&api_base, tokens), 4711, spool);
        writer.append(b"P/4711/Nory\0").await.unwrap();
        writer.append(b"hello replay").await.unwrap();
        drop(writer);
        relay.finish(Duration::from_secs(10)).await;

        let bytes = tokio::time::timeout(Duration::from_secs(10), received)
            .await
            .expect("the service should have been handed the stream")
            .unwrap();
        assert_eq!(bytes, b"P/4711/Nory\0hello replay");
    }

    #[tokio::test]
    async fn a_dropped_connection_re_sends_the_game_from_the_beginning() {
        // A twenty-minute game over a connection nobody promised to keep: the
        // drop is the expected case, not the exceptional one. What must not
        // happen is the vault ending up with the tail of a game, so the whole
        // stream goes out again on the new connection rather than resuming at
        // an offset.
        let (accepted, accepted_rx) = oneshot();
        let (api_base, received) = fake_replay_service(true, accepted).await;
        let tokens = TokenStore::new();
        tokens.set("a-token");

        let (spool, mut writer) = ReplaySpool::create().await.unwrap();
        let relay = ReplayRelay::start(ReplayRelayConfig::for_test(&api_base, tokens), 4711, spool);
        writer
            .append(b"P/4711/Nory\0before the drop ")
            .await
            .unwrap();
        // Only once the *second* connection is up, so the game is still running
        // when the first one dies: ending it earlier would let the relay finish
        // on the connection this test means to break.
        tokio::time::timeout(Duration::from_secs(10), accepted_rx)
            .await
            .expect("local replay reconnect timed out")
            .unwrap();
        writer.append(b"after the drop").await.unwrap();
        drop(writer);
        relay.finish(Duration::from_secs(10)).await;

        let bytes = tokio::time::timeout(Duration::from_secs(10), received)
            .await
            .expect("the reconnect should have delivered the stream")
            .unwrap();
        assert_eq!(bytes, b"P/4711/Nory\0before the drop after the drop");
    }

    #[tokio::test]
    async fn feeding_a_relay_that_cannot_connect_never_blocks() {
        // `send` is called between reads of FA's socket, so it must not wait on
        // anything: a replay service that is down cannot be allowed to stall
        // the loop that writes the player's own local file.
        let config = ReplayRelayConfig::for_test("http://127.0.0.1:1", TokenStore::new());
        let (spool, mut writer) = ReplaySpool::create().await.unwrap();
        let relay = ReplayRelay::start(config, 4711, spool);
        for _ in 0..1000 {
            writer.append(&[0u8; 1024]).await.unwrap();
        }
        drop(writer);
        relay.finish(Duration::from_secs(10)).await;
    }
}
