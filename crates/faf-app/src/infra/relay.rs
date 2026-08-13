//! Real GPGNet relay server.
//!
//! Binds a loopback TCP server that the ICE adapter connects to (as its
//! `--gpgnet-client-port`). Bytes from the adapter are decoded with
//! [`faf_domain::protocol::gpgnet`] and pushed on `from_adapter`; messages on
//! `to_adapter` are encoded and written back. The launcher bridges these channels
//! to the lobby relay. Only one adapter connection is expected per game; when it
//! drops, the relay ends.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_domain::protocol::gpgnet::{decode, encode, GpgMessage};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::ports::{RelayChannels, RelayPort};

#[derive(Default)]
pub struct GpgRelayServer {
    cancel: Arc<Mutex<Option<CancellationToken>>>,
}

#[async_trait]
impl RelayPort for GpgRelayServer {
    async fn start(&self) -> Result<RelayChannels, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("could not bind relay socket: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("could not read relay port: {e}"))?
            .port();

        let token = CancellationToken::new();
        if let Some(prev) = self.cancel.lock().unwrap().replace(token.clone()) {
            prev.cancel();
        }

        // from_adapter: server → launcher.  to_adapter: launcher → server.
        let (from_tx, from_rx) = mpsc::channel::<GpgMessage>(64);
        let (to_tx, to_rx) = mpsc::channel::<GpgMessage>(64);

        tokio::spawn(async move {
            run_relay(listener, from_tx, to_rx, token).await;
        });

        Ok(RelayChannels {
            port,
            from_adapter: from_rx,
            to_adapter: to_tx,
        })
    }

    fn stop(&self) {
        if let Some(token) = self.cancel.lock().unwrap().take() {
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
    cancel: CancellationToken,
) {
    let socket = tokio::select! {
        _ = cancel.cancelled() => return,
        accepted = listener.accept() => match accepted {
            Ok((socket, _)) => socket,
            Err(e) => {
                eprintln!("[relay] accept failed: {e}");
                return;
            }
        }
    };
    eprintln!("[relay] ICE adapter connected");
    let (mut read_half, mut write_half) = socket.into_split();

    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            // Launcher → adapter.
            outgoing = to_adapter.recv() => {
                let Some(message) = outgoing else { break }; // launcher gone
                if write_half.write_all(&encode(&message)).await.is_err() {
                    break;
                }
            }
            // Adapter → launcher.
            read = read_half.read(&mut chunk) => {
                let n = match read {
                    Ok(0) => break,           // adapter closed
                    Ok(n) => n,
                    Err(e) => {
                        eprintln!("[relay] read error: {e}");
                        break;
                    }
                };
                buffer.extend_from_slice(&chunk[..n]);
                for message in decode(&mut buffer) {
                    if from_adapter.send(message).await.is_err() {
                        return; // launcher gone
                    }
                }
            }
        }
    }
    eprintln!("[relay] closed");
}

/// Inert relay — used offline and in tests. Yields a server that never accepts and
/// channels that carry nothing.
#[derive(Default)]
pub struct FakeRelay;

#[async_trait]
impl RelayPort for FakeRelay {
    async fn start(&self) -> Result<RelayChannels, String> {
        let (_from_tx, from_rx) = mpsc::channel::<GpgMessage>(1);
        let (to_tx, _to_rx) = mpsc::channel::<GpgMessage>(1);
        Ok(RelayChannels {
            port: 0,
            from_adapter: from_rx,
            to_adapter: to_tx,
        })
    }
    fn stop(&self) {}
}
