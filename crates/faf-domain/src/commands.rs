//! [`AppCommand`] — intents flowing from the UI to the backend.
//!
//! Namespaced enum-of-enums, mirroring [`crate::AppEvent`]. A command is a
//! *request*; it never mutates state directly. A service handles it and emits
//! events, which are the only thing that changes state (ARCHITECTURE.md §3.4).

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::state::{AuthCommand, LobbyCommand, NavCommand, SessionCommand, SettingsCommand};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "command")]
pub enum AppCommand {
    Session(SessionCommand),
    Auth(AuthCommand),
    Nav(NavCommand),
    Lobby(LobbyCommand),
    Settings(SettingsCommand),
}

impl From<SessionCommand> for AppCommand {
    fn from(c: SessionCommand) -> Self {
        AppCommand::Session(c)
    }
}

impl From<AuthCommand> for AppCommand {
    fn from(c: AuthCommand) -> Self {
        AppCommand::Auth(c)
    }
}

impl From<NavCommand> for AppCommand {
    fn from(c: NavCommand) -> Self {
        AppCommand::Nav(c)
    }
}

impl From<LobbyCommand> for AppCommand {
    fn from(c: LobbyCommand) -> Self {
        AppCommand::Lobby(c)
    }
}

impl From<SettingsCommand> for AppCommand {
    fn from(c: SettingsCommand) -> Self {
        AppCommand::Settings(c)
    }
}
