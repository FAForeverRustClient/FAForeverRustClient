//! Settings port: persistence for user preferences.
//!
//! Abstracts *where* settings live (a file, in tests an in-memory fake). `load`
//! is best-effort: it answers `None` if nothing is stored or nothing stored can
//! be read, and the caller runs on defaults, so a settings-store hiccup never
//! crashes the app or blocks a command.
//!
//! `None` rather than the defaults themselves, because "there were no settings"
//! is news of its own: it is how the startup load tells a fresh install from a
//! player who has run this client before, and a fresh install has no update
//! to announce (see `SettingsCommand::Load`).
//!
//! `save` reports whether the document reached the store. Most callers only log
//! a failure, but one cannot: removing a notification sound may delete the file
//! only once no *saved* setting names it, and a write that silently failed used
//! to leave the saved preferences pointing at a file that was then deleted.

use async_trait::async_trait;
use faf_domain::state::SettingsState;

#[async_trait]
pub trait SettingsPort: Send + Sync {
    /// Load persisted settings: `None` when none are stored, or when nothing
    /// in what is stored can be read, which leaves the caller on defaults
    /// either way. A document that is only partly readable is `Some`, with
    /// everything in it that could be read.
    async fn load(&self) -> Option<SettingsState>;

    /// Persist the given settings. `Err` carries a reason fit for a log line or
    /// a notification; it never panics and never blocks on a retry.
    async fn save(&self, settings: &SettingsState) -> Result<(), String>;
}
