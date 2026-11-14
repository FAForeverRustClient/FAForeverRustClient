//! Everything this client sends to the lobby.

use serde_json::{json, Value};

use crate::state::{HostGameConfig, PlayerVeto, Relation};

/// One message from this client to the lobby server.
///
/// The variants carry what the client means; [`Self::to_value`] is the one
/// place that knows how the server wants it spelled. The spellings are checked
/// against both reference clients and, where they disagree, the server's own
/// `lobbyconnection.py`.
#[derive(Debug, Clone, PartialEq)]
pub enum ClientMessage {
    /// The first message on a new connection: who is asking, for a session.
    AskSession {
        version: String,
        user_agent: String,
    },
    /// The sign-in, answering the server's `session`.
    Auth {
        token: String,
        /// The machine proof `faf-uid` computed for `session`.
        unique_id: String,
        session: String,
    },
    /// The keepalive this client sends after a stretch of silence.
    ///
    /// The same one-word command the Python client sends from
    /// `_ping_connection`. The server answers `pong`; the answer is not what
    /// matters, a frame arriving at all is.
    Ping,
    /// The answer to the server's own `ping`.
    Pong,
    /// Ask for the matchmaker queues as they stand.
    MatchmakerInfo,
    /// Confirm a match the server found.
    MatchReady,
    /// Join a lobby. An empty password is no password.
    GameJoin {
        uid: i32,
        password: Option<String>,
    },
    GameHost(HostGameConfig),
    /// Start or stop searching one queue.
    GameMatchmaking {
        queue_name: String,
        searching: bool,
    },
    LeaveParty,
    KickPlayerFromParty {
        player_id: i32,
    },
    InviteToParty {
        player_id: i32,
    },
    AcceptPartyInvite {
        player_id: i32,
    },
    /// The factions this player accepts in matchmaker games.
    SetPartyFactions {
        factions: Vec<String>,
    },
    /// Put an account on the friends or the foes list (`member`), or take it
    /// off. The server acknowledges neither.
    Relation {
        player_id: i32,
        relation: Relation,
        member: bool,
    },
    SetPlayerVetoes {
        vetoes: Vec<PlayerVeto>,
    },
    /// Ask which avatars this account may wear.
    ListAvatars,
    /// Wear the avatar at `url`, or none.
    SelectAvatar {
        url: Option<String>,
    },
    /// Tell the server this client is still in a game after its socket changed.
    RestoreGameSession {
        game_id: i32,
    },
    /// A connectivity message from the game or its ICE adapter, addressed to
    /// the game on the other side (`target: "game"`). `args` keep their JSON
    /// types for the GPGNet codec.
    GameRelay {
        command: String,
        args: Vec<Value>,
    },
}

impl ClientMessage {
    /// The `command` this message goes out under, for a log line.
    pub fn command(&self) -> &str {
        match self {
            Self::AskSession { .. } => "ask_session",
            Self::Auth { .. } => "auth",
            Self::Ping => "ping",
            Self::Pong => "pong",
            Self::MatchmakerInfo => "matchmaker_info",
            Self::MatchReady => "match_ready",
            Self::GameJoin { .. } => "game_join",
            Self::GameHost(_) => "game_host",
            Self::GameMatchmaking { .. } => "game_matchmaking",
            Self::LeaveParty => "leave_party",
            Self::KickPlayerFromParty { .. } => "kick_player_from_party",
            Self::InviteToParty { .. } => "invite_to_party",
            Self::AcceptPartyInvite { .. } => "accept_party_invite",
            Self::SetPartyFactions { .. } => "set_party_factions",
            Self::Relation { member: true, .. } => "social_add",
            Self::Relation { member: false, .. } => "social_remove",
            Self::SetPlayerVetoes { .. } => "set_player_vetoes",
            Self::ListAvatars | Self::SelectAvatar { .. } => "avatar",
            Self::RestoreGameSession { .. } => "restore_game_session",
            Self::GameRelay { command, .. } => command,
        }
    }

    /// The message as the JSON object the server reads.
    pub fn to_value(&self) -> Value {
        match self {
            Self::AskSession {
                version,
                user_agent,
            } => json!({
                "command": "ask_session",
                "version": version,
                "user_agent": user_agent,
            }),
            Self::Auth {
                token,
                unique_id,
                session,
            } => json!({
                "command": "auth",
                "token": token,
                "unique_id": unique_id,
                "session": session,
            }),
            Self::Ping => ping_frame(),
            Self::Pong => json!({ "command": "pong" }),
            Self::MatchmakerInfo => json!({ "command": "matchmaker_info" }),
            Self::MatchReady => json!({ "command": "match_ready" }),
            Self::GameJoin { uid, password } => {
                let mut frame = json!({ "command": "game_join", "uid": uid, "gameport": 0 });
                if let Some(password) = password.as_deref().filter(|value| !value.is_empty()) {
                    frame["password"] = Value::String(password.to_string());
                }
                frame
            }
            Self::GameHost(config) => host_frame(config.clone()),
            Self::GameMatchmaking {
                queue_name,
                searching,
            } => json!({
                "command": "game_matchmaking",
                "queue_name": queue_name,
                "state": if *searching { "start" } else { "stop" },
            }),
            Self::LeaveParty => json!({ "command": "leave_party" }),
            Self::KickPlayerFromParty { player_id } => json!({
                "command": "kick_player_from_party",
                "kicked_player_id": player_id,
            }),
            Self::InviteToParty { player_id } => json!({
                "command": "invite_to_party",
                "recipient_id": player_id,
            }),
            Self::AcceptPartyInvite { player_id } => json!({
                "command": "accept_party_invite",
                "sender_id": player_id,
            }),
            Self::SetPartyFactions { factions } => party_factions_frame(factions.clone()),
            Self::Relation {
                player_id,
                relation,
                member,
            } => relation_frame(*player_id, *relation, *member),
            Self::SetPlayerVetoes { vetoes } => {
                let vetoes = vetoes
                    .iter()
                    .map(|veto| {
                        json!({
                            "matchmaker_queue_map_pool_id": veto.matchmaker_queue_map_pool_id,
                            "map_pool_map_version_id": veto.map_pool_map_version_id,
                            "veto_tokens_applied": veto.veto_tokens_applied,
                        })
                    })
                    .collect::<Vec<_>>();
                json!({ "command": "set_player_vetoes", "vetoes": vetoes })
            }
            Self::ListAvatars => avatar_list_frame(),
            Self::SelectAvatar { url } => avatar_select_frame(url.clone()),
            Self::RestoreGameSession { game_id } => restore_game_session_frame(*game_id),
            Self::GameRelay { command, args } => {
                json!({ "command": command, "target": "game", "args": args })
            }
        }
    }

