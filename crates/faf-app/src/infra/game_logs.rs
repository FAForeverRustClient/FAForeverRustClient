//! Collision-free Forged Alliance logs with bounded retention, and the
//! excerpt of one that a moderation report can carry.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use faf_domain::protocol::report_log::{build_excerpt, ReportLogSource};
use faf_domain::state::ReportLogExcerpt;

use crate::ports::GameLogsPort;

const MAX_GAME_LOGS: usize = 50;
static NEXT_LOG_ID: AtomicU64 = AtomicU64::new(1);

/// How much of a log the report excerpt reads, from its end. A long game's
/// log runs to a few megabytes; this takes all of one, and the end of a
/// pathological one, without holding an unbounded file in memory.
const MAX_EXCERPT_READ_BYTES: u64 = 32 * 1024 * 1024;

/// [`GameLogsPort`] over the real log folder.
pub struct DiskGameLogs;

#[async_trait]
impl GameLogsPort for DiskGameLogs {
    async fn report_excerpt(
        &self,
        game_id: Option<i32>,
    ) -> Result<Option<ReportLogExcerpt>, String> {
        let directory = directory()?;
        let names = private_names();
        // Reading and scanning a log of several megabytes is blocking work;
        // done here it would hold up whatever else the runtime thread runs.
        tokio::task::spawn_blocking(move || excerpt_from(&directory, game_id, &names))
            .await
            .map_err(|error| format!("could not read the game log: {error}"))?
    }
}

/// No logs at all: for tests and the offline port set, which must never read
/// a real log.
pub struct NoGameLogs;

#[async_trait]
impl GameLogsPort for NoGameLogs {
    async fn report_excerpt(
        &self,
        _game_id: Option<i32>,
    ) -> Result<Option<ReportLogExcerpt>, String> {
        Ok(None)
    }
}

fn excerpt_from(
    directory: &Path,
    game_id: Option<i32>,
    names: &[String],
) -> Result<Option<ReportLogExcerpt>, String> {
    let Some((path, log_game_id)) = pick_log(directory, game_id)? else {
        return Ok(None);
    };
    let content = read_tail(&path, MAX_EXCERPT_READ_BYTES)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("game.log");
    Ok(Some(build_excerpt(
        game_id,
        &ReportLogSource {
            file_name,
            log_game_id,
            content: &content,
        },
        names,
    )))
}

/// The names this machine and its user go by, for the excerpt to take out:
/// the account name, the profile folder's name (which can differ from it),
/// and the computer's name. Read here rather than in the service, which must
/// not read the environment.
fn private_names() -> Vec<String> {
    let mut names: Vec<String> = ["USERNAME", "USER", "LOGNAME", "COMPUTERNAME", "HOSTNAME"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .collect();
    if let Some(dirs) = directories::BaseDirs::new() {
        if let Some(folder) = dirs.home_dir().file_name().and_then(|name| name.to_str()) {
            names.push(folder.to_string());
        }
    }
    names.retain(|name| !name.trim().is_empty());
    names
}

/// The log of `game_id` when one is kept, else the newest online game's log,
/// with the game its name says it belongs to.
///
/// Only online games: replays and offline skirmishes write logs here too, but
/// nobody else was in those, so they are no evidence about another player.
fn pick_log(
    directory: &Path,
    game_id: Option<i32>,
) -> Result<Option<(PathBuf, Option<i32>)>, String> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        // No folder yet: no game has been started, which is not a failure.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not read the game log folder: {error}")),
    };
    let logs: Vec<(PathBuf, Option<i32>, SystemTime)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let log_game_id = online_game_id(path.file_name()?.to_str()?)?;
            let modified = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(UNIX_EPOCH);
            Some((path, log_game_id, modified))
        })
        .collect();
    let newest = |wanted: Option<i32>| {
        logs.iter()
            .filter(|(_, id, _)| wanted.is_none() || *id == wanted)
            .max_by_key(|(_, _, modified)| *modified)
            .map(|(path, id, _)| (path.clone(), *id))
    };
    Ok(game_id
        .and_then(|id| newest(Some(id)))
        .or_else(|| newest(None)))
}

/// The game id in an online game's log name, as [`next_path`] writes it
/// (`game-<id>-<stamp>-<sequence>.log`): `Some(Some(id))`, or `Some(None)` for
/// an online game log whose id could not be read. `None` for anything else in
/// the folder.
fn online_game_id(file_name: &str) -> Option<Option<i32>> {
    let rest = file_name.strip_suffix(".log")?.strip_prefix("game-")?;
    let parts: Vec<&str> = rest.split('-').collect();
    let numeric = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    match parts.as_slice() {
        [id, stamp, sequence] if numeric(id) && numeric(stamp) && numeric(sequence) => {
            Some(id.parse().ok())
        }
        [stamp, sequence] if numeric(stamp) && numeric(sequence) => Some(None),
        _ => None,
    }
}

