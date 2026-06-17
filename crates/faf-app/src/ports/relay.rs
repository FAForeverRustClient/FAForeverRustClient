//! GPGNet relay port — the local TCP server the ICE adapter connects to.
//!
//! The adapter connects to this server (`--gpgnet-client-port`) and forwards the
//! game's GPGNet messages here; we in turn relay them to the lobby, and relay the
//! lobby's game-targeted messages back. The boundary is two channels of decoded
//! [`GpgMessage`]s plus the listening port; the binary framing lives in
//! [`faf_domain::protocol::gpgnet`]. The real impl is a `tokio` TCP server; the
//! fake yields dead channels.

use async_trait::async_trait;
use faf_domain::protocol::gpgnet::GpgMessage;
use tokio::sync::mpsc;

/// The live relay's endpoints, handed to the launcher.
pub struct RelayChannels {
    /// Port the server is listening on — passed to the adapter as its GPGNet
    /// client port.
    pub port: u16,
    /// Messages decoded from the adapter (to be relayed to the lobby).
    pub from_adapter: mpsc::Receiver<GpgMessage>,
    /// Messages to encode and send to the adapter (relayed from the lobby).
    pub to_adapter: mpsc::Sender<GpgMessage>,
}

#[async_trait]
pub trait RelayPort: Send + Sync {
    /// Bind the relay server and return its port plus the two message channels.
    /// Errors if the socket can't be bound.
    async fn start(&self) -> Result<RelayChannels, String>;

    /// Tear down the server and any adapter connection. Idempotent.
    fn stop(&self);
}
