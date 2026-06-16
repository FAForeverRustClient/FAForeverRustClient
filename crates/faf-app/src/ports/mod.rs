//! Port traits — the external boundaries of the application.
//!
//! Each external system becomes a trait here, implemented in [`crate::infra`]
//! and mocked in tests. Services depend on these traits, never on concrete IO.
//! See ARCHITECTURE.md §5 for the full Port table.

pub mod auth;
pub mod lobby;

pub use auth::{AuthError, AuthPort, AuthResult};
pub use lobby::LobbyPort;

use std::sync::Arc;

/// The bundle of ports injected into every service via [`crate::ServiceCtx`].
///
/// Cheap to clone (everything behind `Arc`). Grows one field per external system.
#[derive(Clone)]
pub struct Ports {
    pub auth: Arc<dyn AuthPort>,
    pub lobby: Arc<dyn LobbyPort>,
}
