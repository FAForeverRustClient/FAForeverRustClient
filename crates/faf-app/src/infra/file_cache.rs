//! Bounded metadata cache. File stamps invalidate entries after local edits.
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

#[derive(Debug)]
struct Entries<T> {
    values: HashMap<PathBuf, (SystemTime, u64, T)>,
    order: VecDeque<PathBuf>,
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
        assert_eq!(cache.text(&path, parse).await.as_deref(), Some("first"));
        assert_eq!(cache.text(&path, parse).await.as_deref(), Some("first"));
        assert_eq!(PARSES.load(Ordering::Relaxed), 1);
        std::fs::write(&path, "changed contents").unwrap();
        assert_eq!(
            cache.text(&path, parse).await.as_deref(),
            Some("changed contents")
        );
        assert_eq!(PARSES.load(Ordering::Relaxed), 2);
        std::fs::remove_file(&path).unwrap();
        assert!(cache.text(&path, parse).await.is_none());
    }
}

#[derive(Debug)]
pub(super) struct FileCache<T> {
    entries: Mutex<Entries<T>>,
}

impl<T> Default for FileCache<T> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(Entries {
                values: HashMap::new(),
                order: VecDeque::new(),
            }),
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

    pub fn insert(&self, path: PathBuf, modified: SystemTime, size: u64, value: T) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !entries.values.contains_key(&path) {
            while entries.values.len() >= 4096 {
                if let Some(old) = entries.order.pop_front() {
                    entries.values.remove(&old);
                } else {
                    break;
                }
            }
            entries.order.push_back(path.clone());
        }
        entries.values.insert(path, (modified, size, value));
    }

    pub async fn text(&self, path: &Path, parse: fn(&str) -> T) -> Option<T> {
        let metadata = tokio::fs::metadata(path).await.ok()?;
        let modified = metadata.modified().ok()?;
        if let Some(known) = self.get(path, modified, metadata.len()) {
            return Some(known);
        }
        let text = tokio::fs::read_to_string(path).await.ok()?;
        let value = parse(&text);
        self.insert(path.to_owned(), modified, metadata.len(), value.clone());
        Some(value)
    }
}
