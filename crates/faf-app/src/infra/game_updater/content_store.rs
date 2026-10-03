//! The game-file cache as an immutable, content-addressed store, kept apart
//! from the writable directories it feeds.
//!
//! Two kinds of directory meet in the updater, and they need opposite rules:
//!
//! - **The store** (`<cache>/<group>/<md5>`) holds each file under the MD5 of
//!   its contents. An entry is only ever created whole, written under a
//!   temporary name beside it and then renamed into place (what the Java
//!   client's `SimpleHttpFeaturedModUpdaterTask` does), and is never written
//!   again. Its name is a promise about its bytes, so an entry found to break
//!   that promise is deleted rather than used: a killed write or an outside
//!   edit must not reach the game merely because its filename looks like an
//!   MD5.
//! - **Installations** (the replay and live game directories, and the
//!   `versions` browsing view) are writable. Replay staging fills them with
//!   hard links to store entries, because a build is hundreds of megabytes and
//!   a link costs nothing. A hard link is the same file under a second name,
//!   though, so opening one for writing and truncating it rewrites the store
//!   entry as well, and the cache then serves the new bytes under the old
//!   checksum. Every write into an installation therefore replaces the
//!   directory entry (temporary file, then rename) instead, which leaves the
//!   file the old name pointed at untouched.
//!
//! The Python client avoids the question by moving files between cache and
//! install, so no file is ever in both. Links keep switching a replay between
//! builds cheap here, at the price of these rules.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use super::safe_join_file;

/// The store rooted at the game-file cache directory.
pub(super) struct ContentStore<'a> {
    root: &'a Path,
}

impl<'a> ContentStore<'a> {
    pub(super) fn new(root: &'a Path) -> Self {
        Self { root }
    }

    /// Where the entry for `md5` in `group` lives, whether or not it exists.
    ///
    /// A checksum that is not one is refused rather than joined into a path:
    /// the cache manifest that names entries is a file on disk, not something
    /// the API vouched for.
    pub(super) fn entry_path(&self, group: &str, md5: &str) -> Result<PathBuf, String> {
        if !is_md5(md5) {
            return Err(format!("'{md5}' is not a file checksum"));
        }
        safe_join_file(self.root, group, md5)
    }

    /// The entry for `md5`, if the store holds one whose contents still hash
    /// to that name.
    ///
    /// An entry that does not is deleted, so the caller fetches the file again
    /// instead of installing it. Hashing is skipped for an entry this process
    /// already verified and that has not been modified since (see
    /// [`VOUCHED`]): replay staging asks about every file of a build on every
    /// launch, and rereading a few hundred megabytes for each one is the cost
    /// that made the old code settle for checking existence.
    ///
    /// Blocking: call it off the async runtime.
    pub(super) fn verified(&self, group: &str, md5: &str) -> Result<Option<PathBuf>, String> {
        let path = self.entry_path(group, md5)?;
        let Ok(metadata) = std::fs::metadata(&path) else {
            return Ok(None);
        };
        if !metadata.is_file() {
            return Ok(None);
        }
        if is_vouched_for(&path, &metadata) {
            return Ok(Some(path));
        }
        match md5_of_file(&path) {
            Some(actual) if actual.eq_ignore_ascii_case(md5) => {
                vouch_for(&path, &metadata);
                Ok(Some(path))
            }
            Some(actual) => {
                tracing::warn!(
                    entry = %path.display(),
                    actual,
                    "a cached game file no longer matches its checksum; discarding it"
                );
                let _ = std::fs::remove_file(&path);
                Ok(None)
            }
            None => Ok(None),
        }
    }

    /// Add `source` to the store as the entry for `md5`, returning its path.
    ///
    /// The caller has already checked that `source` hashes to `md5`. The entry
    /// appears whole or not at all, so an interrupted insert can leave a stray
    /// temporary file but never a short entry under a real checksum.
    ///
    /// Blocking: call it off the async runtime.
    pub(super) fn insert(&self, group: &str, md5: &str, source: &Path) -> Result<PathBuf, String> {
        let path = self.entry_path(group, md5)?;
        replace_with_copy(source, &path)
            .map_err(|error| format!("could not write {} to the cache: {error}", path.display()))?;
        if let Ok(metadata) = std::fs::metadata(&path) {
            vouch_for(&path, &metadata);
        }
        Ok(path)
    }
}

