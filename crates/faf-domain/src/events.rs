//! [`AppEvent`] — the single delta type.
//!
//! This is a namespaced enum-of-enums (one variant per slice), never a flat enum.
//! The exact same value is reduced into [`crate::AppState`] **and** serialized to
//! the frontend, which guarantees backend and UI never disagree (ARCHITECTURE.md §3.2).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::state::{AuthEvent, LobbyEvent, NavEvent, SessionEvent, SettingsEvent};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "event")]
pub enum AppEvent {
    Session(SessionEvent),
    Auth(AuthEvent),
    Nav(NavEvent),
    Lobby(LobbyEvent),
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
