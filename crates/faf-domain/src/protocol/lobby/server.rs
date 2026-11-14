//! Everything the lobby sends to this client.

use chrono::{DateTime, Utc};
use serde_json::Value;

use super::game::{games_in, parse_game_launch, GameInfo};
use super::matchmaker::{parse_matchmaker_queues_at, parse_party, parse_vetoes};
use super::notice::{server_text, server_words, Notice};
use super::player::{parse_available_avatars, PlayerEntry, SocialLists};
use crate::state::{AvailableAvatar, GameLaunch, MatchmakerQueue, PartyState, PlayerVeto};

/// One message from the lobby server, with its fields read.
///
/// A message says what arrived and nothing about what it means for the
/// session: `PlayerInfo` does not know which of its players are new, and
/// `GameInfo` does not know whether its games replace the list. That takes
/// what the session remembers, which is the adapter's.
#[derive(Debug, Clone, PartialEq)]
pub enum ServerMessage {
    /// A connectivity message addressed to the game (`target: "game"`):
    /// `HostGame`, `JoinGame`, `ConnectToPeer`, `IceMsg` and the rest, to be
    /// handed to the ICE adapter whatever its `command` is. `args` keep their
    /// JSON types (numbers against strings) for the GPGNet codec.
    GameRelay {
        command: String,
        args: Vec<Value>,
    },
    /// The server's keepalive, to be answered with `pong`.
    Ping,
    /// The answer to `ask_session`: the id the machine proof is computed for.
    /// A number on the wire from some servers; always text here.
    Session {
        session: String,
    },
    /// The sign-in was refused. `authentication_failure` is the broker's name
    /// for it, `authentication_failed` the lobby server's.
    AuthenticationFailed {
        reason: String,
    },
    /// The sign-in was accepted. `me` is this account's own entry.
    Welcome {
        me: Option<PlayerEntry>,
    },
    /// Players who appeared, changed or left.
    PlayerInfo {
        players: Vec<PlayerEntry>,
    },
    Notice(Notice),
    /// The server could not make sense of something this client sent. FAF
    /// sends a bare `{"command": "invalid"}`, so there is usually no text;
    /// what it refers to is a question of when it arrives.
    Invalid {
        text: Option<String>,
    },
    /// One game, or the batch of them the server opens a session with.
    GameInfo {
        games: Vec<GameInfo>,
    },
    /// The order to start a game. `None` when the message lacks the game's
    /// id, without which there is nothing to start.
    GameLaunch(Option<GameLaunch>),
    GameJoinFailed {
        id: i32,
        reason: String,
    },
    MatchmakerInfo {
        queues: Vec<MatchmakerQueue>,
    },
    /// This account started or stopped searching a queue.
    SearchInfo {
        queue_name: String,
        searching: bool,
    },
    MatchFound {
        queue_name: String,
    },
    MatchCancelled,
    UpdateParty(PartyState),
    /// An invitation to a party. `sender_id` is 0 when the message names
    /// nobody, which no account is.
    PartyInvite {
        sender_id: i32,
    },
    KickedFromParty,
    /// The vetoes the server holds for this player. `forced` is its own flag
    /// for having changed them itself.
    VetoesInfo {
        vetoes: Vec<PlayerVeto>,
        forced: bool,
    },
    Social(SocialLists),
    /// The avatars this account may wear, answering `avatar list_avatar`.
    Avatars(Vec<AvailableAvatar>),
    /// The broker refused to pass on a frame from this client: a command it
    /// has no schema for, or one that does not match it.
    FailedMessage {
        reason: String,
        key: String,
        request: String,
    },
    /// Anything else: `pong`, a `player_info` without players, and whatever
    /// the server learns to say next.
    Other {
        command: String,
    },
}

impl ServerMessage {
    /// Read one JSON object from the server.
    ///
    /// `received` is when it arrived. The matchmaker counts the time to a
    /// queue's next pop from that moment, and this crate reads no clock.
    pub fn decode(value: &Value, received: DateTime<Utc>) -> Self {
        // Before the command: a message addressed to the game is relayed
        // whatever it is called.
        if value.get("target").and_then(Value::as_str) == Some("game") {
            return Self::GameRelay {
                command: super::command_of(value).to_string(),
                args: value
                    .get("args")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            };
        }
        let text = |key: &str| value.get(key).and_then(Value::as_str);
        match super::command_of(value) {
            "ping" => Self::Ping,
            "session" => Self::Session {
                session: session_to_string(value.get("session").unwrap_or(&Value::Null)),
            },
            "authentication_failed" | "authentication_failure" => Self::AuthenticationFailed {
                reason: server_text(value, "The lobby server rejected authentication."),
            },
            "welcome" => Self::Welcome {
                me: value.get("me").map(PlayerEntry::decode),
            },
            "player_info" => match value.get("players").and_then(Value::as_array) {
                Some(players) => Self::PlayerInfo {
                    players: players.iter().map(PlayerEntry::decode).collect(),
                },
                None => Self::Other {
                    command: "player_info".into(),
                },
            },
            "notice" => Self::Notice(Notice::decode(value)),
            "invalid" => Self::Invalid {
                text: server_words(value),
            },
            "game_info" => Self::GameInfo {
                games: games_in(value),
            },
            "game_launch" => Self::GameLaunch(parse_game_launch(value)),
            "game_join_failed" => Self::GameJoinFailed {
                id: value.get("uid").and_then(Value::as_i64).unwrap_or(0) as i32,
                reason: text("reason").unwrap_or("unknown").to_string(),
            },
            "matchmaker_info" => Self::MatchmakerInfo {
                queues: parse_matchmaker_queues_at(value, received),
            },
            "search_info" => Self::SearchInfo {
                queue_name: text("queue_name").unwrap_or_default().to_string(),
                searching: text("state") == Some("start"),
            },
            "match_found" => Self::MatchFound {
                queue_name: text("queue_name").unwrap_or_default().to_string(),
            },
            "match_cancelled" => Self::MatchCancelled,
            "update_party" => Self::UpdateParty(parse_party(value)),
            "party_invite" => Self::PartyInvite {
                sender_id: value
                    .get("sender")
                    .or_else(|| value.get("sender_id"))
                    .and_then(|id| id.as_i64().or_else(|| id.as_str()?.parse().ok()))
                    .unwrap_or_default() as i32,
            },
            "kicked_from_party" => Self::KickedFromParty,
            "vetoes_info" => Self::VetoesInfo {
                vetoes: parse_vetoes(value),
                forced: value
                    .get("forced")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            },
            "social" => Self::Social(SocialLists::decode(value)),
            "avatar" => Self::Avatars(parse_available_avatars(value)),
            "failed_message" => Self::FailedMessage {
                reason: text("message").unwrap_or("").to_string(),
                key: text("message_key").unwrap_or("").to_string(),
                request: text("request_id").unwrap_or("").to_string(),
            },
            other => Self::Other {
                command: other.to_string(),
            },
        }
    }
}

/// The session id may arrive as a JSON number or string; `faf-uid` wants it as a
/// plain string argument.
pub(super) fn session_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}
