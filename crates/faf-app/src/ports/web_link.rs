//! The web link's boundary: one WebSocket to the web client's server, opened
//! by this client (see `faf_domain::protocol::web_link`).
//!
//! A connection is a pair of channels. Sending on `outbound` writes to the
//! socket; `inbound` yields what the server sends and closes when the socket
//! does. Dropping the session closes the socket.

use async_trait::async_trait;
use faf_domain::protocol::web_link::{Inbound, Outbound};
use tokio::sync::mpsc;

pub struct WebLinkSession {
    pub outbound: mpsc::Sender<Outbound>,
    pub inbound: mpsc::Receiver<Inbound>,
    /// How many of the player's browsers were connected when this one was.
    pub browsers: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebLinkError {
    /// No access token: not signed in yet, or signed out.
    NotSignedIn,
    /// The server answered the hello with a refusal.
    Refused { code: String, message: String },
    /// The server could not be reached, or did not answer in time.
    Unavailable(String),
}

impl std::fmt::Display for WebLinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotSignedIn => f.write_str("not signed in"),
            Self::Refused { code, message } => write!(f, "refused ({code}): {message}"),
            Self::Unavailable(reason) => f.write_str(reason),
        }
    }
}

#[async_trait]
pub trait WebLinkPort: Send + Sync {
    /// Connect, say hello with the current access token, and wait for the
    /// server's welcome.
    async fn connect(&self) -> Result<WebLinkSession, WebLinkError>;
}
