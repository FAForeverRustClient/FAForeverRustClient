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

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

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
// For the map vault's install, which writes the same folders as the staging.
pub(super) use maps::{lease_map_folder, map_folder_in_any, unpack_map_leased};
pub use replay_version::{
    extract_game_version, extract_map_folder, resolve_and_stage_replay_version, ReplayVersionInfo,
};
pub use update::{clear_file_list_cache, ensure_game_version, ensure_latest_game_version};

/// What a live preparation stopped by its caller ends with.
///
/// Never shown: whoever called the work off does not read its outcome. An
/// error all the same rather than success, because the install is not ready,
/// and a caller that forgot to look at its own token must not start a game on
/// it.
const CALLED_OFF: &str = "the preparation was called off";

/// `work`, unless `called_off` is cancelled first. Only for work that has
/// written nothing that dropping it part-way could leave half done: a request,
/// a download into a temporary file, a read.
async fn unless_called_off<T>(
    called_off: &tokio_util::sync::CancellationToken,
    work: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::select! {
        result = work => result,
        () = called_off.cancelled() => Err(CALLED_OFF.to_string()),
    }
}

/// Run blocking file work (hashing, copying, renaming) on the blocking pool,
/// where a few hundred megabytes of disk I/O cannot stall the async runtime.
async fn off_runtime<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| format!("file task failed: {error}"))
}

/// Exclusive use of one install directory, for as long as anything is still
/// writing into it.
///
/// An install pass is a chain of awaits, and dropping it is how a replay
/// launch is called off. Work already handed to the blocking pool cannot be
/// dropped, though: a staging that was cancelled kept replacing files,
/// stamping the executable and writing `fa_path.lua` while the next launch
/// prepared the same directory beside it. So the lock is not held by the
/// async pass alone. Every blocking worker that writes into the install holds
/// a clone (see [`off_runtime_leased`]), and the directory is free again only
/// once the last of them has returned.
///
/// The same lease covers a map being extracted for a replay or a live game
/// (`maps::stage_map`), keyed by that map's own folder rather than the
/// install's, so a map and a game install only wait on each other when they
/// write into the same directory.
#[derive(Clone)]
pub(super) struct InstallLease {
    _held: Arc<tokio::sync::OwnedMutexGuard<()>>,
}

type InstallLocks = HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>;

/// One lock per directory written into, so a replay install and the game
/// install do not wait on each other. Keyed by [`lease_key`], so that every
/// spelling of one directory is the same lock.
static INSTALL_LOCKS: std::sync::Mutex<Option<InstallLocks>> = std::sync::Mutex::new(None);

/// Wait until nothing else is writing into `target_dir`, then hold it.
pub(super) async fn lease_install(target_dir: &Path) -> InstallLease {
    let key = lease_keys_off_runtime(vec![target_dir.to_path_buf()])
        .await
        .into_iter()
        .next()
        .unwrap_or_else(|| target_dir.to_path_buf());
    lease_keyed(key, target_dir).await
}

/// [`lease_install`] for several directories at once.
///
/// Taken in key order, so two passes leasing overlapping sets can never each
/// hold one the other is waiting for, and a directory named twice (two
/// spellings of it included) is leased once.
pub(super) async fn lease_dirs(dirs: impl IntoIterator<Item = PathBuf>) -> Vec<InstallLease> {
    let dirs: Vec<PathBuf> = dirs.into_iter().collect();
    let keys = lease_keys_off_runtime(dirs.clone()).await;
    let mut keyed: Vec<(PathBuf, PathBuf)> = keys.into_iter().zip(dirs).collect();
    keyed.sort_by(|a, b| a.0.cmp(&b.0));
    keyed.dedup_by(|a, b| a.0 == b.0);
    let mut leases = Vec::with_capacity(keyed.len());
    for (key, dir) in keyed {
        leases.push(lease_keyed(key, &dir).await);
    }
    leases
}

