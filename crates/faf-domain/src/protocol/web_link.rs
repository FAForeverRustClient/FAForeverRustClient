//! The web link: this client and FAF's web client (webclient.faforever.com),
//! so a player can start a matchmaker search from their phone and be told on
//! it when the match is found.
//!
//! Both ends connect *out* to the web client's server, which pairs a browser
//! with this client only when both are signed in to the same FAF account: the
//! client proves it with its OIDC ID token, which the server checks against
//! Hydra's published signing keys and the client id it was issued to (`aud`).
//! An ID token says who is signed in and nothing more: neither the API nor
//! the lobby accepts it, so the server never holds anything that could act as
//! the player. Nothing on this computer listens for anything.
//!
//! What crosses the link, and only this:
//!
//! * out: who is signed in, the lobby connection, the matchmaker queues, the
//!   search, the party, the game this client is in, the friends list, the open
//!   lobbies, "match found", and "your PC needs you" when something the web
//!   client asked for stops at a decision only the player at the PC can make;
//! * in: four requests ([`RemoteCommand`]): start a search in named queues,
//!   stop searching, join a game (with its password), and send everything
//!   again. Each is checked here against this client's own state before it
//!   becomes the same [`LobbyCommand`] the Play tab sends, and the setting that
//!   allows any of it is off until the player turns it on.
//!
//! The server, the browser side and the same rules from the other end are in
//! FAForever/faf-webclient (`lib/link.js`). Messages are JSON text frames,
//! version [`PROTOCOL_VERSION`]. `docs/web-link-protocol.json` is generated
//! from the types here (`tests/web_link_protocol.rs`) and checked by the web
//! client's own tests, so the two ends cannot drift apart unnoticed. Pure: the
//! socket is `infra::web_link`, the loop that drives it `services::web_link`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::state::{AppState, Game, JoinState, LobbyCommand, LobbyStatus, MatchmakingState};
use crate::AppCommand;

pub const PROTOCOL_VERSION: u32 = 1;

/// Where the link connects, unless `FAF_WEB_LINK_URL` says otherwise.
pub const DEFAULT_URL: &str = "wss://webclient.faforever.com/api/link";

/// The most queues one search request may name. FAF has five.
pub const MAX_QUEUES: usize = 8;
/// A queue's technical name: ASCII letters, digits and `_`, at most this long.
pub const MAX_QUEUE_NAME_BYTES: usize = 64;
/// A lobby password, as long as the host dialog allows and then some. Counted
/// in characters (code points), not bytes or UTF-16 units.
pub const MAX_PASSWORD_CHARS: usize = 100;

/// The ID token, kept out of `Debug` so a logged message never carries it.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Token(pub String);

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Token(<redacted>)")
    }
}

/// What this client sends.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Outbound {
    /// The first message: who this is. `role` is always `"pc"`. Nothing about
    /// the computer itself is sent: its name is often its owner's.
    Hello {
        role: &'static str,
        version: u32,
        token: Token,
        /// "FAF Rust client 1.2.3", shown to the player's browsers.
        client: String,
    },
    State {
        state: Snapshot,
    },
    Games {
        games: Vec<GameSummary>,
    },
    /// `matchFound` (with `queue` and its `title`), or `attention` (with a
    /// `reason` the player can read): the two the server turns into a phone
    /// notification.
    Event {
        event: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        queue: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// The answer to one [`Inbound::Command`].
    Result {
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

/// The hello for this client, with its ID token.
pub fn hello(id_token: String, client: String) -> Outbound {
    Outbound::Hello {
        role: "pc",
        version: PROTOCOL_VERSION,
        token: Token(id_token),
        client,
    }
}

/// A queue as the Play tab names it ("1 vs 1"): what the browser shows and
/// the phone notification says, so neither has to know queue names.
pub fn queue_title(team_size: i32) -> String {
    format!("{team_size} vs {team_size}")
}

/// "Match found" for a queue, titled from this client's own queue list.
pub fn match_found_event(queue: String, state: &AppState) -> Outbound {
    let title = state
        .lobby
        .matchmaker_queues
        .iter()
        .find(|known| known.queue_name == queue)
        .map(|known| queue_title(known.team_size));
    Outbound::Event {
        event: "matchFound".into(),
        queue: Some(queue),
        title,
        reason: None,
    }
}

/// "Your PC needs you", and why.
pub fn attention_event(reason: String) -> Outbound {
    Outbound::Event {
        event: "attention".into(),
        queue: None,
        title: None,
        reason: Some(reason),
    }
}

pub fn encode(message: &Outbound) -> String {
    // Every field is a string, a number, a bool or a list of those: this
    // cannot fail, and an empty object is what a failure would send.
    serde_json::to_string(message).unwrap_or_else(|_| "{}".into())
}

/// What the server sends.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Inbound {
    /// The hello was accepted. `browsers`: how many of the player's browsers
    /// are connected.
    Welcome {
        #[serde(default)]
        browsers: u32,
    },
    /// A browser came or went.
    Browsers { count: u32 },
    /// A browser's request, as the server passed it on. Read with
    /// [`RemoteCommand::parse`]: the server checks it too, but this client
    /// does not take its word for it.
    Command { id: String, command: Value },
    /// Another computer signed in to the same account took the link over.
    Replaced,
    /// The hello was refused, and why.
    Error {
        #[serde(default)]
        code: String,
        #[serde(default)]
        message: String,
    },
    /// Anything a later server says that this version does not know.
    #[serde(other)]
    Unknown,
}

pub fn decode(text: &str) -> Option<Inbound> {
    serde_json::from_str(text).ok()
}

// ---- what a browser may ask

/// The four requests a browser can make, checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteCommand {
    StartSearch {
        queues: Vec<String>,
    },
    /// Every queue when `None`.
    StopSearch {
        queues: Option<Vec<String>>,
    },
    JoinGame {
        game_id: i32,
        password: Option<String>,
    },
    Refresh,
}

