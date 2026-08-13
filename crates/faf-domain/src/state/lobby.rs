//! Lobby slice — the list of open games, updated as the server pushes changes.
//!
//! This slice is the first to be driven by a *stream* of server events rather than
//! request/response: the lobby service subscribes to a [`Game`] feed and emits a
//! `GamesUpdated` event each time it changes. The reducer just stores the snapshot.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

/// Who can see/join a hosted game. Wire values on `game_info`/`game_host` are
/// lowercase (`public`/`friends`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum GameVisibility {
    #[default]
    Public,
    Friends,
}

/// An open game in the lobby.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub id: i32,
    pub title: String,
    pub host: String,
    pub players: i32,
    pub max_players: i32,
    pub map: String,
    /// The featured mod (e.g. `faf`). Needed to build a replay's `/init`
    /// argument when watching this game live. Wire key on `game_info` is
    /// `featured_mod`, unrelated to `GameLaunch`'s `mod`.
    pub mod_name: String,
    pub visibility: GameVisibility,
    pub password_protected: bool,
    /// e.g. `custom`, `coop`, `matchmaker` — the server's `game_type`.
    pub game_type: String,
    /// Display names of enabled sim mods (server sends `{uid: name}`; only the
    /// names are needed to render the tile/detail panel).
    pub sim_mods: Vec<String>,
    pub rating_type: String,
    pub rating_min: Option<i32>,
    pub rating_max: Option<i32>,
    pub enforce_rating_range: bool,
    /// Team number (as sent by the server, e.g. `"1"`, `"2"`, `"-1"` for no
    /// team/FFA) → player logins.
    pub teams: BTreeMap<String, Vec<String>>,
}

/// The server's `game_launch` order — everything the connectivity + launch chain
/// (a later phase) needs to actually start the game. For now we only model and
/// surface it; nothing acts on it yet. Mirrors the relevant fields of the Python
/// client's `GameLaunchCommand` (`src/protocol/lobbyprotocol.py`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GameLaunch {
    pub uid: i32,
    /// The featured mod (e.g. `faf`). Wire key is `mod`, a Rust keyword.
    #[serde(rename = "mod")]
    pub mod_name: String,
    pub name: String,
    pub mapname: String,
    pub game_type: String,
    pub rating_type: String,
    /// Raw launch args from the server (the FA command line is built from these
    /// plus client-side player info in the launch phase).
    pub args: Vec<String>,
}

/// What the UI sends to host a new game. Mirrors the fields the server's
/// `game_host` command reads (`lobbyconnection.py::command_game_host`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HostGameRequest {
    pub title: String,
    pub mapname: String,
    /// The featured mod / gamemode (e.g. `faf`, `fafbeta`, `fafdevelop`, `nomads`).
    pub featured_mod: String,
    pub password: Option<String>,
    pub visibility: GameVisibility,
    pub rating_min: Option<i32>,
    pub rating_max: Option<i32>,
    pub enforce_rating_range: bool,
    /// UIDs of the sim/UI mods to enable.
    pub sim_mods: Vec<String>,
}

/// A player's rating, as last reported by the server's `player_info` stream.
/// Kept as a flat cache (login → rating) rather than a full social/friends
/// slice — just enough to derive a game's average rating from its `teams`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerRating {
    pub login: String,
    pub rating: i32,
}

/// Where a host attempt stands. Distinct from [`JoinState`]: hosting and
/// joining are different flows (the Host dialog needs its own success/failure
/// signal to know when to close), even though both end with the game launching.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum HostState {
    #[default]
    Idle,
    Hosting,
    Hosted {
        id: i32,
    },
    Failed {
        reason: String,
    },
}

