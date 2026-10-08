//! Settings port: persistence for user preferences.
//!
//! Abstracts *where* settings live (a file, in tests an in-memory fake). `load`
//! is best-effort: it returns defaults if nothing is stored or reading fails, so
//! a settings-store hiccup never crashes the app or blocks a command.
//!
//! `save` reports whether the document reached the store. Most callers only log
//! a failure, but one cannot: removing a notification sound may delete the file
//! only once no *saved* setting names it, and a write that silently failed used
//! to leave the saved preferences pointing at a file that was then deleted.

use async_trait::async_trait;
use faf_domain::state::SettingsState;

#[async_trait]
pub trait SettingsPort: Send + Sync {
    /// Load persisted settings, or defaults if none/unreadable.
    async fn load(&self) -> SettingsState;

    /// Persist the given settings. `Err` carries a reason fit for a log line or
    /// a notification; it never panics and never blocks on a retry.
    async fn save(&self, settings: &SettingsState) -> Result<(), String>;
}