async fn lease_keyed(key: PathBuf, dir: &Path) -> InstallLease {
    let lock = {
        let mut locks = INSTALL_LOCKS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        locks
            .get_or_insert_with(HashMap::new)
            .entry(key)
            .or_default()
            .clone()
    };
    let guard = match lock.clone().try_lock_owned() {
        Ok(guard) => guard,
        Err(_) => {
            // The directory as the caller spelled it, which is what a test
            // watches; the key is only for the table.
            #[cfg(test)]
            test_support::probe::waiting_for_install(dir);
            #[cfg(not(test))]
            let _ = dir;
            lock.lock_owned().await
        }
    };
    InstallLease {
        _held: Arc::new(guard),
    }
}

/// [`lease_key`] for each of `dirs`, in order, worked out on the blocking pool.
///
/// Resolving a key asks the file system (`canonicalize`, once per ancestor
/// for a directory not created yet), and on a slow or network drive that is a
/// wait the async runtime's workers must not sit through. Should the pool be
/// gone, which happens only while the runtime shuts down, the keys are worked
/// out in place rather than not at all: a lease taken under another key than
/// its directory's would be no lease.
async fn lease_keys_off_runtime(dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    let asked = dirs.clone();
    match off_runtime(move || asked.iter().map(|dir| lease_key(dir)).collect()).await {
        Ok(keys) => keys,
        Err(_) => dirs.iter().map(|dir| lease_key(dir)).collect(),
    }
}

/// The lock key for `dir`, the same for every spelling of one directory.
///
/// Callers name a directory however they came by it: from settings, from an
/// environment variable, joined onto another path, with a trailing separator
/// or a `..` in it. Keyed as given, two spellings of one directory were two
/// locks, which is no lock at all.
///
/// The key is the canonical path when the directory exists. One that does not
/// exist yet (the first install into it) is the canonical path of its nearest
/// existing ancestor with the rest appended, so it keys the same before and
/// after it is created; the rest is resolved lexically, which can differ from
/// the file system only where a `..` follows a symbolic link that does not
/// exist yet. When not even an ancestor resolves, the lexical form is the key.
/// On Windows the file system ignores case, and so does the key, which also
/// never carries the `\\?\` prefix canonicalizing adds.
fn lease_key(dir: &Path) -> PathBuf {
    #[cfg(test)]
    test_support::probe::keyed(dir);
    let resolved = std::fs::canonicalize(dir).unwrap_or_else(|_| {
        let lexical = lexical_absolute(dir);
        lexical
            .ancestors()
            .find_map(|ancestor| {
                let canonical = std::fs::canonicalize(ancestor).ok()?;
                let rest = lexical.strip_prefix(ancestor).ok()?;
                Some(canonical.join(rest))
            })
            .unwrap_or(lexical)
    });
    platform_key(resolved)
}

/// `dir` made absolute against the working directory, with `.` and `..`
/// resolved by the text alone and separators made uniform.
fn lexical_absolute(dir: &Path) -> PathBuf {
    let absolute = std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(windows)]
fn platform_key(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    let plain = if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{share}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text.into_owned()
    };
    PathBuf::from(plain.to_lowercase())
}

#[cfg(not(windows))]
fn platform_key(path: PathBuf) -> PathBuf {
    path
}

/// The write probe, for a writer of a leased folder outside this module (the
/// map vault's uninstall), so a test can hold it part-way the way it holds a
/// staging.
#[cfg(test)]
pub(super) fn probe_writing(path: &Path) {
    test_support::probe::writing(path);
}

