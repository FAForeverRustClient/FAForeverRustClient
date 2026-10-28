//! Disposable public source documents. Searches never persist their queries.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};

const BUDGET: u64 = 16 * 1024 * 1024;
const MAX_FILES: usize = 512;
const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

pub(super) struct DocumentCache {
    directory: Option<PathBuf>,
    writes: Arc<Mutex<()>>,
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
            let _guard = writes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            std::fs::create_dir_all(&directory)?;
            let path = directory.join(name);
            let mut files: Vec<_> = std::fs::read_dir(&directory)?
                .filter_map(Result::ok)
                .filter(|entry| is_document(&entry.path()) && entry.path() != path)
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
            let mut bytes =
                files.iter().map(|(_, bytes, _)| bytes).sum::<u64>() + source.len() as u64;
            let mut count = files.len() + 1;
            files.sort_by_key(|(modified, _, _)| *modified);
            for (_, size, oldest) in files {
                if bytes <= BUDGET && count <= MAX_FILES {
                    break;
                }
                std::fs::remove_file(oldest)?;
                bytes -= size;
                count -= 1;
            }
            let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
            temporary.write_all(source.as_bytes())?;
            temporary.persist(path).map_err(|error| error.error)?;
            Ok(())
        })
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
