//! Where the client's file lookups resolve to.
//!
//! Not an external system this port talks to, which makes it the odd one out
//! here. It exists because this is configuration that has to reach code with
//! no port of its own: the map, mod and replay directories are resolved deep
//! inside several adapters and by free functions those adapters share. The
//! alternative would be a service reaching into `crate::infra` directly, which
//! the architecture forbids for a good reason.

use faf_domain::state::{PathPreferences, ResolvedPaths};

pub trait PathsPort: Send + Sync {
    /// Apply the user's configured overrides.
    ///
    /// Called on startup and again on every change, so a directory chosen in a
    /// previous session is honoured from the first lookup rather than the
    /// second. An empty field falls back to the matching `FAF_*` environment
    /// variable and then to discovery, exactly as before this was settable.
    fn set_overrides(&self, preferences: PathPreferences);

    /// Where those locations point once the overrides, the environment and
    /// discovery have all had their say.
    ///
    /// The settings tab shows this beside each field: a path nobody has set is
    /// the common case, and "(automatic)" on its own tells a user nothing
    /// about where their maps actually are.
    fn resolved(&self) -> ResolvedPaths;
}
