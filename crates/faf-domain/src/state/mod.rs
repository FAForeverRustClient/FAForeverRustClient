//! Application state — the single source of truth.
//!
//! [`AppState`] is pure aggregation of independent slices. It has no behaviour
//! beyond holding slices; mutation happens only through [`crate::reduce`].
//! Add a feature by adding a slice module here (see ARCHITECTURE.md §8).

pub mod auth;
pub mod chat;
pub mod leaderboard;
pub mod lobby;
pub mod maps;
pub mod mods;
pub mod nav;
pub mod replays;
pub mod session;
pub mod settings;

pub use auth::{AuthCommand, AuthEvent, AuthState, AuthStatus, Player};
pub use chat::{
    ChatCommand, ChatEvent, ChatMessage, ChatState, ChatStatus, DEFAULT_CHANNEL,
};
pub use leaderboard::{
    League, LeaderboardCommand, LeaderboardEntry, LeaderboardEvent, LeaderboardState,
    LeaderboardStatus,
};
pub use lobby::{
    Game, GameLaunch, GameVisibility, HostGameRequest, HostState, JoinState, LobbyCommand,
    LobbyEvent, LobbyState, LobbyStatus, PlayerRating,
};
pub use maps::{
    InstalledMap, MapInstallStatus, MapListStatus, MapsCommand, MapsEvent, MapsState, VaultMap,
};
pub use mods::{
    InstalledMod, ModInstallStatus, ModListStatus, ModToggleStatus, ModType, ModsCommand,
    ModsEvent, ModsState, VaultMod,
};
pub use nav::{NavCommand, NavEvent, NavState, Tab};
pub use replays::{
    LiveReplayTarget, LocalReplay, ReplayCommand, ReplayEvent, ReplayPlayer, ReplayState,
    ReplayStatus, ReplayTeam, VaultReplay, VaultStatus,
};
pub use session::{ConnectionStatus, SessionCommand, SessionEvent, SessionState};
pub use settings::{SettingsCommand, SettingsEvent, SettingsState, Theme};

use serde::{Deserialize, Serialize};
use specta::Type;

/// The complete client state. One field per domain slice.
// No `Eq`: `ReplayState` carries an `f32` (vault replay review score).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub session: SessionState,
    pub auth: AuthState,
    pub nav: NavState,
    pub chat: ChatState,
    pub lobby: LobbyState,
    pub replays: ReplayState,
    pub maps: MapsState,
    pub mods: ModsState,
    pub leaderboard: LeaderboardState,
    pub settings: SettingsState,
}
