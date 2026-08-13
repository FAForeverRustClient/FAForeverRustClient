//! Port traits — the external boundaries of the application.
//!
//! Each external system becomes a trait here, implemented in [`crate::infra`]
//! and mocked in tests. Services depend on these traits, never on concrete IO.
//! See ARCHITECTURE.md §5 for the full Port table.

pub mod auth;
pub mod chat;
pub mod ice;
pub mod leaderboard;
pub mod lobby;
pub mod maps;
pub mod mods;
pub mod process;
pub mod relay;
pub mod replay;
pub mod settings;

pub use auth::{AuthError, AuthPort, AuthResult};
pub use chat::{ChatPort, ChatUpdate};
pub use ice::{ConnectivitySession, IceParams, IcePort, RelayMsg};
pub use leaderboard::LeaderboardPort;
pub use lobby::{LobbyPort, LobbyUpdate};
pub use maps::MapsPort;
pub use mods::ModsPort;
pub use process::{GameLaunchParams, ProcessPort};
pub use relay::{RelayChannels, RelayPort};
pub use replay::ReplayPort;
pub use settings::SettingsPort;

use std::sync::Arc;

/// The bundle of ports injected into every service via [`crate::ServiceCtx`].
///
/// Cheap to clone (everything behind `Arc`). Grows one field per external system.
#[derive(Clone)]
pub struct Ports {
    pub auth: Arc<dyn AuthPort>,
    pub chat: Arc<dyn ChatPort>,
    pub lobby: Arc<dyn LobbyPort>,
    pub settings: Arc<dyn SettingsPort>,
    /// Connectivity + launch ports. Inert fakes unless real launch is enabled
    /// (`FAF_REAL_LAUNCH=1`), so tests and the offline path are unaffected. The
    /// GPGNet relay server is now an internal detail of the Go adapter backend,
    /// so it is no longer a top-level port.
    pub ice: Arc<dyn IcePort>,
    pub process: Arc<dyn ProcessPort>,
    pub replay: Arc<dyn ReplayPort>,
    pub maps: Arc<dyn MapsPort>,
    pub mods: Arc<dyn ModsPort>,
    pub leaderboard: Arc<dyn LeaderboardPort>,
}
