//! Lobby slice — the list of open games, updated as the server pushes changes.
//!
//! This slice is the first to be driven by a *stream* of server events rather than
//! request/response: the lobby service subscribes to a [`Game`] feed and emits a
//! `GamesUpdated` event each time it changes. The reducer just stores the snapshot.

use serde::{Deserialize, Serialize};
use specta::Type;

/// An open game in the lobby.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub id: i32,
    pub title: String,
    pub host: String,
    pub players: i32,
    pub max_players: i32,
    pub map: String,
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum LobbyEvent {
    Connecting,
    Connected,
    GamesUpdated { games: Vec<Game> },
    Disconnected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum LobbyCommand {
    Connect,
    Disconnect,
}

pub fn reduce(state: &mut LobbyState, event: &LobbyEvent) {
    match event {
        LobbyEvent::Connecting => state.status = LobbyStatus::Connecting,
        LobbyEvent::Connected => state.status = LobbyStatus::Connected,
        LobbyEvent::GamesUpdated { games } => state.games = games.clone(),
        LobbyEvent::Disconnected => {
            state.status = LobbyStatus::Disconnected;
            state.games.clear();
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
    fn disconnect_clears_games() {
        let mut s = LobbyState {
            status: LobbyStatus::Connected,
            games: vec![game(1)],
        };
        reduce(&mut s, &LobbyEvent::Disconnected);
        assert_eq!(s, LobbyState::default());
    }
}