/// At most the last `max` bytes of a file, decoded leniently. When the start
/// is cut, the partial line it was cut in is dropped too: half a line can
/// hold half a name, which the excerpt would no longer recognise.
fn read_tail(path: &Path, max: u64) -> Result<String, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("could not open the game log: {error}"))?;
    let length = file
        .metadata()
        .map_err(|error| format!("could not read the game log: {error}"))?
        .len();
    let cut = length > max;
    if cut {
        file.seek(SeekFrom::Start(length - max))
            .map_err(|error| format!("could not read the game log: {error}"))?;
    }
    let mut bytes = Vec::with_capacity(usize::try_from(length.min(max)).unwrap_or(0));
    file.take(max)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read the game log: {error}"))?;
    if cut {
        match bytes.iter().position(|&byte| byte == b'\n') {
            Some(newline) => {
                bytes.drain(..=newline);
            }
            None => bytes.clear(),
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

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

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "faf-report-logs-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// Write a log whose modification time is `seconds` after the epoch, so
    /// which one is newest does not depend on how fast the test runs.
    fn write_log(root: &Path, name: &str, content: &str, seconds: u64) {
        let path = root.join(name);
        std::fs::write(&path, content).unwrap();
        let file = std::fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(UNIX_EPOCH + std::time::Duration::from_secs(1_000_000 + seconds))
            .unwrap();
    }

    #[test]
    fn only_online_game_logs_are_read_for_a_report() {
        assert_eq!(online_game_id("game-42-1700-3.log"), Some(Some(42)));
        assert_eq!(online_game_id("game-1700-3.log"), Some(None));
        assert_eq!(online_game_id("replay-42-1700-3.log"), None);
        assert_eq!(online_game_id("live-replay-42-1700-3.log"), None);
        assert_eq!(online_game_id("offline-1700-3.log"), None);
        assert_eq!(online_game_id("game-42-1700-3.txt"), None);
        assert_eq!(online_game_id("game-abc-1700-3.log"), None);
    }

    #[test]
    fn the_reported_games_log_wins_over_a_newer_one() {
        let root = scratch("wanted");
        write_log(&root, "game-42-1-1.log", "info: game 42\n", 10);
        write_log(&root, "game-7-2-2.log", "info: game 7\n", 20);
        write_log(&root, "replay-42-3-3.log", "info: replay\n", 30);

        let (path, id) = pick_log(&root, Some(42)).unwrap().unwrap();
        assert_eq!(id, Some(42));
        assert!(path.ends_with("game-42-1-1.log"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn without_a_log_of_that_game_the_newest_online_game_is_taken() {
        let root = scratch("fallback");
        write_log(&root, "game-42-1-1.log", "info: game 42\n", 10);
        write_log(&root, "game-7-2-2.log", "info: game 7\n", 20);
        // Newer, but not an online game: never evidence about another player.
        write_log(&root, "offline-3-3.log", "info: skirmish\n", 30);
        write_log(&root, "live-replay-9-4-4.log", "info: watching\n", 40);

        let (path, id) = pick_log(&root, Some(99)).unwrap().unwrap();
        assert_eq!(id, Some(7));
        assert!(path.ends_with("game-7-2-2.log"));
        let (_, id) = pick_log(&root, None).unwrap().unwrap();
        assert_eq!(id, Some(7));

        let excerpt = excerpt_from(&root, Some(99), &[]).unwrap().unwrap();
        assert_eq!(excerpt.requested_game_id, Some(99));
        assert_eq!(excerpt.log_game_id, Some(7));
        assert!(excerpt.block.contains("info: game 7"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn no_online_game_log_is_nothing_to_attach_rather_than_a_failure() {
        let root = scratch("empty");
        write_log(&root, "replay-42-1-1.log", "info: replay\n", 10);
        assert_eq!(excerpt_from(&root, Some(42), &[]).unwrap(), None);
        assert_eq!(
            excerpt_from(&root.join("missing"), None, &[]).unwrap(),
            None
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_log_read_from_the_middle_starts_at_a_whole_line() {
        let root = scratch("tail");
        write_log(
            &root,
            "game-1-1-1.log",
            "first ExampleUser line\nsecond\nthird\n",
            10,
        );
        // The last 15 bytes start inside the first line, which is dropped.
        let content = read_tail(&root.join("game-1-1-1.log"), 15).unwrap();
        assert_eq!(content, "second\nthird\n");
        let whole = read_tail(&root.join("game-1-1-1.log"), 1_000).unwrap();
        assert!(whole.starts_with("first ExampleUser line"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