fn is_md5(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// The MD5 of a file, read a block at a time, or `None` when it cannot be
/// read. Featured-mod files run to hundreds of megabytes, so they are never
/// held in memory whole.
///
/// Blocking: call it off the async runtime.
pub(super) fn md5_of_file(path: &Path) -> Option<String> {
    use std::io::Read as _;
    let mut file = std::fs::File::open(path).ok()?;
    let mut context = md5::Context::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        context.consume(&buffer[..read]);
    }
    Some(format!("{:x}", context.compute()))
}

fn hashes_to(path: &Path, md5: &str) -> bool {
    md5_of_file(path).is_some_and(|actual| actual.eq_ignore_ascii_case(md5))
}

/// The size and modification time an entry had when this process last hashed
/// it and found it intact.
type Stamp = (u64, SystemTime);

/// Store entries already verified in this process, keyed by path.
///
/// Any write to a file, through whichever of its names, moves its
/// modification time, so an entry whose stamp is unchanged still holds the
/// bytes that were hashed. Kept in memory only: a fresh process hashes each
/// entry once more, which bounds what an edit made with a forged timestamp can
/// get away with to a single session.
static VOUCHED: Mutex<Option<HashMap<PathBuf, Stamp>>> = Mutex::new(None);

fn stamp(metadata: &std::fs::Metadata) -> Option<Stamp> {
    Some((metadata.len(), metadata.modified().ok()?))
}

fn is_vouched_for(path: &Path, metadata: &std::fs::Metadata) -> bool {
    let Some(current) = stamp(metadata) else {
        return false;
    };
    VOUCHED.lock().is_ok_and(|guard| {
        guard
            .as_ref()
            .and_then(|map| map.get(path))
            .is_some_and(|known| *known == current)
    })
}

fn vouch_for(path: &Path, metadata: &std::fs::Metadata) {
    let Some(current) = stamp(metadata) else {
        return;
    };
    if let Ok(mut guard) = VOUCHED.lock() {
        guard
            .get_or_insert_with(HashMap::new)
            .insert(path.to_path_buf(), current);
    }
}

/// A temporary name beside a destination, removed again when dropped.
///
/// Beside it because a rename only replaces atomically within one directory
/// (one volume). After a successful [`Partial::commit`] the name no longer
/// exists and the removal is a harmless no-op; POSIX `rename` leaves the
/// source behind when both names already point at the same file, and the
/// removal is what cleans that up.
pub(super) struct Partial {
    path: PathBuf,
}

