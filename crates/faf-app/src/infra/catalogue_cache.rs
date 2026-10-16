//! Disposable, bounded and atomically replaced lookup catalogue snapshots.
use crate::ports::catalogue::CachedCatalogue;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

const SCHEMA: u32 = 1;
// Preserve descriptions and links, while bounding a corrupt/compressed-bomb cache.
const MAX_COMPRESSED_BYTES: u64 = 32 * 1024 * 1024;
const MAX_JSON_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored<T> {
    schema: u32,
    api_base: String,
    #[serde(flatten)]
    catalogue: CachedCatalogue<T>,
}

fn path(name: &str) -> Result<PathBuf, String> {
    Ok(super::cache_dir()?
        .join("catalogue")
        .join(format!("{name}.json.zst")))
}

fn discard(path: &Path) {
    if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(kind = ?error.kind(), "could not discard an unusable catalogue cache");
        }
    }
}

fn read_at<T: DeserializeOwned>(path: &Path, api_base: &str) -> Option<CachedCatalogue<T>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(kind = ?error.kind(), "could not read catalogue cache metadata");
            }
            return None;
        }
    };
    // A file that cannot be opened is not unusable, only busy (an antivirus
    // scan, another instance): it is left for the next start, unlike a file
    // whose contents are broken, which is discarded below.
    let file = if metadata.is_file() {
        match std::fs::File::open(path) {
            Ok(file) => Some(file),
            Err(error) => {
                tracing::warn!(kind = ?error.kind(), "could not open the catalogue cache; left for the next start");
                return None;
            }
        }
    } else {
        None
    };
    let decoded = (|| {
        if metadata.len() > MAX_COMPRESSED_BYTES {
            return None;
        }
        let file = file?;
        let mut bytes = Vec::new();
        zstd::stream::read::Decoder::new(file)
            .ok()?
            .take(MAX_JSON_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > MAX_JSON_BYTES {
            return None;
        }
        let stored: Stored<T> = serde_json::from_slice(&bytes).ok()?;
        if stored.schema != SCHEMA
            || stored.api_base != api_base
            || chrono::DateTime::parse_from_rfc3339(&stored.catalogue.full_at).is_err()
            || chrono::DateTime::parse_from_rfc3339(&stored.catalogue.newest_change).is_err()
        {
            return None;
        }
        Some(stored.catalogue)
    })();
    if decoded.is_none() {
        tracing::warn!("discarding an unusable catalogue cache");
        discard(path);
    }
    decoded
}

fn write_at<T: Serialize>(
    path: &Path,
    api_base: &str,
    catalogue: CachedCatalogue<T>,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(&Stored {
        schema: SCHEMA,
        api_base: api_base.to_owned(),
        catalogue,
    })
    .map_err(|_| "could not serialize catalogue cache".to_string())?;
    if bytes.len() as u64 > MAX_JSON_BYTES {
        return Err("catalogue cache is too large".into());
    }
    let compressed = zstd::stream::encode_all(bytes.as_slice(), 3)
        .map_err(|_| "could not compress catalogue cache".to_string())?;
    if compressed.len() as u64 > MAX_COMPRESSED_BYTES {
        return Err("compressed catalogue cache is too large".into());
    }
    std::fs::create_dir_all(path.parent().ok_or("catalogue cache has no parent")?).map_err(
        |error| {
            format!(
                "could not create catalogue cache directory: {:?}",
                error.kind()
            )
        },
    )?;
    super::settings_file::write_atomically(path, &compressed)
        .map_err(|error| format!("could not replace catalogue cache: {:?}", error.kind()))
}

pub(crate) async fn read<T: DeserializeOwned + Send + 'static>(
    name: &str,
    api_base: &str,
) -> Option<CachedCatalogue<T>> {
    let path = path(name).ok()?;
    let api_base = api_base.to_owned();
    tokio::task::spawn_blocking(move || read_at(&path, &api_base))
        .await
        .ok()
        .flatten()
}

pub(crate) async fn write<T: Serialize + Send + 'static>(
    name: &str,
    api_base: &str,
    catalogue: CachedCatalogue<T>,
) -> Result<(), String> {
    let path = path(name)?;
    let api_base = api_base.to_owned();
    tokio::task::spawn_blocking(move || write_at(&path, &api_base, catalogue))
        .await
        .map_err(|_| "catalogue cache writer stopped".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalogue_cache_round_trip_and_invalid_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("maps.json.zst");
        let catalogue = CachedCatalogue {
            full_at: "2026-10-16T12:00:00Z".into(),
            newest_change: "2026-10-16T11:00:00Z".into(),
            entries: vec!["description", "https://example.invalid/download"],
        };
        write_at(&path, "https://api.example.invalid", catalogue.clone()).unwrap();
        assert_eq!(
            read_at::<String>(&path, "https://api.example.invalid"),
            Some(CachedCatalogue {
                entries: catalogue.entries.iter().map(|s| s.to_string()).collect(),
                full_at: catalogue.full_at.clone(),
                newest_change: catalogue.newest_change.clone()
            })
        );
        assert!(read_at::<String>(&path, "https://other.invalid").is_none());
        assert!(!path.exists());
        write_at(&path, "https://api.example.invalid", catalogue.clone()).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        std::fs::write(&path, &bytes[..bytes.len() / 2]).unwrap();
        assert!(read_at::<String>(&path, "https://api.example.invalid").is_none());
        assert!(!path.exists());
        let obsolete = serde_json::json!({"schema":99,"apiBase":"https://api.example.invalid","fullAt":catalogue.full_at,"newestChange":catalogue.newest_change,"entries":[]});
        std::fs::write(
            &path,
            zstd::stream::encode_all(serde_json::to_vec(&obsolete).unwrap().as_slice(), 3).unwrap(),
        )
        .unwrap();
        assert!(read_at::<String>(&path, "https://api.example.invalid").is_none());
        assert!(!path.exists());
        std::fs::write(&path, b"broken").unwrap();
        assert!(read_at::<String>(&path, "https://api.example.invalid").is_none());
    }
}
