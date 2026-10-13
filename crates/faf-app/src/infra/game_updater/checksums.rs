//! What the checksum pass already knows about an install's files, kept across
//! restarts so that a file nobody has touched is not read again.
//!
//! Every game launch compares the install against the API's file list, and
//! for `faf` that list is 19 files and 739 MB, `env.nx2` alone 500 MB. Read
//! and hashed in full, that is two seconds on a fast disk with the files
//! already in memory and several more from a cold or spinning one, before
//! every game, for an install that has not changed since the last one. Both
//! reference clients pay it (Java's `SimpleHttpFeaturedModUpdaterTask`, the
//! Python client's `UpdaterWorker._calculate_md5s`), and it is the step a
//! player timing the three clients side by side saw this one lose on (#511).
//!
//! So the MD5 of each installed file is recorded together with the file's
//! size, modification time and creation time, and is reused for as long as
//! all three are what they were when it was read. A write through any name
//! of the file moves its modification time; a copy of another file into its
//! place brings that file's modification time and a creation time of its own.
//! Either way the file is read again. A check of three timestamps costs about
//! a millisecond for the whole list.
//!
//! What this gives up is noticing a change made with all three timestamps
//! forged back, which takes write access to the install and deliberate
//! effort. The pass is a version check, not a security boundary: anything
//! that can write the install can as well write the executable this client
//! starts, or this file. Downloads are still checked against the API's MD5
//! as they arrive, and "Clear game cache" in Settings deletes this file, after
//! which the next launch reads everything once more.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::content_store::md5_of_file;

/// The file's name, in the game-file cache directory beside the store.
pub(super) const FILE_NAME: &str = "install_checksums.json";

/// One file as it was when it was last read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Known {
    size: u64,
    /// Nanoseconds since the Unix epoch.
    modified: u64,
    /// The same, where the file system keeps a creation time.
    #[serde(default)]
    created: Option<u64>,
    md5: String,
}

impl Known {
    fn stamped(metadata: &std::fs::Metadata, md5: String) -> Option<Self> {
        let (size, modified, created) = stamp(metadata)?;
        Some(Self {
            size,
            modified,
            created,
            md5,
        })
    }

    fn still_describes(&self, metadata: &std::fs::Metadata) -> bool {
        stamp(metadata) == Some((self.size, self.modified, self.created))
    }
}

type Stamp = (u64, u64, Option<u64>);

fn stamp(metadata: &std::fs::Metadata) -> Option<Stamp> {
    if !metadata.is_file() {
        return None;
    }
    let nanos = |time: SystemTime| -> Option<u64> {
        u64::try_from(time.duration_since(UNIX_EPOCH).ok()?.as_nanos()).ok()
    };
    Some((
        metadata.len(),
        nanos(metadata.modified().ok()?)?,
        metadata.created().ok().and_then(nanos),
    ))
}

/// The record for one cache directory: installed path to what it held.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Memo {
    #[serde(default)]
    files: HashMap<String, Known>,
    #[serde(skip)]
    changed: bool,
}

/// Loaded once per cache directory and kept, keyed by that directory. Tests
/// each use a cache of their own, and so does a process that is pointed at
/// another one, so neither reads the other's record.
static MEMOS: Mutex<Option<HashMap<PathBuf, Memo>>> = Mutex::new(None);

fn with_memo<T>(cache_dir: &Path, work: impl FnOnce(&mut Memo) -> T) -> T {
    let mut guard = MEMOS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let memos = guard.get_or_insert_with(HashMap::new);
    let memo = memos
        .entry(cache_dir.to_path_buf())
        .or_insert_with(|| load(cache_dir));
    work(memo)
}

