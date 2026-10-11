//! [`GameCachePort`] over the updater's content store, and an inert one for
//! tests and the offline shell.

use std::path::PathBuf;

use async_trait::async_trait;
use faf_domain::state::GameCacheInfo;

use crate::ports::GameCachePort;

/// The real cache: `game_files` under the client's cache directory.
pub struct DiskGameCache;

impl DiskGameCache {
    fn root() -> Option<PathBuf> {
        super::cache_dir().ok().map(|root| root.join("game_files"))
    }
}

#[async_trait]
impl GameCachePort for DiskGameCache {
    async fn expire(&self, lifetime_days: u32) {
        if let Some(root) = Self::root() {
            let _ = super::game_updater::clean_expired_cache_files(&root, lifetime_days).await;
        }
    }

    async fn clear(&self) {
        if let Some(root) = Self::root() {
            let _ = super::game_updater::clear_game_cache(&root).await;
        }
    }

    async fn inspect(&self, install_dirs: &[PathBuf]) -> Option<GameCacheInfo> {
        let root = Self::root()?;
        Some(super::game_updater::inspect_game_cache(&root, install_dirs).await)
    }
}

/// A cache that holds nothing and is never touched.
pub struct NoGameCache;

#[async_trait]
impl GameCachePort for NoGameCache {
    async fn expire(&self, _lifetime_days: u32) {}

    async fn clear(&self) {}

    async fn inspect(&self, _install_dirs: &[PathBuf]) -> Option<GameCacheInfo> {
        None
    }
}
