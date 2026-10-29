//! Bounded metadata cache. File stamps invalidate entries after local edits.
//!
//! Bounded twice: by entries, and, for what [`FileCache::text`] parses, by the
//! bytes of the files those entries were parsed from. A parse keeps at most
//! what its file held (`metadata_file` caps the fields it keeps well below
//! that), so the byte budget bounds what the cache holds even when every
//! entry comes from a file at the read limit, while a real collection, whose
//! files are a few kilobytes each, never reaches it.
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// The most entries kept.
const MAX_ENTRIES: usize = 4096;

/// The most bytes of parsed files the entries may stand for. A real
/// `_scenario.lua` or `mod_info.lua` is a few kilobytes, so a full cache of
/// real ones is a fraction of this; sixteen files at the read limit fill it.
const MAX_TEXT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug)]
struct Entries<T> {
    /// Stamp, size, value, and the bytes the value is counted as.
    values: HashMap<PathBuf, (SystemTime, u64, T, usize)>,
    order: VecDeque<PathBuf>,
    /// The sum of the counted bytes in `values`.
    text_bytes: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn performance_metadata_cache_reuses_reads_and_invalidates_changed_files() {
        static PARSES: AtomicUsize = AtomicUsize::new(0);
        fn parse(text: &str) -> String {
            PARSES.fetch_add(1, Ordering::Relaxed);
            text.to_owned()
        }
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("metadata.lua");
        std::fs::write(&path, "first").unwrap();
        let cache = FileCache::default();
        const MAX: u64 = 1024;
        assert_eq!(
            cache.text(&path, MAX, parse).await.as_deref(),
            Some("first")
        );
        assert_eq!(
            cache.text(&path, MAX, parse).await.as_deref(),
            Some("first")
        );
        assert_eq!(PARSES.load(Ordering::Relaxed), 1);
        std::fs::write(&path, "changed contents").unwrap();
        assert_eq!(
            cache.text(&path, MAX, parse).await.as_deref(),
            Some("changed contents")
        );
        assert_eq!(PARSES.load(Ordering::Relaxed), 2);
        std::fs::remove_file(&path).unwrap();
        assert!(cache.text(&path, MAX, parse).await.is_none());
    }

    /// Many files, each within the read limit, cannot add up past the byte
    /// budget: the oldest entries go first, and what fits stays cached.
    #[tokio::test]
    async fn metadata_cache_stays_within_its_byte_budget() {
        fn keep(text: &str) -> String {
            text.to_owned()
        }
        let folder = tempfile::tempdir().unwrap();
        let cache = FileCache::with_text_budget(10);
        let mut paths = Vec::new();
        for index in 0..4 {
            let path = folder.path().join(format!("{index}_scenario.lua"));
            std::fs::write(&path, "abcd").unwrap();
            assert_eq!(cache.text(&path, 1024, keep).await.as_deref(), Some("abcd"));
            paths.push(path);
        }

        let entries = cache.entries.lock().unwrap();
        assert_eq!(entries.text_bytes, 8, "two four-byte files fit in ten");
        assert_eq!(entries.values.len(), 2);
        assert!(entries.values.contains_key(&paths[2]));
        assert!(entries.values.contains_key(&paths[3]));
    }
}

#[derive(Debug)]
pub(super) struct FileCache<T> {
    entries: Mutex<Entries<T>>,
    text_budget: usize,
}

impl<T> Default for FileCache<T> {
    fn default() -> Self {
        Self::with_text_budget(MAX_TEXT_BYTES)
    }
}

impl<T> FileCache<T> {
    fn with_text_budget(text_budget: usize) -> Self {
        Self {
            entries: Mutex::new(Entries {
                values: HashMap::new(),
                order: VecDeque::new(),
                text_bytes: 0,
            }),
            text_budget,
        }
    }
}

impl<T: Clone> FileCache<T> {
    pub fn get(&self, path: &Path, modified: SystemTime, size: u64) -> Option<T> {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        entries
            .values
            .get(path)
            .filter(|entry| entry.0 == modified && entry.1 == size)
            .map(|entry| entry.2.clone())
    }

    /// Keep `value`, bounded by entries only. For values that were not parsed
    /// from a file's text, such as a replay's header.
    pub fn insert(&self, path: PathBuf, modified: SystemTime, size: u64, value: T) {
        self.insert_counted(path, modified, size, value, 0);
    }

    /// Keep `value`, counted as `text_bytes` against the byte budget.
    fn insert_counted(
        &self,
        path: PathBuf,
        modified: SystemTime,
        size: u64,
        value: T,
        text_bytes: usize,
    ) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(old) = entries
            .values
            .insert(path.clone(), (modified, size, value, text_bytes))
        {
            entries.text_bytes -= old.3;
        } else {
            entries.order.push_back(path.clone());
        }
        entries.text_bytes += text_bytes;
        // Oldest first, and never the entry just kept: one file within the
        // read limit is always smaller than the budget.
        while entries.values.len() > MAX_ENTRIES || entries.text_bytes > self.text_budget {
            if entries.values.len() <= 1 {
                break;
            }
            let Some(oldest) = entries.order.pop_front() else {
                break;
            };
            if oldest == path {
                // Refreshed just now, so it is the newest.
                entries.order.push_back(oldest);
                continue;
            }
            if let Some(evicted) = entries.values.remove(&oldest) {
                entries.text_bytes -= evicted.3;
            }
        }
    }

    /// `path` parsed, or `None` when it cannot be read. A file larger than
    /// `max_bytes` is one that cannot be read: it is refused before it is in
    /// memory ([`read_bounded_to_string_async`]), and said so once per scan.
    ///
    /// [`read_bounded_to_string_async`]: super::metadata_file::read_bounded_to_string_async
    pub async fn text(&self, path: &Path, max_bytes: u64, parse: fn(&str) -> T) -> Option<T> {
        let metadata = tokio::fs::metadata(path).await.ok()?;
        let modified = metadata.modified().ok()?;
        if let Some(known) = self.get(path, modified, metadata.len()) {
            return Some(known);
        }
        let text = match super::metadata_file::read_bounded_to_string_async(path, max_bytes).await {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::FileTooLarge => {
                tracing::warn!(?path, %error, "skipping an oversized metadata file");
                return None;
            }
            Err(_) => return None,
        };
        let value = parse(&text);
        self.insert_counted(
            path.to_owned(),
            modified,
            metadata.len(),
            value.clone(),
            text.len(),
        );
        Some(value)
    }
}
