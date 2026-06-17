//! Port traits — the external boundaries of the application.
//!
//! Each external system becomes a trait here, implemented in [`crate::infra`]
//! and mocked in tests. Services depend on these traits, never on concrete IO.
//! See ARCHITECTURE.md §5 for the full Port table.

pub mod auth;
pub mod ice;
pub mod lobby;
pub mod process;
pub mod relay;
pub mod settings;

pub use auth::{AuthError, AuthPort, AuthResult};
pub use ice::{ConnectivitySession, IceParams, IcePort, RelayMsg};
pub use lobby::{LobbyPort, LobbyUpdate};
pub use process::{GameLaunchParams, ProcessPort};
pub use relay::{RelayChannels, RelayPort};
pub use settings::SettingsPort;

use std::sync::Arc;

/// The bundle of ports injected into every service via [`crate::ServiceCtx`].
///
/// Cheap to clone (everything behind `Arc`). Grows one field per external system.
#[derive(Clone)]
pub struct Ports {
    pub auth: Arc<dyn AuthPort>,
    pub lobby: Arc<dyn LobbyPort>,
    pub settings: Arc<dyn SettingsPort>,
    /// Connectivity + launch ports. Inert fakes unless real launch is enabled
    /// (`FAF_REAL_LAUNCH=1`), so tests and the offline path are unaffected. The
    /// GPGNet relay server is now an internal detail of the Go adapter backend,
    /// so it is no longer a top-level port.
    pub ice: Arc<dyn IcePort>,
    pub process: Arc<dyn ProcessPort>,
}
