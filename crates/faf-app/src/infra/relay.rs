//! Real GPGNet relay server.
//!
//! Binds a loopback TCP server that the ICE adapter connects to (as its
//! `--gpgnet-client-port`). Bytes from the adapter are decoded with
//! [`faf_domain::protocol::gpgnet`] and pushed on `from_adapter`; messages on
//! `to_adapter` are encoded and written back. The launcher bridges these channels
//! to the lobby relay. Only one adapter connection is expected per game; when it
//! drops, or sends framing that can never parse, the relay ends.

use std::sync::{Arc, Mutex};

use faf_domain::protocol::gpgnet::{self, encode, GpgMessage};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

/// The live relay's endpoints, handed to the adapter that owns it.
pub struct RelayChannels {
    /// Port the server is listening on: passed to the adapter as its GPGNet
    /// client port.
    pub port: u16,
    /// Messages decoded from the adapter (to be relayed to the lobby).
    pub from_adapter: mpsc::Receiver<GpgMessage>,
    /// Messages to encode and send to the adapter (relayed from the lobby).
    pub to_adapter: mpsc::Sender<GpgMessage>,
    /// Resolves when the adapter has connected to this parent relay. Pioneer
    /// opens its game-facing GPGNet listener immediately before this connection,
    /// so this is the safe readiness gate before launching Forged Alliance.
    pub ready: oneshot::Receiver<()>,
}

/// The loopback TCP server the Go (faf-pioneer) adapter connects to.
///
/// Deliberately *not* behind a port trait. It was one when the launcher owned
/// the relay and either adapter backend might have supplied it; today it is an
/// implementation detail of exactly one backend: [`super::PioneerAdapter`],
/// which constructs it concretely. The Java backend
/// ([`super::JavaAdapter`]) speaks JSON-RPC and has no relay of its own, so
/// there was never a second implementation for the seam to swap in, and the
/// `FakeRelay` that existed to fill it was reachable from no test.
///
/// Both backends remain available; the choice is made by the persisted setting
/// or `FAF_ICE_ADAPTER_KIND`. Pioneer is explicit-only and is never an
/// automatic fallback for the production Java backend.
#[derive(Default)]
pub struct GpgRelayServer {
    cancel: Arc<Mutex<Option<CancellationToken>>>,
}

impl GpgRelayServer {
    /// Bind the relay server and return its port plus the two message channels.
    /// Errors if the socket can't be bound.
    pub async fn start(&self) -> Result<RelayChannels, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("could not bind relay socket: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("could not read relay port: {e}"))?
            .port();
        tracing::info!(port, "GPGNet relay server bound");

        let token = CancellationToken::new();
        if let Some(prev) = self.cancel.lock().unwrap().replace(token.clone()) {
            tracing::debug!("cancelling previous relay server instance");
            prev.cancel();
        }

        // from_adapter: server → launcher.  to_adapter: launcher → server.
        let (from_tx, from_rx) = mpsc::channel::<GpgMessage>(64);
        let (to_tx, to_rx) = mpsc::channel::<GpgMessage>(64);
        let (ready_tx, ready_rx) = oneshot::channel();

        tokio::spawn(async move {
            run_relay(listener, from_tx, to_rx, ready_tx, token).await;
        });

        Ok(RelayChannels {
            port,
            from_adapter: from_rx,
            to_adapter: to_tx,
            ready: ready_rx,
        })
    }

    /// Tear down the server and any adapter connection. Idempotent.
    pub fn stop(&self) {
        if let Some(token) = self.cancel.lock().unwrap().take() {
            tracing::info!("GPGNet relay server stop requested");
            token.cancel();
        }
    }
}

