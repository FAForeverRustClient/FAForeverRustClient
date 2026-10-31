//! Disposable public source documents. Searches never persist their queries.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use sha2::{Digest, Sha256};

const BUDGET: u64 = 16 * 1024 * 1024;
const MAX_FILES: usize = 512;
const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

pub(super) struct DocumentCache {
    directory: Option<PathBuf>,
    writes: Arc<Mutex<Option<CacheIndex>>>,
}

struct CacheIndex {
    files: Vec<(SystemTime, u64, PathBuf)>,
    modified: Option<SystemTime>,
    reconciled: Instant,
}

impl CacheIndex {
    fn scan(directory: &Path) -> std::io::Result<Self> {
        let files = std::fs::read_dir(directory)?
            .filter_map(Result::ok)
            .filter(|entry| is_document(&entry.path()))
            .filter_map(|entry| {
                entry
                    .metadata()
                    .ok()
                    .filter(|metadata| metadata.is_file())
                    .map(|metadata| {
                        (
                            metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                            metadata.len(),
                            entry.path(),
                        )
                    })
            })
            .collect();
        Ok(Self {
            files,
            modified: std::fs::metadata(directory)?.modified().ok(),
            reconciled: Instant::now(),
        })
    }

    fn store(&mut self, directory: &Path, path: PathBuf, source: &str) -> std::io::Result<()> {
        self.files.retain(|(_, _, known)| *known != path);
        let mut bytes =
            self.files.iter().map(|(_, size, _)| size).sum::<u64>() + source.len() as u64;
        if bytes > BUDGET || self.files.len() + 1 > MAX_FILES {
            self.files.sort_by_key(|(modified, _, _)| *modified);
            while bytes > BUDGET || self.files.len() + 1 > MAX_FILES {
                let (_, size, oldest) = self.files.remove(0);
                std::fs::remove_file(oldest)?;
                bytes -= size;
            }
        }
        let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
        temporary.write_all(source.as_bytes())?;
        temporary.persist(&path).map_err(|error| error.error)?;
        let metadata = std::fs::metadata(&path)?;
        self.files.push((
            metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            metadata.len(),
            path,
        ));
        self.modified = std::fs::metadata(directory)?.modified().ok();
        Ok(())
    }
}

fn filename(url: &str) -> String {
    format!("{:x}.txt", Sha256::digest(url.as_bytes()))
}

fn is_document(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.len() == 68
                && name.ends_with(".txt")
                && name.as_bytes()[..64].iter().all(u8::is_ascii_hexdigit)
        })
}

impl DocumentCache {
    pub(super) fn new(directory: Option<PathBuf>) -> Self {
        Self {
            directory,
            writes: Arc::default(),
        }
    }

    pub(super) async fn read(&self, url: &str) -> Option<String> {
        let path = self.directory.as_ref()?.join(filename(url));
        tokio::task::spawn_blocking(move || {
            let file = std::fs::File::open(path).ok()?;
            let metadata = file.metadata().ok()?;
            if metadata.len() > super::MAX_DOCUMENT_BYTES as u64
                || SystemTime::now()
                    .duration_since(metadata.modified().ok()?)
                    .ok()?
                    > MAX_AGE
            {
                return None;
            }
            let mut source = String::new();
            file.take(super::MAX_DOCUMENT_BYTES as u64 + 1)
                .read_to_string(&mut source)
                .ok()?;
            (source.len() <= super::MAX_DOCUMENT_BYTES).then_some(source)
        })
        .await
        .ok()
        .flatten()
    }

    pub(super) async fn remove(&self, url: &str) {
        if let Some(directory) = &self.directory {
            let _ = tokio::fs::remove_file(directory.join(filename(url))).await;
        }
    }

