//! The web link's socket: a WebSocket from this client to the web client's
//! server (`wss://webclient.faforever.com/api/link`, or `FAF_WEB_LINK_URL`).
//!
//! The server pairs it with the player's browsers by the FAF account in the
//! OIDC ID token sent in the hello: proof of who is signed in, and nothing
//! the API or the lobby would accept, so the server never holds a token that
//! could act as the player. It accepts no `Origin` header on this side, which
//! a browser always sends, so a web page cannot pose as this client;
//! tungstenite sends none.
//!
//! One task per connection pumps both directions and ends when either the
//! socket or the service's end of the channels goes away. Message shapes are
//! `faf_domain::protocol::web_link`.

use std::time::Duration;

use async_trait::async_trait;
use faf_domain::protocol::web_link::{self, Inbound, Outbound};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::infra::session::TokenStore;
use crate::ports::{WebLinkError, WebLinkPort, WebLinkSession};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// The server answers a hello at once, or after one fetch of Hydra's keys.
const WELCOME_TIMEOUT: Duration = Duration::from_secs(15);
/// Larger than anything the server sends: a command is a few hundred bytes.
const MAX_MESSAGE_BYTES: usize = 64 * 1024;

pub struct WebLinkClient {
    url: String,
    tokens: TokenStore,
}

impl WebLinkClient {
    pub fn faf(tokens: TokenStore) -> Self {
        Self {
            url: crate::infra::env_or("FAF_WEB_LINK_URL", web_link::DEFAULT_URL),
            tokens,
        }
    }

    /// The address, refused unless it is `wss://`, or `ws://` to this machine:
    /// the hello carries the ID token.
    fn checked_url(&self) -> Result<String, WebLinkError> {
        let url = url::Url::parse(&self.url)
            .map_err(|_| WebLinkError::Unavailable("FAF_WEB_LINK_URL is not a URL".into()))?;
        let secure =
            url.scheme() == "wss" || (url.scheme() == "ws" && crate::infra::is_loopback(&url));
        if !secure || !url.username().is_empty() || url.password().is_some() {
            return Err(WebLinkError::Unavailable(
                "the web link only connects over wss://".into(),
            ));
        }
        Ok(url.to_string())
    }
}

/// "FAF Rust client 1.2.3", for the browser's "Your PC" line.
fn client_name() -> String {
    format!("FAF Rust client {}", env!("CARGO_PKG_VERSION"))
}

#[async_trait]
impl WebLinkPort for WebLinkClient {
    async fn connect(&self) -> Result<WebLinkSession, WebLinkError> {
        // The ID token, never the access token: see the module comment.
        let token = self.tokens.id_token().ok_or(WebLinkError::NotSignedIn)?;
        let url = self.checked_url()?;

        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
            max_message_size: Some(MAX_MESSAGE_BYTES),
            max_frame_size: Some(MAX_MESSAGE_BYTES),
            ..Default::default()
        };
        let (ws, _) = tokio::time::timeout(
            CONNECT_TIMEOUT,
            tokio_tungstenite::connect_async_with_config(url.as_str(), Some(config), false),
        )
        .await
        .map_err(|_| WebLinkError::Unavailable("the web client did not answer".into()))?
        .map_err(|error| {
            WebLinkError::Unavailable(format!("could not reach the web client: {error}"))
        })?;
        let (mut write, mut read) = ws.split();

        let hello = web_link::hello(token, client_name());
        write
            .send(Message::text(web_link::encode(&hello)))
            .await
            .map_err(|error| WebLinkError::Unavailable(error.to_string()))?;

        // The answer to the hello: a welcome, or a refusal and the close.
        let browsers = tokio::time::timeout(WELCOME_TIMEOUT, async {
            while let Some(frame) = read.next().await {
                match frame {
                    Ok(Message::Text(text)) => match web_link::decode(&text) {
                        Some(Inbound::Welcome { browsers }) => return Ok(browsers),
                        Some(Inbound::Error { code, message }) => {
                            return Err(WebLinkError::Refused { code, message })
                        }
                        _ => {}
                    },
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            Err(WebLinkError::Unavailable(
                "the web client closed the connection".into(),
            ))
        })
        .await
        .map_err(|_| {
            WebLinkError::Unavailable("the web client did not answer the hello".into())
        })??;

        let (outbound, mut to_server) = mpsc::channel::<Outbound>(32);
        let (from_server, inbound) = mpsc::channel::<Inbound>(32);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    message = to_server.recv() => {
                        let Some(message) = message else {
                            // The service let go: close politely.
                            let _ = write.close().await;
                            break;
                        };
                        if write.send(Message::text(web_link::encode(&message))).await.is_err() {
                            break;
                        }
                    }
                    frame = read.next() => match frame {
                        Some(Ok(Message::Text(text))) => {
                            if let Some(message) = web_link::decode(&text) {
                                if from_server.send(message).await.is_err() {
                                    break;
                                }
                            }
                        }
                        // The server's heartbeat: a link that stops answering
                        // is closed by the server after a minute.
                        Some(Ok(Message::Ping(payload))) => {
                            if write.send(Message::Pong(payload)).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                        Some(Ok(_)) => {}
                    }
                }
            }
            tracing::info!("web link closed");
        });

        Ok(WebLinkSession {
            outbound,
            inbound,
            browsers,
        })
    }
}

/// Offline: the link is never available. Tests that need one script their own.
pub struct FakeWebLink;

#[async_trait]
impl WebLinkPort for FakeWebLink {
    async fn connect(&self) -> Result<WebLinkSession, WebLinkError> {
        Err(WebLinkError::Unavailable("offline".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(url: &str) -> WebLinkClient {
        WebLinkClient {
            url: url.into(),
            tokens: TokenStore::new(),
        }
    }

    #[test]
    fn the_token_only_travels_encrypted_or_to_this_machine() {
        assert!(client("wss://webclient.faforever.com/api/link")
            .checked_url()
            .is_ok());
        assert!(client("ws://localhost:8098/api/link").checked_url().is_ok());
        assert!(client("ws://127.0.0.1:8098/api/link").checked_url().is_ok());
        assert!(client("ws://webclient.faforever.com/api/link")
            .checked_url()
            .is_err());
        assert!(client("https://webclient.faforever.com/api/link")
            .checked_url()
            .is_err());
        assert!(client("wss://user:pw@webclient.faforever.com/api/link")
            .checked_url()
            .is_err());
    }

    #[tokio::test]
    async fn without_a_login_there_is_nothing_to_connect_with() {
        let link = client("wss://webclient.faforever.com/api/link");
        assert_eq!(link.connect().await.err(), Some(WebLinkError::NotSignedIn));
        // An access token alone is not enough: only the ID token is ever sent.
        link.tokens.set("access-token");
        assert_eq!(link.connect().await.err(), Some(WebLinkError::NotSignedIn));
    }
}