/// Accept the adapter connection and pump messages both ways until either side
/// closes or `cancel` fires.
async fn run_relay(
    listener: TcpListener,
    from_adapter: mpsc::Sender<GpgMessage>,
    mut to_adapter: mpsc::Receiver<GpgMessage>,
    ready: oneshot::Sender<()>,
    cancel: CancellationToken,
) {
    let socket = tokio::select! {
        _ = cancel.cancelled() => {
            tracing::info!("GPGNet relay cancelled before adapter connected");
            return;
        },
        accepted = listener.accept() => match accepted {
            Ok((socket, _)) => socket,
            Err(e) => {
                tracing::error!(error = %e, "ICE relay accept failed");
                return;
            }
        }
    };
    tracing::info!("ICE adapter connected to local relay");
    let _ = ready.send(());
    let (mut read_half, mut write_half) = socket.into_split();

    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let close_reason;
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                close_reason = "stop() called (cancellation token fired)";
                break;
            },
            // Launcher → adapter.
            outgoing = to_adapter.recv() => {
                let Some(message) = outgoing else {
                    close_reason = "to_adapter channel closed (launcher dropped its sender)";
                    break;
                };
                tracing::trace!(
                    command = %message.command,
                    args = ?message.args,
                    "relay: launcher -> adapter"
                );
                if let Err(e) = write_half.write_all(&encode(&message)).await {
                    close_reason = "write to adapter socket failed";
                    tracing::warn!(error = %e, "relay write to adapter failed");
                    break;
                }
            }
            // Adapter → launcher.
            read = read_half.read(&mut chunk) => {
                let n = match read {
                    Ok(0) => {
                        close_reason = "adapter closed its end of the TCP connection (EOF)";
                        break;
                    }
                    Ok(n) => n,
                    Err(e) => {
                        close_reason = "read from adapter socket failed";
                        tracing::warn!(error = %e, "ICE relay read failed");
                        break;
                    }
                };
                buffer.extend_from_slice(&chunk[..n]);
                let (messages, failure) = take_messages(&mut buffer, MAX_BUFFERED_BYTES);
                for message in messages {
                    tracing::trace!(
                        command = %message.command,
                        args = ?message.args,
                        "relay: adapter -> launcher"
                    );
                    if from_adapter.send(message).await.is_err() {
                        tracing::info!("GPGNet relay closed: from_adapter channel closed (launcher dropped its receiver)");
                        return;
                    }
                }
                if let Some(failure) = failure {
                    tracing::warn!(
                        reason = failure,
                        buffered = buffer.len(),
                        "GPGNet relay received a stream it cannot parse; dropping the adapter connection"
                    );
                    close_reason = "adapter sent invalid GPGNet framing";
                    break;
                }
            }
        }
    }
    tracing::info!(reason = close_reason, "GPGNet relay closed");
}

/// The most the relay holds for a message that has not finished arriving.
///
/// The decoder already refuses any frame longer than this, so an honest stream
/// never gets near it; the check here is what keeps that a guarantee about
/// memory rather than an assumption about the decoder.
const MAX_BUFFERED_BYTES: usize = gpgnet::MAX_FRAME_BYTES;

