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
//! The consequence is that the bytes seen so far are held in memory for the
//! length of the game. They already are, one layer up: the local file cannot be
//! compressed before FA has finished. So this is a second copy of something
//! single-digit megabytes in size, capped either way.
//!
//! ## What is deliberately not here
//!
//! Nothing is read back off the socket except to notice that it closed. The
//! recorder's connection is always the posting (`P/`) direction; the fetching
//! (`G/`) direction, where the server does send bytes that have to reach FA, is
//! live spectating and lives in [`super::replay`].

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::session::TokenStore;
use super::{env_or, fetch_access_url, validated_ws_url};

/// Ceiling on the retransmit buffer, i.e. on one game's whole replay stream.
///
/// Matches the recorder's own cap. Past it the relay stops buffering and
/// carries on forwarding live: a stream this large is already pathological,
/// and dropping the *new* bytes rather than the old ones would be the wrong
/// half to lose.
const MAX_BUFFERED_BYTES: usize = 512 * 1024 * 1024;

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
            http: reqwest::Client::new(),
            user_api_base: user_api_base.to_string(),
            tokens,
            retry_delay: Duration::from_millis(1),
            final_flush_attempts: 2,
        }
    }
}

/// A running relay. Feed it every chunk FA sends, then [`Self::finish`].
pub(crate) struct ReplayRelay {
    chunks: mpsc::UnboundedSender<Vec<u8>>,
    task: tokio::task::JoinHandle<()>,
}

impl ReplayRelay {
    /// Start relaying, without waiting for the connection to come up.
    ///
    /// Connecting takes an HTTP round trip and a TLS handshake, and FA starts
    /// streaming the moment it reaches the recorder. So the queue accepts bytes
    /// from the first instant and the connection catches up with them: the
    /// alternative, holding the game's first chunks hostage to a network call,
    /// buys nothing, since those chunks have to be re-sent on a reconnect
    /// anyway.
    pub(crate) fn start(config: ReplayRelayConfig, game_id: i32) -> Self {
        let (chunks, rx) = mpsc::unbounded_channel();
        let task = tokio::spawn(relay(config, game_id, rx));
        Self { chunks, task }
    }

    /// Hand one chunk of FA's stream to the relay, exactly as it arrived.
    pub(crate) fn send(&self, chunk: &[u8]) {
        // The receiver only goes away when the relay task has given up, which
        // it logs on its own; failing here would say nothing new and must not
        // stop the local recording.
        let _ = self.chunks.send(chunk.to_vec());
    }