impl Partial {
    fn beside(dest: &Path) -> Self {
        let name = dest
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        Self {
            path: dest.with_file_name(format!(".{name}.{:016x}.partial", rand::random::<u64>())),
        }
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    /// Replace `dest` with this file: a new directory entry, never a write
    /// into whatever file `dest` named before.
    fn commit(self, dest: &Path) -> io::Result<()> {
        std::fs::rename(&self.path, dest)
    }
}

impl Drop for Partial {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn create_parent(dest: &Path) -> io::Result<()> {
    match dest.parent() {
        Some(parent) => std::fs::create_dir_all(parent),
        None => Ok(()),
    }
}

/// Make `dest` a copy of `src` by replacing it, never by writing into it.
///
/// What every write into an installation goes through: `dest` may be a hard
/// link to a store entry, and copying over it in place would rewrite that
/// entry under its old checksum.
///
/// Blocking: call it off the async runtime.
pub(super) fn replace_with_copy(src: &Path, dest: &Path) -> io::Result<()> {
    create_parent(dest)?;
    let partial = Partial::beside(dest);
    std::fs::copy(src, partial.path())?;
    partial.commit(dest)
}

/// Change `dest` by editing a private copy of it and putting that in its
/// place.
///
/// For the one file an installation modifies after placing it, the engine
/// executable. Editing it in place is only safe while nothing else shares it,
/// and a staged file may be a hard link to the store. The copy also means an
/// edit that fails halfway leaves the original intact.
///
/// Blocking: call it off the async runtime.
pub(super) fn rewrite(
    dest: &Path,
    edit: impl FnOnce(&mut std::fs::File) -> Result<(), String>,
) -> Result<(), String> {
    let partial = Partial::beside(dest);
    std::fs::copy(dest, partial.path())
        .map_err(|error| format!("could not copy {} to edit it: {error}", dest.display()))?;
    {
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(partial.path())
            .map_err(|error| format!("could not open a copy of {}: {error}", dest.display()))?;
        edit(&mut file)?;
        file.sync_all()
            .map_err(|error| format!("could not write {}: {error}", dest.display()))?;
    }
    partial
        .commit(dest)
        .map_err(|error| format!("could not replace {}: {error}", dest.display()))
}

/// Put the verified store entry `entry`, whose contents hash to `md5`, at
/// `dest` in an installation.
///
/// Always placed anew rather than skipped when something is already there:
/// whether `dest` is already this entry cannot be told from its size (two
/// builds' files can be the same length with different contents, which is how
/// a build switch used to leave the old build installed), and relinking costs
/// two metadata operations. The checksum is consulted only when that is not
/// possible: when replacing fails (Windows refuses to replace a file a running
/// game holds open) and when the filesystem has no hard links, so a file that
/// already holds the right bytes is not copied again.
///
/// Blocking: call it off the async runtime.
pub(super) fn link_into(entry: &Path, md5: &str, dest: &Path) -> io::Result<()> {
    create_parent(dest)?;
    let partial = Partial::beside(dest);
    if std::fs::hard_link(entry, partial.path()).is_ok() {
        return partial.commit(dest).or_else(|error| {
            if hashes_to(dest, md5) {
                Ok(())
            } else {
                Err(error)
            }
        });
    }
    drop(partial);
    // No hard links here (FAT, exFAT, or another volume). A symbolic link is
    // deliberately not the next resort: it leaves the installation broken
    // the moment the cache expires the entry.
    if hashes_to(dest, md5) {
        return Ok(());
    }
    replace_with_copy(entry, dest)
}

/// [`link_into`] for the `versions` browsing view, which nothing launches
/// from: when it has to fall back to copying, a file already there is left
/// as it is instead of being hashed on every cache inspection.
///
/// Blocking: call it off the async runtime.
pub(super) fn mirror_into(entry: &Path, dest: &Path) -> io::Result<()> {
    create_parent(dest)?;
    let partial = Partial::beside(dest);
    if std::fs::hard_link(entry, partial.path()).is_ok() {
        return partial.commit(dest);
    }
    drop(partial);
    if dest.is_file() {
        return Ok(());
    }
    replace_with_copy(entry, dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn md5_hex(bytes: &[u8]) -> String {
        format!("{:x}", md5::compute(bytes))
    }

    /// Writes `bytes` into the store under their own checksum.
    fn put(root: &Path, group: &str, bytes: &[u8]) -> (String, PathBuf) {
        let md5 = md5_hex(bytes);
        let path = root.join(group).join(&md5);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        (md5, path)
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".partial"))
            .collect()
    }

    #[test]
    fn a_damaged_entry_is_discarded_instead_of_returned() {
        let temp = tempfile::tempdir().unwrap();
        let store = ContentStore::new(temp.path());
        // Same length as what the name promises, different bytes: the case a
        // size check cannot see.
        let md5 = md5_hex(b"build 3837 units");
        let path = temp.path().join("gamedata").join(&md5);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"build 3838 units").unwrap();

        assert_eq!(store.verified("gamedata", &md5).unwrap(), None);
        assert!(
            !path.exists(),
            "a damaged entry is removed so it is fetched again"
        );
    }