fn queue_names(value: Option<&Value>) -> Option<Vec<String>> {
    let list = value?.as_array()?;
    if list.len() > MAX_QUEUES {
        return None;
    }
    let mut names = Vec::with_capacity(list.len());
    for item in list {
        let name = item.as_str()?;
        let plain = !name.is_empty()
            && name.len() <= MAX_QUEUE_NAME_BYTES
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !plain {
            return None;
        }
        if !names.iter().any(|known: &String| known == name) {
            names.push(name.to_string());
        }
    }
    Some(names)
}

impl RemoteCommand {
    /// A browser's request, or `None` for anything that is not one of the four
    /// in the expected shape.
    pub fn parse(value: &Value) -> Option<Self> {
        match value.get("action")?.as_str()? {
            "startSearch" => {
                let queues = queue_names(value.get("queues"))?;
                (!queues.is_empty()).then_some(Self::StartSearch { queues })
            }
            "stopSearch" => match value.get("queues") {
                None | Some(Value::Null) => Some(Self::StopSearch { queues: None }),
                some => Some(Self::StopSearch {
                    queues: Some(queue_names(some)?),
                }),
            },
            "joinGame" => {
                // JavaScript has one number type: `42.0` and `42` are the same
                // id once the browser has parsed them, so both are read here.
                let raw = value.get("gameId")?;
                let whole = raw.as_i64().or_else(|| {
                    raw.as_f64()
                        .filter(|f| f.fract() == 0.0 && f.abs() < 1e12)
                        .map(|f| f as i64)
                })?;
                let game_id = i32::try_from(whole).ok()?;
                if game_id < 1 {
                    return None;
                }
                let password = match value.get("password") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(text)) if text.chars().count() <= MAX_PASSWORD_CHARS => {
                        (!text.is_empty()).then(|| text.clone())
                    }
                    Some(_) => return None,
                };
                Some(Self::JoinGame { game_id, password })
            }
            "refresh" => Some(Self::Refresh),
            _ => None,
        }
    }

    /// The request in the one shape both ends agree on: what the web client's
    /// server passes on after its own check. `docs/web-link-protocol.json`
    /// pins it.
    pub fn to_wire(&self) -> Value {
        match self {
            Self::StartSearch { queues } => json!({ "action": "startSearch", "queues": queues }),
            Self::StopSearch { queues: None } => json!({ "action": "stopSearch" }),
            Self::StopSearch {
                queues: Some(queues),
            } => json!({ "action": "stopSearch", "queues": queues }),
            Self::JoinGame {
                game_id,
                password: None,
            } => json!({ "action": "joinGame", "gameId": game_id }),
            Self::JoinGame {
                game_id,
                password: Some(password),
            } => json!({ "action": "joinGame", "gameId": game_id, "password": password }),
            Self::Refresh => json!({ "action": "refresh" }),
        }
    }
}

/// Whether this client is busy with a game: joining one, getting it ready,
/// or running it.
fn in_a_game(join: &JoinState) -> bool {
    matches!(
        join,
        JoinState::Joining { .. }
            | JoinState::Preparing { .. }
            | JoinState::Launched { .. }
            | JoinState::InGame
    )
}

