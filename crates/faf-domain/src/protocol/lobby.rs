//! The FAF lobby protocol: what the server says and what this client says
//! back.
//!
//! Newline-delimited JSON objects in WebSocket text frames, each keyed by its
//! `command`. [`ServerMessage::decode`] turns one object from the server into
//! a message with its fields already read, and [`ClientMessage`] is everything
//! this client sends, put on the wire by [`ClientMessage::encode`]. There is
//! one file per family of messages: player entries and the social lists,
//! lobbies and the launch order, the matchmaker, and server notices.
//!
//! What is not here is anything that needs a socket or a memory. Opening the
//! connection, the order of the handshake, reconnecting, and what a session
//! keeps between two messages (who is online, which games are open, how they
//! are rated) belong to the adapter, `infra::lobby_ws` in `faf-app`.
//!
//! Leniency is the rule on the way in. The server is three programs by now
//! (the lobby server, the message broker in front of it, and whichever of the
//! two changes next), a field arrives as a number or as a string, absent or
//! `null`, and a message this client cannot read in full is still worth what
//! it can read. So a decoder here never fails: a missing field takes the
//! default the reference clients give it, and a command nobody knows is
//! [`ServerMessage::Other`].

use serde_json::Value;

mod client;
mod game;
mod matchmaker;
mod notice;
mod player;
mod server;
#[cfg(test)]
mod tests;

pub use client::ClientMessage;
pub use game::{average_game_rating, games_in, GameInfo, PlayerRatings};
pub use notice::{Notice, ServerNoticeStyle};
pub use player::{PlayerEntry, SocialLists};
pub use server::ServerMessage;

/// A message's `command`, or nothing for a message without one.
fn command_of(value: &Value) -> &str {
    value.get("command").and_then(Value::as_str).unwrap_or("")
}

/// The FAF lobby transport is newline-delimited JSON, including for WebSocket
/// text frames. The Python client appends this delimiter before every send and
/// the Java client uses a line encoder; keep the same wire contract here.
fn encode_lobby_message(value: &Value) -> String {
    format!("{value}\n")
}

/// Every JSON object in the text of one frame.
///
/// A frame may carry more than one, and the server's opening dump does.
/// Anything between them that is not JSON is skipped rather than costing the
/// frame its readable messages.
pub fn split_messages(text: &str) -> Vec<Value> {
    serde_json::Deserializer::from_str(text)
        .into_iter::<Value>()
        .filter_map(Result::ok)
        .collect()
}