/// Take every complete message off `buffer`, and say whether the stream must
/// be dropped.
///
/// GPGNet has no outer frame, so after a corrupt length or type there is no
/// way to find where the next message starts. Waiting for more bytes would
/// only grow the buffer towards a message that will never complete, and the
/// game would sit in its lobby with no word of why. Dropping the connection
/// ends the session where the logs can say so.
fn take_messages(buffer: &mut Vec<u8>, cap: usize) -> (Vec<GpgMessage>, Option<&'static str>) {
    let drained = gpgnet::drain(buffer);
    let failure = drained
        .invalid
        .or_else(|| (buffer.len() > cap).then_some("incomplete message exceeds the buffer cap"));
    (drained.messages, failure)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn starting_binds_a_real_loopback_port() {
        // The port is handed to the Go adapter as `--gpgnet-client-port`, so a
        // zero here would silently point it at nothing.
        let relay = GpgRelayServer::default();
        let channels = relay.start().await.expect("the relay should bind");
        assert!(channels.port > 0);
        relay.stop();
    }

    #[tokio::test]
    async fn stopping_is_idempotent_and_safe_before_a_start() {
        let relay = GpgRelayServer::default();
        relay.stop();
        let _ = relay.start().await.expect("the relay should bind");
        relay.stop();
        relay.stop();
    }

    #[tokio::test]
    async fn restarting_replaces_the_previous_server() {
        // A second game must not leave the first relay listening.
        let relay = GpgRelayServer::default();
        let first = relay.start().await.expect("bind").port;
        let second = relay.start().await.expect("rebind").port;
        assert_ne!(first, second, "each run gets its own socket");
        relay.stop();
    }

    #[test]
    fn an_incomplete_message_past_the_cap_ends_the_stream() {
        use faf_domain::protocol::gpgnet::GpgArg;

        let message = GpgMessage::new("GameState", vec![GpgArg::Str("Lobby".into())]);
        let bytes = encode(&message);

        // Under the cap, a partial frame is simply kept for the next read.
        let mut buffer = bytes[..bytes.len() - 1].to_vec();
        let (messages, failure) = take_messages(&mut buffer, 64);
        assert!(messages.is_empty());
        assert_eq!(failure, None);
        assert_eq!(buffer.len(), bytes.len() - 1);

        // The same partial frame over a smaller cap is a reason to hang up.
        let (_, failure) = take_messages(&mut buffer, 8);
        assert_eq!(failure, Some("incomplete message exceeds the buffer cap"));

        // Complete messages leave nothing behind, so they never trip it.
        let mut buffer = bytes.repeat(4);
        let (messages, failure) = take_messages(&mut buffer, 8);
        assert_eq!(messages, vec![message; 4]);
        assert_eq!(failure, None);
    }

    /// A corrupt frame from the adapter drops the connection after delivering
    /// what arrived intact before it, instead of buffering forever.
    #[tokio::test]
    async fn invalid_framing_from_the_adapter_tears_the_connection_down() {
        use faf_domain::protocol::gpgnet::GpgArg;
        use std::time::Duration;

        let relay = GpgRelayServer::default();
        let mut channels = relay.start().await.expect("bind");
        let mut adapter = tokio::net::TcpStream::connect(("127.0.0.1", channels.port))
            .await
            .expect("connect to the relay");

        let intact = GpgMessage::new("GameState", vec![GpgArg::Str("Idle".into())]);
        let mut bytes = encode(&intact);
        // A string length of -1: nothing after it can be parsed.
        bytes.extend_from_slice(&(-1_i32).to_le_bytes());
        adapter.write_all(&bytes).await.expect("send to the relay");

        let limit = Duration::from_secs(5);
        assert_eq!(
            tokio::time::timeout(limit, channels.from_adapter.recv())
                .await
                .expect("delivered"),
            Some(intact)
        );
        assert_eq!(
            tokio::time::timeout(limit, channels.from_adapter.recv())
                .await
                .expect("closed"),
            None,
            "the relay ends after invalid framing"
        );
        let mut rest = [0_u8; 16];
        let read = tokio::time::timeout(limit, adapter.read(&mut rest))
            .await
            .expect("the socket is closed rather than left hanging");
        assert!(matches!(read, Ok(0) | Err(_)));
        relay.stop();
    }

    #[tokio::test]
    async fn readiness_resolves_only_after_the_adapter_connects() {
        let relay = GpgRelayServer::default();
        let channels = relay.start().await.expect("bind");
        let port = channels.port;
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), channels.ready)
                .await
                .is_err()
        );

        // Start a fresh relay because timing out consumes the first receiver.
        let channels = relay.start().await.expect("rebind");
        let connection = tokio::net::TcpStream::connect(("127.0.0.1", channels.port));
        let (connected, ready) = tokio::join!(connection, channels.ready);
        assert!(connected.is_ok());
        assert!(ready.is_ok());
        assert_ne!(port, channels.port);
        relay.stop();
    }
}