/// What a request becomes here: the lobby commands the Play tab would send for
/// the same thing, or why not. `Refresh` is the service's own business and
/// plans to nothing.
///
/// These are the refusals the browser should hear straight away. The lobby
/// service still checks everything again when the command runs, exactly as
/// it does for a click in the Play tab.
pub fn plan(command: &RemoteCommand, state: &AppState) -> Result<Vec<AppCommand>, String> {
    if !state.settings.web_link.enabled {
        return Err("Control from the web client is turned off on this PC.".into());
    }
    let connected = matches!(state.lobby.status, LobbyStatus::Connected);
    match command {
        RemoteCommand::Refresh => Ok(Vec::new()),
        RemoteCommand::StartSearch { queues } => {
            if !connected {
                return Err("The client on your PC is not connected to FAF.".into());
            }
            let matchmaking = &state.lobby.matchmaking;
            if matchmaking.is_looking() {
                return Err("Your PC is already searching.".into());
            }
            if matches!(
                matchmaking,
                MatchmakingState::MatchFound { .. } | MatchmakingState::Launching { .. }
            ) {
                return Err("A match is already starting.".into());
            }
            if in_a_game(&state.lobby.join) {
                return Err("Your PC is in a game. Leave it before searching.".into());
            }
            let me = state.auth.player.as_ref().map(|player| player.id);
            let party = &state.lobby.party;
            if party.members.len() > 1 && party.owner_id != me {
                return Err("You are in a party: its leader starts the search.".into());
            }
            let party_size = party.members.len().max(1);
            for name in queues {
                let Some(queue) = state
                    .lobby
                    .matchmaker_queues
                    .iter()
                    .find(|queue| &queue.queue_name == name)
                else {
                    return Err(format!("There is no queue called {name}."));
                };
                if usize::try_from(queue.team_size).unwrap_or(0) < party_size {
                    return Err(format!("Your party is too large for {name}."));
                }
            }
            Ok(vec![LobbyCommand::StartSearch {
                queue_names: queues.clone(),
            }
            .into()])
        }
        RemoteCommand::StopSearch { queues } => {
            let running: Vec<String> = match &state.lobby.matchmaking {
                MatchmakingState::Preparing { queue_names }
                | MatchmakingState::Searching { queue_names } => queue_names.clone(),
                _ => Vec::new(),
            };
            let stop = running
                .into_iter()
                .filter(|name| queues.as_ref().is_none_or(|asked| asked.contains(name)))
                .map(|queue_name| {
                    LobbyCommand::Matchmake {
                        queue_name,
                        start: false,
                    }
                    .into()
                })
                .collect();
            // Nothing running is not a failure: the search the browser saw
            // may have ended on its own in the meantime.
            Ok(stop)
        }
        RemoteCommand::JoinGame { game_id, password } => {
            if !connected {
                return Err("The client on your PC is not connected to FAF.".into());
            }
            if in_a_game(&state.lobby.join) {
                return Err("Your PC is already in a game.".into());
            }
            if state.lobby.matchmaking.is_looking() {
                return Err("Your PC is searching for a match. Stop the search first.".into());
            }
            let Some(game) = state.lobby.games.iter().find(|game| game.id == *game_id) else {
                return Err("That lobby is not open any more.".into());
            };
            if game.password_protected && password.is_none() {
                return Err("This lobby needs a password.".into());
            }
            Ok(vec![LobbyCommand::Join {
                id: *game_id,
                password: password.clone(),
                replace_mods: false,
            }
            .into()])
        }
    }
}