    /// The message as it goes onto the socket: one line of JSON.
    pub fn encode(&self) -> String {
        super::encode_lobby_message(&self.to_value())
    }

    /// Whether this is the relay that reports the game process gone.
    ///
    /// The launcher sends `GameState Ended` to the server the moment the
    /// process exits, the way the Python client does in `GameSession._exited`.
    /// It is the only signal a connection gets that a match it started is
    /// over, which is why the session watches for it going past.
    pub fn reports_game_ended(&self) -> bool {
        matches!(
            self,
            Self::GameRelay { command, args }
                if command == "GameState"
                    && args
                        .first()
                        .and_then(Value::as_str)
                        .is_some_and(|state| state.eq_ignore_ascii_case("Ended"))
        )
    }
}

/// The keepalive this client sends after ten seconds of silence.
///
/// The same one-word command the Python client sends from `_ping_connection`.
/// The server answers `pong`, which the receive loop ignores: the answer is
/// not what matters, a frame arriving at all is.
pub(super) fn ping_frame() -> Value {
    json!({ "command": "ping" })
}

pub(super) fn avatar_list_frame() -> Value {
    json!({ "command": "avatar", "action": "list_avatar" })
}

pub(super) fn avatar_select_frame(url: Option<String>) -> Value {
    json!({ "command": "avatar", "action": "select", "avatar": url })
}

/// Build the `social_add`/`social_remove` frame:
/// `{"command": "social_add"|"social_remove", "friend"|"foe": <id>}`. Verified
/// against both reference clients (`py-client`'s `IrcRelationController` and
/// the Java client's `ServerAccessorTest`).
pub(super) fn relation_frame(player_id: i32, relation: Relation, member: bool) -> Value {
    let command = if member {
        "social_add"
    } else {
        "social_remove"
    };
    let key = match relation {
        Relation::Friend => "friend",
        Relation::Foe => "foe",
    };
    json!({ "command": command, key: player_id })
}

pub(super) fn party_factions_frame(factions: Vec<String>) -> Value {
    let factions = factions
        .into_iter()
        .map(|faction| faction.to_ascii_lowercase())
        .collect::<Vec<_>>();
    json!({
        "command": "set_party_factions",
        "factions": factions,
    })
}

/// The `restore_game_session` frame, built apart from sending it so its shape
/// is testable without a live socket.
///
/// `game_id` is a number on the wire. The server reads it with `int(...)`, so a
/// string would work too, and both reference clients send a number.
pub(super) fn restore_game_session_frame(game_id: i32) -> Value {
    json!({ "command": "restore_game_session", "game_id": game_id })
}

/// The `game_host` frame, built apart from sending it so the password rule is
/// testable without a live socket.
///
/// The password is null, not an empty string, when the host did not set one.
/// The server stores whatever arrives and then advertises the game as
/// `password_protected: self.password is not None`, so `""` produced a locked
/// game nobody could join: a joiner sends no password at all, and the server
/// compares `None` against `""` and refuses. The Python client sends `None`
/// here for exactly this reason.
pub(super) fn host_frame(config: HostGameConfig) -> Value {
    let mut frame = json!({
        "command": "game_host",
        "title": config.title,
        "mod": config.mod_name,
        "visibility": config.visibility,
        "mapname": config.map,
        "password": match config.password {
            Some(password) => Value::String(password),
            None => Value::Null,
        },
    });
    // The flag, not just the bounds. The server reads all three
    // (`lobbyconnection.on_game_host`) and only its `enforce_rating_range`
    // makes `Game.is_visible_to_player` consult the range at all: sending the
    // bounds alone produced a lobby that advertised a rating window and
    // admitted anybody, which is what the report described. Sent either way,
    // as Java does (`NewGameInfo`), so an unenforced range is still the one
    // the lobby advertises.
    frame["enforce_rating_range"] = json!(config.enforce_rating_range);
    if let Some(min) = config.rating_min {
        frame["rating_min"] = json!(min);
    }
    if let Some(max) = config.rating_max {
        frame["rating_max"] = json!(max);
    }
    frame
}
