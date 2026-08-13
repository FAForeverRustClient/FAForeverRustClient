//! [`AppEvent`] — the single delta type.
//!
//! This is a namespaced enum-of-enums (one variant per slice), never a flat enum.
//! The exact same value is reduced into [`crate::AppState`] **and** serialized to
//! the frontend, which guarantees backend and UI never disagree (ARCHITECTURE.md §3.2).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::state::{
    AuthEvent, ChatEvent, LeaderboardEvent, LobbyEvent, MapsEvent, ModsEvent, NavEvent,
    ReplayEvent, SessionEvent, SettingsEvent,
};

// No `Eq`: `ReplayEvent` carries an `f32` (vault replay review score).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "event")]
pub enum AppEvent {
    Session(SessionEvent),
    Auth(AuthEvent),
    Nav(NavEvent),
    Chat(ChatEvent),
    Lobby(LobbyEvent),
    Replays(ReplayEvent),
    Maps(MapsEvent),
    Mods(ModsEvent),
    Leaderboard(LeaderboardEvent),
    Settings(SettingsEvent),
}

impl From<SessionEvent> for AppEvent {
    fn from(e: SessionEvent) -> Self {
        AppEvent::Session(e)
    }
}

impl From<AuthEvent> for AppEvent {
    fn from(e: AuthEvent) -> Self {
        AppEvent::Auth(e)
    }
}

impl From<NavEvent> for AppEvent {
    fn from(e: NavEvent) -> Self {
        AppEvent::Nav(e)
    }
}

impl From<ChatEvent> for AppEvent {
    fn from(e: ChatEvent) -> Self {
        AppEvent::Chat(e)
    }
}

impl From<LobbyEvent> for AppEvent {
    fn from(e: LobbyEvent) -> Self {
        AppEvent::Lobby(e)
    }
}

impl From<SettingsEvent> for AppEvent {
    fn from(e: SettingsEvent) -> Self {
        AppEvent::Settings(e)
    }
}

impl From<ReplayEvent> for AppEvent {
    fn from(e: ReplayEvent) -> Self {
        AppEvent::Replays(e)
    }
}

impl From<MapsEvent> for AppEvent {
    fn from(e: MapsEvent) -> Self {
        AppEvent::Maps(e)
    }
}

impl From<LeaderboardEvent> for AppEvent {
    fn from(e: LeaderboardEvent) -> Self {
        AppEvent::Leaderboard(e)
    }
}

impl From<ModsEvent> for AppEvent {
    fn from(e: ModsEvent) -> Self {
        AppEvent::Mods(e)
    }
}
