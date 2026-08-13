//! Collision-free Forged Alliance logs with bounded retention.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_GAME_LOGS: usize = 50;
static NEXT_LOG_ID: AtomicU64 = AtomicU64::new(1);

pub fn directory() -> Result<PathBuf, String> {
    Ok(super::cache_dir()?.join("game-logs"))
}

pub fn next_path(kind: &str, id: Option<i32>) -> Result<PathBuf, String> {
    let directory = directory()?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("could not create the game log directory: {error}"))?;
    prune(&directory, MAX_GAME_LOGS)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = NEXT_LOG_ID.fetch_add(1, Ordering::Relaxed);
    let id = id.map(|value| format!("-{value}")).unwrap_or_default();
    Ok(directory.join(format!("{kind}{id}-{stamp}-{sequence}.log")))
}

fn prune(directory: &Path, keep: usize) -> Result<(), String> {
    let mut logs: Vec<_> = std::fs::read_dir(directory)
        .map_err(|error| format!("could not read the game log directory: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "log"))
        .collect();
    logs.sort_by_key(|path| {
        path.metadata()
            .and_then(|metadata| metadata.modified())
            .unwrap_or(UNIX_EPOCH)
    });
    let remove = logs.len().saturating_sub(keep.saturating_sub(1));
    for path in logs.into_iter().take(remove) {
        std::fs::remove_file(&path)
            .map_err(|error| format!("could not prune an old game log: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retention_leaves_room_for_the_next_log() {
        let root = std::env::temp_dir().join(format!(
            "faf-log-retention-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        for index in 0..55 {
            std::fs::write(root.join(format!("game-{index}.log")), []).unwrap();
        }
        prune(&root, 50).unwrap();
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 49);
        std::fs::remove_dir_all(root).unwrap();
    }
}
