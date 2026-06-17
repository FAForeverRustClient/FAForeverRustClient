//! Application state — the single source of truth.
//!
//! [`AppState`] is pure aggregation of independent slices. It has no behaviour
//! beyond holding slices; mutation happens only through [`crate::reduce`].
//! Add a feature by adding a slice module here (see ARCHITECTURE.md §8).

pub mod auth;
pub mod lobby;
pub mod nav;
pub mod session;
pub mod settings;

pub use auth::{AuthCommand, AuthEvent, AuthState, AuthStatus, Player};
pub use lobby::{
    Game, GameLaunch, JoinState, LobbyCommand, LobbyEvent, LobbyState, LobbyStatus,
};
pub use nav::{NavCommand, NavEvent, NavState, Tab};
pub use session::{ConnectionStatus, SessionCommand, SessionEvent, SessionState};
pub use settings::{SettingsCommand, SettingsEvent, SettingsState, Theme};

use serde::{Deserialize, Serialize};
use specta::Type;

/// The complete client state. One field per domain slice.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub session: SessionState,
    pub auth: AuthState,
    pub nav: NavState,
    pub lobby: LobbyState,
    pub settings: SettingsState,
}