// ---- what the browser is shown

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub player: Option<PlayerSummary>,
    /// "connected", "connecting" or "disconnected": this client and FAF's lobby.
    pub lobby: &'static str,
    pub queues: Vec<QueueSummary>,
    pub matchmaking: MatchmakingSummary,
    pub party: PartySummary,
    pub game: Option<CurrentGame>,
    /// Online first, then by name.
    pub friends: Vec<FriendSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSummary {
    pub id: i32,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSummary {
    pub name: String,
    /// "1 vs 1", from [`queue_title`].
    pub title: String,
    pub team_size: i32,
    pub players_in_queue: i32,
    /// RFC 3339, when the server said.
    pub pops_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchmakingSummary {
    /// "idle", "preparing", "searching", "matchFound", "launching" or "cancelled".
    pub status: &'static str,
    pub queues: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartySummary {
    pub owner_id: Option<i32>,
    pub members: Vec<PlayerSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentGame {
    pub id: Option<i32>,
    pub title: String,
    /// "joining", "preparing", "launched", "lobby" or "playing"; or
    /// "needsYou" and "failed", with `problem` saying what happened.
    pub status: &'static str,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendSummary {
    pub name: String,
    pub online: bool,
    pub game: Option<FriendGame>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendGame {
    pub id: i32,
    pub title: String,
    /// "lobby" or "playing".
    pub status: &'static str,
}

/// One open lobby, as the web client's Play tab draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSummary {
    pub id: i32,
    pub title: String,
    pub host: String,
    pub map: String,
    #[serde(rename = "mod")]
    pub mod_name: String,
    pub players: i32,
    pub max_players: i32,
    pub password_protected: bool,
    pub rating_min: Option<i32>,
    pub rating_max: Option<i32>,
    pub enforce_rating: bool,
    pub sim_mods: Vec<String>,
    pub teams: BTreeMap<String, Vec<String>>,
    pub hosted_at: Option<String>,
}

fn has_player(game: &Game, login: &str) -> bool {
    game.teams
        .values()
        .flatten()
        .any(|player| player.eq_ignore_ascii_case(login))
}

/// The game a login is in, playing before open: a game briefly appears in
/// both lists as the server moves it (the same order as Rich Presence).
fn game_of<'a>(state: &'a AppState, login: &str) -> Option<(&'a Game, &'static str)> {
    state
        .lobby
        .live_games
        .iter()
        .find(|game| has_player(game, login))
        .map(|game| (game, "playing"))
        .or_else(|| {
            state
                .lobby
                .games
                .iter()
                .find(|game| has_player(game, login))
                .map(|game| (game, "lobby"))
        })
}

fn current_game(state: &AppState) -> Option<CurrentGame> {
    let title_of = |id: i32| {
        state
            .lobby
            .games
            .iter()
            .chain(state.lobby.live_games.iter())
            .find(|game| game.id == id)
            .map(|game| game.title.clone())
            .unwrap_or_default()
    };
    match &state.lobby.join {
        JoinState::Joining { id, .. } => Some(CurrentGame {
            id: Some(*id),
            title: title_of(*id),
            status: "joining",
            problem: None,
        }),
        JoinState::Preparing { .. } => Some(CurrentGame {
            id: None,
            title: String::new(),
            status: "preparing",
            problem: None,
        }),
        JoinState::Launched { launch } => Some(CurrentGame {
            id: Some(launch.uid),
            title: launch.name.clone(),
            status: "launched",
            problem: None,
        }),
        JoinState::NeedsModReplacement { id, .. } => Some(CurrentGame {
            id: Some(*id),
            title: title_of(*id),
            status: "needsYou",
            problem: problem(&state.lobby.join),
        }),
        JoinState::Failed { id, .. } => Some(CurrentGame {
            id: Some(*id),
            title: title_of(*id),
            status: "failed",
            problem: problem(&state.lobby.join),
        }),
        JoinState::LaunchFailed { .. } => Some(CurrentGame {
            id: None,
            title: String::new(),
            status: "failed",
            problem: problem(&state.lobby.join),
        }),
        JoinState::InGame => {
            let me = state
                .auth
                .player
                .as_ref()
                .map(|player| player.name.as_str());
            Some(match me.and_then(|login| game_of(state, login)) {
                Some((game, status)) => CurrentGame {
                    id: Some(game.id),
                    title: game.title.clone(),
                    status,
                    problem: None,
                },
                None => CurrentGame {
                    id: None,
                    title: String::new(),
                    status: "playing",
                    problem: None,
                },
            })
        }
        _ => None,
    }
}

/// Server and launch errors arrive as free text; a phone notification keeps
/// to a sentence. Counted in characters (code points).
pub const MAX_PROBLEM_CHARS: usize = 200;

/// What the player has to know when a join stops short of the game: a
/// decision only they can make at the PC, or a failure.
fn problem(join: &JoinState) -> Option<String> {
    let text = match join {
        JoinState::NeedsModReplacement { .. } => {
            "This lobby needs other versions of mods you have installed. Decide on your PC whether to replace them.".to_string()
        }
        JoinState::Failed { reason, .. } => format!("The game could not be joined: {}", reason.trim()),
        JoinState::LaunchFailed { reason } => format!("The game could not start: {}", reason.trim()),
        _ => return None,
    };
    Some(text.chars().take(MAX_PROBLEM_CHARS).collect())
}

/// Why the PC needs its player, if `after` is a join that just stopped at a
/// decision or failed. Sent only after the web client asked for something
/// (the service keeps track), so a player sitting at the PC gets no push.
pub fn attention(before: &JoinState, after: &JoinState) -> Option<String> {
    let stopped = matches!(
        after,
        JoinState::NeedsModReplacement { .. }
            | JoinState::Failed { .. }
            | JoinState::LaunchFailed { .. }
    );
    if !stopped || std::mem::discriminant(before) == std::mem::discriminant(after) {
        return None;
    }
    problem(after)
}

fn matchmaking(state: &MatchmakingState) -> MatchmakingSummary {
    let (status, queues) = match state {
        MatchmakingState::Idle => ("idle", Vec::new()),
        MatchmakingState::Preparing { queue_names } => ("preparing", queue_names.clone()),
        MatchmakingState::Searching { queue_names } => ("searching", queue_names.clone()),
        MatchmakingState::MatchFound { queue_name } => ("matchFound", vec![queue_name.clone()]),
        MatchmakingState::Launching { queue_name } => ("launching", vec![queue_name.clone()]),
        MatchmakingState::Cancelled { queue_name } => {
            ("cancelled", queue_name.iter().cloned().collect())
        }
    };
    MatchmakingSummary { status, queues }
}

/// Everything the browser shows, from this client's state.
pub fn snapshot(state: &AppState) -> Snapshot {
    let lobby = match state.lobby.status {
        LobbyStatus::Connected => "connected",
        LobbyStatus::Connecting => "connecting",
        LobbyStatus::Disconnected => "disconnected",
    };
    let queues = state
        .lobby
        .matchmaker_queues
        .iter()
        .map(|queue| QueueSummary {
            name: queue.queue_name.clone(),
            title: queue_title(queue.team_size),
            team_size: queue.team_size,
            players_in_queue: queue.num_players,
            pops_at: (!queue.queue_pops_at.is_empty()).then(|| queue.queue_pops_at.clone()),
        })
        .collect();
    let party = PartySummary {
        owner_id: state.lobby.party.owner_id,
        members: state
            .lobby
            .party
            .members
            .iter()
            .map(|member| PlayerSummary {
                id: member.player_id,
                name: member.name.clone(),
            })
            .collect(),
    };
    let mut friends: Vec<FriendSummary> = state
        .social
        .friends
        .iter()
        .map(|login| {
            let online = state
                .social
                .players
                .iter()
                .any(|player| player.login.eq_ignore_ascii_case(login));
            FriendSummary {
                name: login.clone(),
                online,
                game: game_of(state, login).map(|(game, status)| FriendGame {
                    id: game.id,
                    title: game.title.clone(),
                    status,
                }),
            }
        })
        .collect();
    friends.sort_by(|a, b| {
        b.online
            .cmp(&a.online)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Snapshot {
        player: state.auth.player.as_ref().map(|player| PlayerSummary {
            id: player.id,
            name: player.name.clone(),
        }),
        lobby,
        queues,
        matchmaking: matchmaking(&state.lobby.matchmaking),
        party,
        game: current_game(state),
        friends,
    }
}

/// The open lobbies, as the browser lists them.
pub fn games(state: &AppState) -> Vec<GameSummary> {
    state
        .lobby
        .games
        .iter()
        .map(|game| GameSummary {
            id: game.id,
            title: game.title.clone(),
            host: game.host.clone(),
            map: game.map.clone(),
            mod_name: game.mod_name.clone(),
            players: game.players,
            max_players: game.max_players,
            password_protected: game.password_protected,
            rating_min: game.rating_min,
            rating_max: game.rating_max,
            enforce_rating: game.enforce_rating_range,
            sim_mods: game.sim_mods.values().cloned().collect(),
            teams: game.teams.clone(),
            hosted_at: game.hosted_at.clone(),
        })
        .collect()
}

/// The queue a match was just found in, if `after` is a match `before` was not.
/// This is what sends "Match found" to the player's phone.
pub fn match_found(before: &MatchmakingState, after: &MatchmakingState) -> Option<String> {
    match (before, after) {
        (
            MatchmakingState::MatchFound { queue_name: old },
            MatchmakingState::MatchFound { queue_name },
        ) if old == queue_name => None,
        (_, MatchmakingState::MatchFound { queue_name }) => Some(queue_name.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{MatchmakerQueue, PartyMember, PartyState, Player, PlayerProfile};
    use serde_json::json;

    fn queue(name: &str, team_size: i32) -> MatchmakerQueue {
        MatchmakerQueue {
            queue_name: name.into(),
            team_size,
            num_players: 3,
            queue_pop_time_seconds: 30,
            queue_pops_at: String::new(),
            boundary_80s: Vec::new(),
            boundary_75s: Vec::new(),
        }
    }

    fn game(id: i32, title: &str, players: &[&str]) -> Game {
        let mut teams = BTreeMap::new();
        teams.insert(
            "1".to_string(),
            players.iter().map(|p| p.to_string()).collect(),
        );
        Game {
            id,
            title: title.into(),
            host: players.first().map(|p| p.to_string()).unwrap_or_default(),
            players: players.len() as i32,
            max_players: 8,
            map: "setons_clutch".into(),
            mod_name: "faf".into(),
            average_rating: 0,
            rating_type: "global".into(),
            password_protected: false,
            visibility: "public".into(),
            game_type: "custom".into(),
            launched_at: None,
            hosted_at: None,
            rating_min: None,
            rating_max: None,
            enforce_rating_range: false,
            teams,
            sim_mods: BTreeMap::new(),
        }
    }

    fn ready() -> AppState {
        let mut state = AppState::default();
        state.settings.web_link.enabled = true;
        state.auth.player = Some(Player {
            id: 7,
            name: "Nuggets".into(),
            roles: Vec::new(),
        });
        state.lobby.status = LobbyStatus::Connected;
        state.lobby.matchmaker_queues = vec![queue("ladder1v1", 1), queue("tmm2v2", 2)];
        state.lobby.games = vec![game(11, "Setons", &["Deli"])];
        state
    }

    #[test]
    fn only_the_four_requests_in_their_shapes_are_read() {
        assert_eq!(
            RemoteCommand::parse(
                &json!({"action":"startSearch","queues":["ladder1v1","ladder1v1","tmm2v2"]})
            ),
            Some(RemoteCommand::StartSearch {
                queues: vec!["ladder1v1".into(), "tmm2v2".into()]
            })
        );
        assert_eq!(
            RemoteCommand::parse(&json!({"action":"startSearch","queues":[]})),
            None
        );
        assert_eq!(
            RemoteCommand::parse(&json!({"action":"startSearch","queues":["a b"]})),
            None
        );
        assert_eq!(
            RemoteCommand::parse(&json!({"action":"stopSearch"})),
            Some(RemoteCommand::StopSearch { queues: None })
        );
        assert_eq!(
            RemoteCommand::parse(&json!({"action":"joinGame","gameId":42,"password":"pw"})),
            Some(RemoteCommand::JoinGame {
                game_id: 42,
                password: Some("pw".into())
            })
        );
        assert_eq!(
            RemoteCommand::parse(&json!({"action":"joinGame","gameId":0})),
            None
        );
        assert_eq!(
            RemoteCommand::parse(&json!({"action":"joinGame","gameId":1.5})),
            None
        );
        assert_eq!(
            RemoteCommand::parse(
                &json!({"action":"joinGame","gameId":3,"password":"x".repeat(101)})
            ),
            None
        );
        assert_eq!(
            RemoteCommand::parse(&json!({"action":"host","title":"x"})),
            None
        );
        assert_eq!(
            RemoteCommand::parse(&json!({"action":"refresh"})),
            Some(RemoteCommand::Refresh)
        );
    }

    #[test]
    fn a_search_becomes_the_play_tabs_command() {
        let state = ready();
        let planned = plan(
            &RemoteCommand::StartSearch {
                queues: vec!["ladder1v1".into()],
            },
            &state,
        )
        .unwrap();
        assert_eq!(
            planned,
            vec![AppCommand::from(LobbyCommand::StartSearch {
                queue_names: vec!["ladder1v1".into()]
            })]
        );
    }

    #[test]
    fn nothing_runs_while_the_setting_is_off() {
        let mut state = ready();
        state.settings.web_link.enabled = false;
        for command in [
            RemoteCommand::StartSearch {
                queues: vec!["ladder1v1".into()],
            },
            RemoteCommand::JoinGame {
                game_id: 11,
                password: None,
            },
            RemoteCommand::StopSearch { queues: None },
        ] {
            assert!(plan(&command, &state).is_err(), "{command:?}");
        }
    }

    #[test]
    fn a_search_is_refused_where_the_play_tab_would_refuse_it() {
        let start = |name: &str| RemoteCommand::StartSearch {
            queues: vec![name.into()],
        };

        let mut state = ready();
        state.lobby.status = LobbyStatus::Disconnected;
        assert!(plan(&start("ladder1v1"), &state).is_err());

        let mut state = ready();
        state.lobby.matchmaking = MatchmakingState::Searching {
            queue_names: vec!["tmm2v2".into()],
        };
        assert!(plan(&start("ladder1v1"), &state).is_err());

        let state = ready();
        assert!(plan(&start("tmm9v9"), &state).is_err(), "an unknown queue");

        let mut state = ready();
        state.lobby.party = PartyState {
            owner_id: Some(99),
            members: vec![
                PartyMember {
                    player_id: 99,
                    name: "Leader".into(),
                    factions: Vec::new(),
                },
                PartyMember {
                    player_id: 7,
                    name: "Nuggets".into(),
                    factions: Vec::new(),
                },
            ],
        };
        assert!(
            plan(&start("tmm2v2"), &state).is_err(),
            "not the party leader"
        );
        state.lobby.party.owner_id = Some(7);
        assert!(plan(&start("tmm2v2"), &state).is_ok(), "the leader may");
        assert!(
            plan(&start("ladder1v1"), &state).is_err(),
            "a party of two in 1v1"
        );

        let mut state = ready();
        state.lobby.join = JoinState::InGame;
        assert!(plan(&start("ladder1v1"), &state).is_err(), "in a game");
    }

    #[test]
    fn stopping_leaves_the_queues_that_are_running() {
        let mut state = ready();
        state.lobby.matchmaking = MatchmakingState::Searching {
            queue_names: vec!["ladder1v1".into(), "tmm2v2".into()],
        };
        let all = plan(&RemoteCommand::StopSearch { queues: None }, &state).unwrap();
        assert_eq!(all.len(), 2);
        let one = plan(
            &RemoteCommand::StopSearch {
                queues: Some(vec!["tmm2v2".into()]),
            },
            &state,
        )
        .unwrap();
        assert_eq!(
            one,
            vec![AppCommand::from(LobbyCommand::Matchmake {
                queue_name: "tmm2v2".into(),
                start: false
            })]
        );
        let idle = ready();
        assert_eq!(
            plan(&RemoteCommand::StopSearch { queues: None }, &idle).unwrap(),
            Vec::new()
        );
    }

    #[test]
    fn a_join_needs_an_open_lobby_and_its_password() {
        let state = ready();
        assert!(plan(
            &RemoteCommand::JoinGame {
                game_id: 12,
                password: None
            },
            &state
        )
        .is_err());
        let mut locked = ready();
        locked.lobby.games[0].password_protected = true;
        assert!(plan(
            &RemoteCommand::JoinGame {
                game_id: 11,
                password: None
            },
            &locked
        )
        .is_err());
        assert_eq!(
            plan(
                &RemoteCommand::JoinGame {
                    game_id: 11,
                    password: Some("pw".into())
                },
                &locked
            )
            .unwrap(),
            vec![AppCommand::from(LobbyCommand::Join {
                id: 11,
                password: Some("pw".into()),
                replace_mods: false
            })]
        );
    }

    #[test]
    fn the_snapshot_lists_friends_online_first_with_their_games() {
        let mut state = ready();
        state.social.friends = vec!["Zed".into(), "Deli".into(), "Abe".into()];
        state.social.players = ["Zed", "Deli"]
            .iter()
            .map(|login| PlayerProfile {
                login: login.to_string(),
                ..PlayerProfile::default()
            })
            .collect();
        state.lobby.live_games = vec![game(20, "Ladder", &["Zed"])];
        let shown = snapshot(&state);
        let names: Vec<&str> = shown.friends.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["Deli", "Zed", "Abe"]);
        assert_eq!(
            shown.friends[0].game.as_ref().map(|g| g.status),
            Some("lobby")
        );
        assert_eq!(
            shown.friends[1].game.as_ref().map(|g| g.status),
            Some("playing")
        );
        assert!(!shown.friends[2].online);
        assert_eq!(shown.lobby, "connected");
        assert_eq!(shown.matchmaking.status, "idle");
        assert_eq!(shown.queues.len(), 2);
        assert_eq!(shown.queues[0].pops_at, None);
    }

    #[test]
    fn the_wire_shapes_are_the_web_clients() {
        let state = ready();
        let text = encode(&Outbound::State {
            state: snapshot(&state),
        });
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["type"], "state");
        assert_eq!(value["state"]["player"]["name"], "Nuggets");
        assert_eq!(value["state"]["queues"][0]["teamSize"], 1);
        assert_eq!(value["state"]["matchmaking"]["status"], "idle");

        let games = encode(&Outbound::Games {
            games: games(&state),
        });
        let value: Value = serde_json::from_str(&games).unwrap();
        assert_eq!(value["games"][0]["mod"], "faf");
        assert_eq!(value["games"][0]["maxPlayers"], 8);
        assert_eq!(value["games"][0]["teams"]["1"][0], "Deli");

        let hello = hello("secret".into(), "FAF Rust client".into());
        assert!(
            !format!("{hello:?}").contains("secret"),
            "the token stays out of logs"
        );
        let value: Value = serde_json::from_str(&encode(&hello)).unwrap();
        assert_eq!(value["type"], "hello");
        assert_eq!(value["role"], "pc");
        assert!(
            value.get("device").is_none(),
            "nothing about the computer is sent"
        );
        assert_eq!(value["token"], "secret");

        assert_eq!(
            decode(r#"{"type":"welcome","version":1,"browsers":2}"#),
            Some(Inbound::Welcome { browsers: 2 })
        );
        assert_eq!(
            decode(r#"{"type":"command","id":"c1","command":{"action":"refresh"}}"#),
            Some(Inbound::Command {
                id: "c1".into(),
                command: json!({"action":"refresh"})
            })
        );
        assert_eq!(decode(r#"{"type":"somethingNew"}"#), Some(Inbound::Unknown));
        assert_eq!(decode("not json"), None);
    }

    #[test]
    fn a_game_id_is_read_however_javascript_wrote_it() {
        let join = |id: Value| RemoteCommand::parse(&json!({"action": "joinGame", "gameId": id}));
        assert_eq!(join(json!(42.0)), join(json!(42)));
        assert_eq!(join(json!(42.5)), None);
        assert_eq!(join(json!(2_147_483_648_i64)), None);
        assert_eq!(join(json!("42")), None);
    }

    #[test]
    fn a_request_has_one_wire_shape() {
        for value in [
            json!({"action": "startSearch", "queues": ["ladder1v1"]}),
            json!({"action": "stopSearch"}),
            json!({"action": "stopSearch", "queues": ["tmm2v2"]}),
            json!({"action": "joinGame", "gameId": 7}),
            json!({"action": "joinGame", "gameId": 7, "password": "pw"}),
            json!({"action": "refresh"}),
        ] {
            assert_eq!(RemoteCommand::parse(&value).unwrap().to_wire(), value);
        }
    }

    #[test]
    fn a_join_that_stops_at_the_pc_says_why_once() {
        let joining = JoinState::Joining {
            id: 11,
            prepared: false,
        };
        let stuck = JoinState::NeedsModReplacement {
            id: 11,
            conflicts: Vec::new(),
        };
        let reason = attention(&joining, &stuck).expect("the phone hears it");
        assert!(reason.contains("on your PC"), "{reason}");
        assert_eq!(attention(&stuck, &stuck), None, "said once");
        assert_eq!(attention(&joining, &JoinState::InGame), None);
        let failed = JoinState::Failed {
            id: 11,
            reason: "x".repeat(500),
        };
        assert!(attention(&joining, &failed).unwrap().chars().count() <= MAX_PROBLEM_CHARS);

        let mut state = ready();
        state.lobby.join = stuck;
        let game = snapshot(&state).game.unwrap();
        assert_eq!(game.status, "needsYou");
        assert_eq!(game.title, "Setons");
        assert!(game.problem.is_some());
    }

    #[test]
    fn a_match_found_carries_the_queues_title() {
        let state = ready();
        let event = match_found_event("tmm2v2".into(), &state);
        let value: Value = serde_json::from_str(&encode(&event)).unwrap();
        assert_eq!(value["event"], "matchFound");
        assert_eq!(value["title"], "2 vs 2");
        assert!(value.get("reason").is_none());
        assert_eq!(snapshot(&state).queues[0].title, "1 vs 1");
    }

    #[test]
    fn a_match_found_is_reported_once() {
        let searching = MatchmakingState::Searching {
            queue_names: vec!["ladder1v1".into()],
        };
        let found = MatchmakingState::MatchFound {
            queue_name: "ladder1v1".into(),
        };
        assert_eq!(match_found(&searching, &found), Some("ladder1v1".into()));
        assert_eq!(match_found(&found, &found), None);
        assert_eq!(match_found(&found, &MatchmakingState::Idle), None);
    }
}