    /// Close the stream and wait, briefly, for the tail of it to land.
    ///
    /// Dropping the sender is what tells the relay the game is over; the wait
    /// is bounded because a client that hangs on a shutdown is worse than a
    /// replay that missed its last frames.
    pub(crate) async fn finish(self, timeout: Duration) {
        drop(self.chunks);
        if tokio::time::timeout(timeout, self.task).await.is_err() {
            tracing::warn!("gave up waiting for the replay upload to finish");
        }
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
async fn relay(config: ReplayRelayConfig, game_id: i32, mut rx: mpsc::UnboundedReceiver<Vec<u8>>) {
    // Every byte FA has sent, in order, prefix included: what a fresh
    // connection is given before it starts streaming live again.
    let mut stream: Vec<u8> = Vec::new();
    let mut game_over = false;
    let mut attempts_after_game = 0u32;

    loop {
        match connect(&config).await {
            Ok(ws) => match pump(ws, &mut rx, &mut stream, &mut game_over).await {
                Pumped::Finished => {
                    tracing::info!(game_id, bytes = stream.len(), "replay uploaded to FAF");
                    return;
                }
                Pumped::Lost => {
                    tracing::warn!(game_id, "replay upload connection dropped; retrying");
                }
            },
            Err(error) => {
                tracing::warn!(%error, game_id, "could not reach the FAF replay service");
                // Nothing is connected, so the game's bytes would otherwise
                // pile up unread until the next attempt. Collect them now, and
                // notice here too when FA has finished.
                drain(&mut rx, &mut stream, &mut game_over);
            }
        }

        if game_over {
            attempts_after_game += 1;
            if attempts_after_game >= config.final_flush_attempts {
                tracing::warn!(
                    game_id,
                    bytes = stream.len(),
                    "this game's replay could not be uploaded; the local copy was still written"
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
async fn pump(
    ws: WsStream,
    rx: &mut mpsc::UnboundedReceiver<Vec<u8>>,
    stream: &mut Vec<u8>,
    game_over: &mut bool,
) -> Pumped {
    let (mut write, mut read) = ws.split();

    // The catch-up send. On the first connection this is whatever FA produced
    // while the handshake was in flight; on a later one it is the whole game so
    // far, which is what makes a reconnect recover rather than truncate.
    if !stream.is_empty() && write.send(Message::Binary(stream.clone())).await.is_err() {
        return Pumped::Lost;
    }
    if *game_over {
        return close(write).await;
    }

    loop {
        tokio::select! {
            chunk = rx.recv() => match chunk {
                Some(chunk) => {
                    buffer(stream, &chunk);
                    if write.send(Message::Binary(chunk)).await.is_err() {
                        return Pumped::Lost;
                    }
                }
                // The recorder dropped its sender: FA has closed its end.
                None => {
                    *game_over = true;
                    return close(write).await;
                }
            },
            // Read only to notice the connection going away, and to keep the
            // protocol's keepalives answered: a pong is queued by the read half
            // and goes out with the next frame we send, of which a live game
            // produces a steady supply.
            message = read.next() => match message {
                Some(Ok(_)) => {}
                Some(Err(_)) | None => return Pumped::Lost,
            },
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

/// Take everything queued without waiting, for the stretches with no connection
/// to send it on.
fn drain(rx: &mut mpsc::UnboundedReceiver<Vec<u8>>, stream: &mut Vec<u8>, game_over: &mut bool) {
    loop {
        match rx.try_recv() {
            Ok(chunk) => buffer(stream, &chunk),
            Err(mpsc::error::TryRecvError::Empty) => return,
            Err(mpsc::error::TryRecvError::Disconnected) => {
                *game_over = true;
                return;
            }
        }
    }
}

/// Append to the retransmit buffer, up to the cap.
fn buffer(stream: &mut Vec<u8>, chunk: &[u8]) {
    if stream.len() + chunk.len() > MAX_BUFFERED_BYTES {
        return;
    }
    stream.extend_from_slice(chunk);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_retransmit_buffer_stops_at_the_cap() {
        let mut stream = vec![0u8; MAX_BUFFERED_BYTES - 1];
        buffer(&mut stream, &[1, 2, 3]);
        assert_eq!(stream.len(), MAX_BUFFERED_BYTES - 1, "over-cap chunk kept");
        buffer(&mut stream, &[9]);
        assert_eq!(stream.len(), MAX_BUFFERED_BYTES);
    }

    #[tokio::test]
    async fn draining_notices_that_the_game_ended() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        tx.send(b"P/1/me\0".to_vec()).unwrap();
        tx.send(vec![7, 8]).unwrap();
        drop(tx);

        let mut stream = Vec::new();
        let mut game_over = false;
        drain(&mut rx, &mut stream, &mut game_over);

        // The prefix is part of the stream: it is the server's handshake, and
        // only the local file strips it.
        assert_eq!(stream, b"P/1/me\0\x07\x08");
        assert!(game_over);
    }

    #[tokio::test]
    async fn a_relay_without_a_login_gives_up_once_the_game_is_over() {
        // No token in the store, so every attempt fails at the first step,
        // before any socket is opened. The point is that the task *ends*: the
        // recorder waits on it before it is done with the game, and a relay
        // that retried forever would be a client that never stops trying to
        // upload a replay nobody can authenticate.
        let config = ReplayRelayConfig::for_test("http://127.0.0.1:1", TokenStore::new());
        let relay = ReplayRelay::start(config, 4711);
        relay.send(b"P/4711/me\0payload");
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
    async fn fake_replay_service() -> (String, tokio::task::JoinHandle<Vec<u8>>) {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let service = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let service_port = service.local_addr().unwrap().port();
        let received = tokio::spawn(async move {
            let (socket, _) = service.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
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
        let (api_base, received) = fake_replay_service().await;
        let tokens = TokenStore::new();
        tokens.set("a-token");

        let relay = ReplayRelay::start(ReplayRelayConfig::for_test(&api_base, tokens), 4711);
        relay.send(b"P/4711/Nory\0");
        relay.send(b"hello replay");
        relay.finish(Duration::from_secs(10)).await;

        let bytes = tokio::time::timeout(Duration::from_secs(10), received)
            .await
            .expect("the service should have been handed the stream")
            .unwrap();
        assert_eq!(bytes, b"P/4711/Nory\0hello replay");
    }

    #[tokio::test]
    async fn feeding_a_relay_that_cannot_connect_never_blocks() {
        // `send` is called between reads of FA's socket, so it must not wait on
        // anything: a replay service that is down cannot be allowed to stall
        // the loop that writes the player's own local file.
        let config = ReplayRelayConfig::for_test("http://127.0.0.1:1", TokenStore::new());
        let relay = ReplayRelay::start(config, 4711);
        for _ in 0..1000 {
            relay.send(&[0u8; 1024]);
        }
        relay.finish(Duration::from_secs(10)).await;
    }
}