/// [`off_runtime`] for work that writes into a leased install. The worker
/// keeps the lease until it returns, even after the caller has stopped
/// waiting for it.
async fn off_runtime_leased<T: Send + 'static>(
    lease: &InstallLease,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let lease = lease.clone();
    off_runtime(move || {
        let _lease = lease;
        work()
    })
    .await
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

    /// The same directory under another name: a trailing separator, the other
    /// slash, a `.` or a `..` in it, and on Windows other letter case and the
    /// `\\?\` prefix. Each was a lock of its own, so an install named one way
    /// did not keep out a pass that named it another.
    fn spellings_of(dir: &Path) -> Vec<PathBuf> {
        let text = dir.display().to_string();
        let mut spellings = vec![
            PathBuf::from(format!("{text}{}", std::path::MAIN_SEPARATOR)),
            PathBuf::from(text.replace('\\', "/")),
            dir.join("."),
            dir.join("sub").join(".."),
            dir.join("not-there").join("..").join("."),
        ];
        if cfg!(windows) {
            spellings.push(PathBuf::from(text.to_uppercase()));
            spellings.push(PathBuf::from(text.to_lowercase()));
            spellings.push(PathBuf::from(format!(r"\\?\{text}")));
        }
        spellings
    }

    #[test]
    fn every_spelling_of_an_existing_directory_is_one_lease_key() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("ReplayData");
        std::fs::create_dir_all(dir.join("sub")).unwrap();

        let key = lease_key(&dir);
        for spelling in spellings_of(&dir) {
            assert_eq!(lease_key(&spelling), key, "{}", spelling.display());
        }
        if cfg!(windows) {
            assert!(
                !key.to_string_lossy().starts_with(r"\\?\"),
                "{}",
                key.display()
            );
        }
        // A relative spelling resolves against the working directory.
        assert_eq!(
            lease_key(Path::new(".")),
            lease_key(&std::env::current_dir().unwrap())
        );
    }

    #[test]
    fn a_directory_not_created_yet_keys_the_same_before_and_after() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("New").join("Install");

        let before = lease_key(&dir);
        for spelling in spellings_of(&dir) {
            assert_eq!(lease_key(&spelling), before, "{}", spelling.display());
        }
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(lease_key(&dir), before);
    }

    #[test]
    fn different_directories_are_different_lease_keys() {
        let temp = tempfile::tempdir().unwrap();
        let replay = temp.path().join("replaydata");
        let game = temp.path().join("gamedata");
        std::fs::create_dir_all(&replay).unwrap();

        assert_ne!(lease_key(&replay), lease_key(&game));
        assert_ne!(lease_key(&replay), lease_key(&replay.join("maps")));
        assert_ne!(lease_key(temp.path()), lease_key(&replay));
        assert_ne!(
            lease_key(&game.join("a")),
            lease_key(&game.join("b")),
            "two directories that do not exist yet"
        );
    }

    /// Working a key out asks the file system, once per ancestor for a
    /// directory not created yet, and a slow drive made that a stall on the
    /// thread driving the async runtime. It happens on the blocking pool.
    #[tokio::test]
    async fn lease_keys_are_worked_out_off_the_async_runtime() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("replaydata");
        test_support::probe::watch_keying(&dir);
        // A current-thread runtime: everything async in this test runs here.
        let runtime_thread = std::thread::current().id();

        drop(lease_install(&dir).await);
        drop(lease_dirs([dir.join("maps").join("a.v0001"), dir.join("vault")]).await);

        let threads = test_support::probe::keyed_on(&dir);
        assert_eq!(threads.len(), 3, "one key per directory leased");
        assert!(
            threads.iter().all(|thread| *thread != runtime_thread),
            "a lease key was worked out on the async runtime's own thread"
        );
    }

    /// Through the lock itself: an install held under one spelling keeps a
    /// pass naming it another way waiting until it is let go.
    #[tokio::test]
    async fn an_install_held_under_one_spelling_keeps_out_another() {
        use std::time::Duration;

        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("replaydata");
        std::fs::create_dir_all(&dir).unwrap();
        let held = lease_install(&dir).await;

        for spelling in spellings_of(&dir) {
            let waiting = tokio::time::timeout(Duration::from_millis(50), lease_install(&spelling));
            assert!(
                waiting.await.is_err(),
                "{} was leased while {} was held",
                spelling.display(),
                dir.display()
            );
        }

        drop(held);
        let other = PathBuf::from(format!("{}{}", dir.display(), std::path::MAIN_SEPARATOR));
        tokio::time::timeout(Duration::from_secs(5), lease_install(&other))
            .await
            .expect("the install is free once the first lease is let go");
    }
}