/// A record that cannot be read is no record: everything is hashed again and
/// the next save replaces it.
fn load(cache_dir: &Path) -> Memo {
    std::fs::read(cache_dir.join(FILE_NAME))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The MD5 of the installed file at `path`, read from the record when the
/// file has not changed since it was hashed, and hashed (and recorded)
/// otherwise. `None` when the file cannot be read, which the caller treats as
/// out of date.
///
/// Blocking: call it off the async runtime.
pub(super) fn installed_md5(cache_dir: &Path, path: &Path) -> Option<String> {
    let before = std::fs::metadata(path).ok()?;
    let known = with_memo(cache_dir, |memo| {
        memo.files
            .get(&key(path))
            .filter(|known| known.still_describes(&before))
            .map(|known| known.md5.clone())
    });
    if known.is_some() {
        return known;
    }

    let md5 = md5_of_file(path)?;
    // Recorded only when nothing wrote to the file while it was being read:
    // otherwise the checksum describes bytes that are no longer all there.
    if let Ok(after) = std::fs::metadata(path) {
        if stamp(&before) == stamp(&after) {
            remember(cache_dir, path, &after, &md5);
        }
    }
    Some(md5)
}

/// Record that the file just written to `path` holds the bytes whose MD5 is
/// `md5`: the updater put a verified copy there, so there is nothing to read.
///
/// Blocking: call it off the async runtime.
pub(super) fn record(cache_dir: &Path, path: &Path, md5: &str) {
    if let Ok(metadata) = std::fs::metadata(path) {
        remember(cache_dir, path, &metadata, md5);
    }
}

fn remember(cache_dir: &Path, path: &Path, metadata: &std::fs::Metadata, md5: &str) {
    let Some(known) = Known::stamped(metadata, md5.to_ascii_lowercase()) else {
        return;
    };
    with_memo(cache_dir, |memo| {
        if memo.files.get(&key(path)) != Some(&known) {
            memo.files.insert(key(path), known);
            memo.changed = true;
        }
    });
}

/// Write the record for `cache_dir` to disk, if anything in it changed.
///
/// Whole or not at all: written beside the record and renamed into place,
/// while the record is locked, so a second pass saving at the same moment
/// waits rather than interleaving. Failing to save costs only a slower next
/// launch, so it is logged and otherwise ignored.
///
/// Blocking: call it off the async runtime.
pub(super) fn save(cache_dir: &Path) {
    with_memo(cache_dir, |memo| {
        if !memo.changed {
            return;
        }
        let Ok(bytes) = serde_json::to_vec(&memo) else {
            return;
        };
        let path = cache_dir.join(FILE_NAME);
        let partial = cache_dir.join(format!("{FILE_NAME}.partial"));
        let written = std::fs::create_dir_all(cache_dir)
            .and_then(|()| std::fs::write(&partial, &bytes))
            .and_then(|()| std::fs::rename(&partial, &path));
        match written {
            Ok(()) => memo.changed = false,
            Err(error) => {
                let _ = std::fs::remove_file(&partial);
                tracing::warn!(%error, "could not save the install checksums");
            }
        }
    });
}

/// Forget everything recorded for `cache_dir`, for "Clear game cache": the
/// file goes with the directory's contents, and this is the copy in memory.
pub(super) fn forget(cache_dir: &Path) {
    let mut guard = MEMOS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(memos) = guard.as_mut() {
        memos.remove(cache_dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn md5_of(bytes: &[u8]) -> String {
        format!("{:x}", md5::compute(bytes))
    }

    /// Fresh from disk, as the next process would find it.
    fn reloaded(cache_dir: &Path) {
        forget(cache_dir);
    }

    #[test]
    fn an_unchanged_file_is_not_read_again_even_after_a_restart() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let file = temp.path().join("gamedata").join("units.nx2");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"units for 3839").unwrap();

        assert_eq!(
            installed_md5(&cache, &file),
            Some(md5_of(b"units for 3839"))
        );
        save(&cache);
        reloaded(&cache);

        // Other bytes of the same length, with the modification time put
        // back: exactly what the record cannot see, so an answer of the old
        // checksum proves the file was not read.
        let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
        {
            use std::io::Write as _;
            let mut handle = std::fs::OpenOptions::new().write(true).open(&file).unwrap();
            handle.write_all(b"forged by hand").unwrap();
            handle.set_modified(modified).unwrap();
        }
        assert_eq!(
            installed_md5(&cache, &file),
            Some(md5_of(b"units for 3839")),
            "the record from the last process answered"
        );
    }

    #[test]
    fn a_file_written_since_is_read_again() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let file = temp.path().join("lua.nx2");
        std::fs::write(&file, b"build 3838").unwrap();
        assert_eq!(installed_md5(&cache, &file), Some(md5_of(b"build 3838")));

        // Same length, so only the timestamps can tell.
        std::thread::sleep(std::time::Duration::from_millis(1_100));
        std::fs::write(&file, b"build 3839").unwrap();
        assert_eq!(
            installed_md5(&cache, &file),
            Some(md5_of(b"build 3839")),
            "a stale record must never answer for new bytes"
        );
    }

    #[test]
    fn a_file_put_in_place_by_copy_is_read_again() {
        // A copy keeps the source's modification time on Windows, so the
        // creation time, or failing that the size, is what gives it away.
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let file = temp.path().join("env.nx2");
        let other = temp.path().join("other.nx2");
        std::fs::write(&file, b"the current env").unwrap();
        std::fs::write(&other, b"an older env, longer").unwrap();
        assert!(installed_md5(&cache, &file).is_some());

        std::fs::remove_file(&file).unwrap();
        std::fs::copy(&other, &file).unwrap();
        assert_eq!(
            installed_md5(&cache, &file),
            Some(md5_of(b"an older env, longer"))
        );
    }

    #[test]
    fn a_recorded_write_needs_no_read() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let file = temp.path().join("bin").join("init_faf.lua");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"init").unwrap();

        // The updater says what it wrote; the record takes its word, in
        // lower case whatever the API sent.
        record(&cache, &file, &md5_of(b"init").to_uppercase());
        assert_eq!(installed_md5(&cache, &file), Some(md5_of(b"init")));
    }

    #[test]
    fn a_missing_file_has_no_checksum_and_a_broken_record_is_no_record() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join(FILE_NAME), b"{ not json").unwrap();
        assert_eq!(installed_md5(&cache, &temp.path().join("gone.nx2")), None);

        let file = temp.path().join("there.nx2");
        std::fs::write(&file, b"there").unwrap();
        assert_eq!(installed_md5(&cache, &file), Some(md5_of(b"there")));
        save(&cache);
        reloaded(&cache);
        assert_eq!(
            with_memo(&cache, |memo| memo.files.len()),
            1,
            "the broken record was replaced by a readable one"
        );
    }
}