/// Where a join attempt stands. Distinct from [`LobbyStatus`] (the connection):
/// you can be `Connected` and `Idle`, or `Connected` and `Joining`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum JoinState {
    #[default]
    Idle,
    Joining {
        id: i32,
    },
    /// The server sent `game_launch`; the launch order is modeled. If real launch
    /// is enabled, the connectivity chain (ICE adapter + relay + game process)
    /// starts next, moving to [`Self::InGame`].
    Launched {
        launch: GameLaunch,
    },
    /// The ICE adapter and game process were started; relay traffic is flowing.
    InGame,
    /// The server rejected the join (game not ready, host left, bad password).
    Failed {
        id: i32,
        reason: String,
    },
    /// The local launch chain failed (adapter/relay/game couldn't start).
    LaunchFailed {
        reason: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LobbyStatus {
    #[default]
    Disconnected,
    Connecting,
    Connected,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LobbyState {
    pub status: LobbyStatus,
    pub games: Vec<Game>,
    /// Games currently in progress — not joinable, but watchable via a live
    /// replay (see `faf-app`'s `ReplayPort::watch_live`).
    pub live_games: Vec<Game>,
    pub join: JoinState,
    pub host: HostState,
    /// Rating cache (login → rating), fed by the server's `player_info` stream.
    pub ratings: BTreeMap<String, i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum LobbyEvent {
    Connecting,
    Connected,
    GamesUpdated { games: Vec<Game> },
    LiveGamesUpdated { games: Vec<Game> },
    Joining { id: i32 },
    Launching { launch: GameLaunch },
    JoinFailed { id: i32, reason: String },
    InGame,
    LaunchFailed { reason: String },
    Disconnected,
    Hosting,
    Hosted { id: i32 },
    HostFailed { reason: String },
    PlayerRatingsUpdated { ratings: Vec<PlayerRating> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum LobbyCommand {
    Connect,
    Join { id: i32 },
    Disconnect,
    Host { req: HostGameRequest },
}

pub fn reduce(state: &mut LobbyState, event: &LobbyEvent) {
    match event {
        LobbyEvent::Connecting => state.status = LobbyStatus::Connecting,
        LobbyEvent::Connected => state.status = LobbyStatus::Connected,
        LobbyEvent::GamesUpdated { games } => state.games = games.clone(),
        LobbyEvent::LiveGamesUpdated { games } => state.live_games = games.clone(),
        LobbyEvent::Joining { id } => state.join = JoinState::Joining { id: *id },
        LobbyEvent::Launching { launch } => {
            state.join = JoinState::Launched {
                launch: launch.clone(),
            }
        }
        LobbyEvent::JoinFailed { id, reason } => {
            state.join = JoinState::Failed {
                id: *id,
                reason: reason.clone(),
            }
        }
        LobbyEvent::InGame => state.join = JoinState::InGame,
        LobbyEvent::LaunchFailed { reason } => {
            state.join = JoinState::LaunchFailed {
                reason: reason.clone(),
            }
        }
        LobbyEvent::Disconnected => {
            state.status = LobbyStatus::Disconnected;
            state.games.clear();
            state.live_games.clear();
            state.join = JoinState::Idle;
            state.host = HostState::Idle;
            state.ratings.clear();
        }
        LobbyEvent::Hosting => state.host = HostState::Hosting,
        LobbyEvent::Hosted { id } => state.host = HostState::Hosted { id: *id },
        LobbyEvent::HostFailed { reason } => {
            state.host = HostState::Failed {
                reason: reason.clone(),
            }
        }
        LobbyEvent::PlayerRatingsUpdated { ratings } => {
            for r in ratings {
                state.ratings.insert(r.login.clone(), r.rating);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game(id: i32) -> Game {
        Game {
            id,
            title: format!("Game {id}"),
            host: "host".into(),
            players: 1,
            max_players: 8,
            map: "Seton's Clutch".into(),
            mod_name: "faf".into(),
            visibility: GameVisibility::Public,
            password_protected: false,
            game_type: "custom".into(),
            sim_mods: vec![],
            rating_type: "global".into(),
            rating_min: None,
            rating_max: None,
            enforce_rating_range: false,
            teams: BTreeMap::new(),
        }
    }

    #[test]
    fn games_updated_replaces_the_snapshot() {
        let mut s = LobbyState::default();
        reduce(
            &mut s,
            &LobbyEvent::GamesUpdated {
                games: vec![game(1), game(2)],
            },
        );
        assert_eq!(s.games.len(), 2);
        reduce(
            &mut s,
            &LobbyEvent::GamesUpdated {
                games: vec![game(3)],
            },
        );
        assert_eq!(s.games, vec![game(3)]);
    }

    #[test]
    fn disconnect_clears_games_and_join() {
        let mut s = LobbyState {
            status: LobbyStatus::Connected,
            games: vec![game(1)],
            live_games: vec![],
            join: JoinState::Joining { id: 1 },
            host: HostState::default(),
            ratings: BTreeMap::new(),
        };
        reduce(&mut s, &LobbyEvent::Disconnected);
        assert_eq!(s, LobbyState::default());
    }

    fn launch(uid: i32) -> GameLaunch {
        GameLaunch {
            uid,
            mod_name: "faf".into(),
            name: format!("Game {uid}"),
            mapname: "scmp_007".into(),
            game_type: "custom".into(),
            rating_type: "global".into(),
            args: vec!["/numgames".into(), "42".into()],
        }
    }

    #[test]
    fn join_flow_transitions_through_join_state() {
        let mut s = LobbyState::default();
        assert_eq!(s.join, JoinState::Idle);

        reduce(&mut s, &LobbyEvent::Joining { id: 7 });
        assert_eq!(s.join, JoinState::Joining { id: 7 });

        reduce(&mut s, &LobbyEvent::Launching { launch: launch(7) });
        assert_eq!(s.join, JoinState::Launched { launch: launch(7) });
    }

    #[test]
    fn launch_progresses_to_in_game() {
        let mut s = LobbyState::default();
        reduce(&mut s, &LobbyEvent::Launching { launch: launch(5) });
        reduce(&mut s, &LobbyEvent::InGame);
        assert_eq!(s.join, JoinState::InGame);
    }

    #[test]
    fn launch_failure_records_reason() {
        let mut s = LobbyState::default();
        reduce(&mut s, &LobbyEvent::Launching { launch: launch(5) });
        reduce(
            &mut s,
            &LobbyEvent::LaunchFailed {
                reason: "FAF_GAME_PATH is not set".into(),
            },
        );
        assert_eq!(
            s.join,
            JoinState::LaunchFailed {
                reason: "FAF_GAME_PATH is not set".into()
            }
        );
    }

    #[test]
    fn join_failed_records_reason() {
        let mut s = LobbyState::default();
        reduce(&mut s, &LobbyEvent::Joining { id: 3 });
        reduce(
            &mut s,
            &LobbyEvent::JoinFailed {
                id: 3,
                reason: "bad_password".into(),
            },
        );
        assert_eq!(
            s.join,
            JoinState::Failed {
                id: 3,
                reason: "bad_password".into()
            }
        );
    }

    #[test]
    fn host_flow_transitions_through_host_state() {
        let mut s = LobbyState::default();
        assert_eq!(s.host, HostState::Idle);

        reduce(&mut s, &LobbyEvent::Hosting);
        assert_eq!(s.host, HostState::Hosting);

        reduce(&mut s, &LobbyEvent::Hosted { id: 42 });
        assert_eq!(s.host, HostState::Hosted { id: 42 });
    }

    #[test]
    fn host_failure_records_reason() {
        let mut s = LobbyState::default();
        reduce(&mut s, &LobbyEvent::Hosting);
        reduce(
            &mut s,
            &LobbyEvent::HostFailed {
                reason: "invalid title".into(),
            },
        );
        assert_eq!(
            s.host,
            HostState::Failed {
                reason: "invalid title".into()
            }
        );
    }

    #[test]
    fn disconnect_resets_host_and_ratings() {
        let mut s = LobbyState::default();
        reduce(&mut s, &LobbyEvent::Hosting);
        reduce(
            &mut s,
            &LobbyEvent::PlayerRatingsUpdated {
                ratings: vec![PlayerRating {
                    login: "Stormlord".into(),
                    rating: 1500,
                }],
            },
        );
        reduce(&mut s, &LobbyEvent::Disconnected);
        assert_eq!(s, LobbyState::default());
    }

    #[test]
    fn player_ratings_updated_merges_into_cache() {
        let mut s = LobbyState::default();
        reduce(
            &mut s,
            &LobbyEvent::PlayerRatingsUpdated {
                ratings: vec![
                    PlayerRating {
                        login: "Alice".into(),
                        rating: 1200,
                    },
                    PlayerRating {
                        login: "Bob".into(),
                        rating: 1400,
                    },
                ],
            },
        );
        assert_eq!(s.ratings.get("Alice"), Some(&1200));
        assert_eq!(s.ratings.get("Bob"), Some(&1400));

        // A later update for Alice overwrites her rating, leaves Bob untouched.
        reduce(
            &mut s,
            &LobbyEvent::PlayerRatingsUpdated {
                ratings: vec![PlayerRating {
                    login: "Alice".into(),
                    rating: 1250,
                }],
            },
        );
        assert_eq!(s.ratings.get("Alice"), Some(&1250));
        assert_eq!(s.ratings.get("Bob"), Some(&1400));
    }
}