    pub(super) async fn store(&self, url: &str, source: &str) {
        let Some(directory) = self.directory.clone() else {
            return;
        };
        if source.len() > super::MAX_DOCUMENT_BYTES {
            return;
        }
        let name = filename(url);
        let source = source.to_owned();
        let writes = self.writes.clone();
        // Keep directory scans, eviction and atomic replacement off the runtime.
        // The guard remains held even if the caller cancels this short disk job.
        let _ = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            let mut index = writes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            std::fs::create_dir_all(&directory)?;
            let path = directory.join(name);
            let modified = std::fs::metadata(&directory)?.modified().ok();
            // Reconcile outside changes and periodically recheck accounting.
            // Our own atomic writes update the stamp kept by the index.
            if index.as_ref().is_none_or(|index| {
                modified.is_none()
                    || index.modified != modified
                    || index.reconciled.elapsed() >= Duration::from_secs(30)
            }) {
                *index = None;
                *index = Some(CacheIndex::scan(&directory)?);
            }
            let result = index
                .as_mut()
                .expect("cache was reconciled")
                .store(&directory, path, &source);
            if result.is_err() {
                *index = None;
            }
            result
        })
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn search_efficiency_document_writes_reuse_accounting_and_replace_sizes() {
        let folder = tempfile::tempdir().unwrap();
        let cache = DocumentCache::new(Some(folder.path().to_path_buf()));
        cache.store("https://example.invalid/one", "one").await;
        let reconciled = cache.writes.lock().unwrap().as_ref().unwrap().reconciled;
        cache.store("https://example.invalid/two", "second").await;
        {
            let held = cache.writes.lock().unwrap();
            let index = held.as_ref().unwrap();
            assert_eq!(
                index.reconciled, reconciled,
                "own writes must not scan the directory again"
            );
            assert_eq!(index.files.len(), 2);
        }
        cache
            .store("https://example.invalid/one", "replacement")
            .await;
        let held = cache.writes.lock().unwrap();
        let index = held.as_ref().unwrap();
        assert_eq!(index.files.len(), 2);
        assert_eq!(
            index.files.iter().map(|(_, bytes, _)| bytes).sum::<u64>(),
            17
        );
    }

    #[tokio::test]
    async fn search_efficiency_document_cache_reconciles_external_entries_before_eviction() {
        let folder = tempfile::tempdir().unwrap();
        let cache = DocumentCache::new(Some(folder.path().to_path_buf()));
        cache.store("https://example.invalid/one", "one").await;
        let external = folder
            .path()
            .join(filename("https://example.invalid/external"));
        let file = std::fs::File::create(&external).unwrap();
        file.set_len(BUDGET).unwrap();
        drop(file);
        // Force reconciliation independently of filesystem timestamp precision.
        cache.writes.lock().unwrap().as_mut().unwrap().modified = None;
        cache.store("https://example.invalid/two", "two").await;
        let bytes: u64 = std::fs::read_dir(folder.path())
            .unwrap()
            .map(|entry| entry.unwrap().metadata().unwrap().len())
            .sum();
        assert!(bytes <= BUDGET);
        assert_eq!(
            cache.read("https://example.invalid/two").await.as_deref(),
            Some("two")
        );
    }

    #[tokio::test]
    async fn public_document_cache_survives_restarts_and_is_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let cache = DocumentCache::new(Some(temp.path().to_path_buf()));
        let url = "https://example.invalid/3822.md";
        cache.store(url, "Original patch notes").await;
        let restarted = DocumentCache::new(Some(temp.path().to_path_buf()));
        assert_eq!(
            restarted.read(url).await.as_deref(),
            Some("Original patch notes")
        );
        assert!(restarted
            .read("https://example.invalid/other/3822.md")
            .await
            .is_none());
        let path = temp.path().join(filename(url));
        std::fs::write(&path, [0xff, 0xfe]).unwrap();
        assert!(
            restarted.read(url).await.is_none(),
            "invalid UTF-8 must be refetched"
        );
        std::fs::write(&path, b"stale").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::now() - MAX_AGE - Duration::from_secs(1))
            .unwrap();
        assert!(
            restarted.read(url).await.is_none(),
            "old sources must be refreshed"
        );
        for index in 0..5 {
            cache
                .store(
                    &format!("https://example.invalid/{index}"),
                    &"x".repeat(super::super::MAX_DOCUMENT_BYTES),
                )
                .await;
        }
        let bytes: u64 = std::fs::read_dir(temp.path())
            .unwrap()
            .map(|entry| entry.unwrap().metadata().unwrap().len())
            .sum();
        assert!(bytes <= BUDGET);
        assert!(!std::fs::read_dir(temp.path()).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".partial")));
    }
}
