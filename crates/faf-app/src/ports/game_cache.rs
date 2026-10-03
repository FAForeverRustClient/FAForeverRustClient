//! The game-files cache, as the settings service sees it: how big it is,
//! dropping what has expired, and clearing it.
//!
//! A port rather than calls into the updater because the settings service used
//! to find the real cache itself. Settings load expires and measures it, so any
//! test that loaded settings reached into the cache on the machine running the
//! tests, and only a convention in the fake settings kept that from deleting
//! anything. Behind a port, a test gets an inert cache and cannot touch it.

use std::path::PathBuf;

use async_trait::async_trait;
use faf_domain::state::GameCacheInfo;

#[async_trait]
pub trait GameCachePort: Send + Sync {
    /// Delete cached files not used for `lifetime_days`. Best-effort.
    async fn expire(&self, lifetime_days: u32);

    /// Delete every cached file. Best-effort.
    async fn clear(&self);

    /// How large the cache is and what it holds, measured against the given
    /// installs. `None` when there is no cache directory to measure.
    async fn inspect(&self, install_dirs: &[PathBuf]) -> Option<GameCacheInfo>;
}