    #[test]
    fn an_intact_entry_is_returned() {
        let temp = tempfile::tempdir().unwrap();
        let store = ContentStore::new(temp.path());
        let (md5, path) = put(temp.path(), "gamedata", b"units");
        assert_eq!(
            store.verified("gamedata", &md5).unwrap(),
            Some(path.clone())
        );
        // And again, from the record of the first check.
        assert_eq!(store.verified("gamedata", &md5).unwrap(), Some(path));
    }

    #[test]
    fn a_name_that_is_not_a_checksum_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let store = ContentStore::new(temp.path());
        assert!(store.entry_path("gamedata", "../../escape").is_err());
        assert!(store.entry_path("gamedata", "md5_exe_3837").is_err());
        assert!(store.entry_path("..", &md5_hex(b"x")).is_err());
    }

    #[test]
    fn inserting_writes_the_entry_whole_and_leaves_no_temporary_file() {
        let temp = tempfile::tempdir().unwrap();
        let store = ContentStore::new(temp.path());
        let source = temp.path().join("download");
        std::fs::write(&source, b"fresh download").unwrap();
        let md5 = md5_hex(b"fresh download");

        let entry = store.insert("bin", &md5, &source).unwrap();

        assert_eq!(std::fs::read(&entry).unwrap(), b"fresh download");
        assert!(leftovers(&temp.path().join("bin")).is_empty());
    }

    #[test]
    fn replacing_a_linked_file_leaves_the_entry_it_was_linked_to_alone() {
        let temp = tempfile::tempdir().unwrap();
        let (md5, entry) = put(temp.path(), "gamedata", b"old build");
        let dest = temp.path().join("install").join("gamedata").join("lua.nx2");
        link_into(&entry, &md5, &dest).unwrap();

        let newer = temp.path().join("newer");
        std::fs::write(&newer, b"new build").unwrap();
        replace_with_copy(&newer, &dest).unwrap();

        assert_eq!(std::fs::read(&dest).unwrap(), b"new build");
        assert_eq!(
            std::fs::read(&entry).unwrap(),
            b"old build",
            "the store entry keeps the bytes its name promises"
        );
    }

    #[test]
    fn rewriting_a_linked_file_leaves_the_entry_it_was_linked_to_alone() {
        let temp = tempfile::tempdir().unwrap();
        let (md5, entry) = put(temp.path(), "bin", b"0000 engine");
        let dest = temp.path().join("install").join("bin").join("engine");
        link_into(&entry, &md5, &dest).unwrap();

        rewrite(&dest, |file| {
            use std::io::Write as _;
            file.write_all(b"3838").map_err(|error| error.to_string())
        })
        .unwrap();

        assert_eq!(std::fs::read(&dest).unwrap(), b"3838 engine");
        assert_eq!(std::fs::read(&entry).unwrap(), b"0000 engine");
        assert!(leftovers(dest.parent().unwrap()).is_empty());
    }

    #[test]
    fn a_failed_rewrite_leaves_the_file_as_it_was() {
        let temp = tempfile::tempdir().unwrap();
        let dest = temp.path().join("engine");
        std::fs::write(&dest, b"original").unwrap();

        let error = rewrite(&dest, |_| Err("refused".into())).unwrap_err();

        assert_eq!(error, "refused");
        assert_eq!(std::fs::read(&dest).unwrap(), b"original");
        assert!(leftovers(temp.path()).is_empty());
    }

    #[test]
    fn linking_a_file_that_is_already_in_place_leaves_nothing_behind() {
        let temp = tempfile::tempdir().unwrap();
        let (md5, entry) = put(temp.path(), "gamedata", b"units");
        let dest = temp.path().join("install").join("units.nx2");

        link_into(&entry, &md5, &dest).unwrap();
        // The same file under both names: POSIX `rename` then does nothing
        // and would leave the temporary link behind.
        link_into(&entry, &md5, &dest).unwrap();

        assert_eq!(std::fs::read(&dest).unwrap(), b"units");
        assert!(leftovers(dest.parent().unwrap()).is_empty());
    }
}
