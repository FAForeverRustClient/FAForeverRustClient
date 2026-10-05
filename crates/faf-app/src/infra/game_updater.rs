//! Game version updater: makes sure a specific engine build is on disk
//! before a replay is played back.
//!
//! Mirrors the Python client's `fa/check.py` + `fa/game_updater/*`: FA
//! refuses to load a replay whose embedded engine version doesn't match the
//! installed one (`"Ack! Unable to load game replay"`), so before *every*
//! replay launch the reference clients diff the local install against the
//! FAF API's file list for that exact `(featured_mod, version)` and update
//! whatever's stale. There is no binary diffing: just per-file MD5
//! comparison, a content-addressed cache, full-file downloads for anything
//! that doesn't match, a tiny 3-offset hex patch of the version number
//! baked into the executable, and a generated `fa_path.lua` FA's Lua
//! bootstrap reads to find everything. Scope: only the base featured-mod
//! types we ever see in replays (`faf`, `ladder1v1`, `fafbeta`,
//! `fafdevelop`): real total-conversion mods needing the base `faf` files
//! *plus* their own overlay is a documented gap, as are map/sim-mod
//! auto-download and per-file progress reporting (all Qt-signal plumbing in
//! the Python client, no architectural equivalent needed here).
//!
//! The work is split by responsibility into the submodules below, and this
//! file re-exports their public items so every caller keeps the path it
//! always had. What stays here is only what all of them lean on.
//!
//! - `update`: asking the API which files a release is made of, and bringing
//!   an install up to it (checksum pass, downloads, the file-list cache).
//! - `install`: finishing an install: the executable's version stamp, the
//!   retail game's libraries, and `fa_path.lua`.
//! - `replay_version`: which build a replay needs, and staging it from the
//!   cache when it is there.
//! - `cache`: the cache manifest and its upkeep (prune, expire, inspect,
//!   clear).
//! - `maps`: staging a map from the vault CDN for a replay or a live game.
//! - `content_store`: the content-addressed store underneath all of them.

use std::path::{Path, PathBuf};

mod cache;
mod content_store;
mod install;
mod maps;
mod replay_version;
#[cfg(test)]
mod test_support;
mod update;

pub use cache::{
    clean_expired_cache_files, clear_game_cache, inspect_game_cache, read_installed_build,
    CacheManifestEntry, CachedFileInfo,
};
pub use install::read_exe_version;
pub use maps::{ensure_live_map, ensure_map_available};
pub use replay_version::{
    extract_game_version, extract_map_folder, resolve_and_stage_replay_version, ReplayVersionInfo,
};
pub use update::{clear_file_list_cache, ensure_game_version, ensure_latest_game_version};

/// Run blocking file work (hashing, copying, renaming) on the blocking pool,
/// where a few hundred megabytes of disk I/O cannot stall the async runtime.
async fn off_runtime<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| format!("file task failed: {error}"))
}

fn safe_join_file(root: &Path, group: &str, name: &str) -> Result<PathBuf, String> {
    let safe_relative = |value: &str| {
        if value.contains('\\') || value.contains(':') {
            return false;
        }
        let mut components = Path::new(value).components();
        let has_component = components
            .next()
            .is_some_and(|part| matches!(part, std::path::Component::Normal(_)));
        has_component && components.all(|part| matches!(part, std::path::Component::Normal(_)))
    };
    if !safe_relative(group) || !safe_relative(name) {
        return Err("the API returned a file path outside the game directory".into());
    }
    Ok(root.join(group).join(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn featured_mod_files_cannot_escape_the_install_root() {
        let root = Path::new("game");
        assert_eq!(
            safe_join_file(root, "gamedata", "units.nx2").unwrap(),
            root.join("gamedata").join("units.nx2")
        );
        for (group, name) in [
            ("..", "escape"),
            ("bin", "../escape"),
            ("/absolute", "escape"),
            ("bin", "C:\\escape"),
        ] {
            assert!(safe_join_file(root, group, name).is_err());
        }
    }
}
