//! Settings port: persistence for user preferences.
//!
//! Abstracts *where* settings live (a file, in tests an in-memory fake). Both
//! operations are best-effort: `load` returns defaults if nothing is stored or
//! reading fails, and `save` silently no-ops on failure: a settings-store hiccup
//! must never crash the app or block a command.

use async_trait::async_trait;
use faf_domain::state::SettingsState;

#[async_trait]
pub trait SettingsPort: Send + Sync {
    /// Load persisted settings, or defaults if none/unreadable.
    async fn load(&self) -> SettingsState;

    /// Persist the given settings (best-effort).
    async fn save(&self, settings: &SettingsState);
}
