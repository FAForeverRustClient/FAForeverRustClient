//! Weekly copies of the game's `Game.prefs` (issue 750).
//!
//! The game rewrites the whole file when it exits, the client rewrites its
//! `active_mods` block on every mod toggle, and a crash or a bug in either
//! can leave it empty or wrong. Key bindings, the camera and every option of
//! the game live in it, so losing it costs a player an evening.
//!
//! So before a game starts, at most once a week, the file is copied into
//! `<data dir>/game-prefs-backups`, and only the newest [`KEEP`] copies are
//! kept. A copy is only made when the file differs from the newest one, so a
//! week with no change does not push a good copy out. The folder can be
//! opened from Settings, Paths ("game.prefs backups").
//!
//! Everything here is best effort: a backup that cannot be made is logged and
//! never stops a game from starting.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// How many copies are kept.
pub const KEEP: usize = 3;

/// How old the newest copy must be before another is made.
const INTERVAL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// What every copy's file name starts with; the rest is the date it was made.
const PREFIX: &str = "Game.prefs.";

/// The folder the copies are kept in.
pub fn backup_dir() -> Result<PathBuf, String> {
    Ok(super::data_dir()?.join("game-prefs-backups"))
}

/// Back up the game's prefs file if the last copy is a week old. Called
/// before every live and offline game; logs rather than fails.
pub fn backup_if_due() {
    let source = super::mods::game_prefs_path();
    let dir = match backup_dir() {
        Ok(dir) => dir,
        Err(error) => {
            tracing::warn!(%error, "no folder for game.prefs backups");
            return;
        }
    };
    match backup_into(&source, &dir, SystemTime::now()) {
        Ok(Some(copy)) => tracing::info!(?copy, "backed up game.prefs"),
        Ok(None) => {}
        Err(error) => tracing::warn!(%error, ?source, "could not back up game.prefs"),
    }
}

/// The copies in `dir`, oldest first, by the date in their name.
fn copies(dir: &Path) -> Vec<PathBuf> {
    let mut copies: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.is_file()
                        && path
                            .file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| name.starts_with(PREFIX))
                })
                .collect()
        })
        .unwrap_or_default();
    // The date in the name sorts as text, which survives a copy of the folder
    // that resets every modification time.
    copies.sort();
    copies
}

/// The name a copy made at `now` gets: `Game.prefs.2026-11-13_041233`, UTC.
fn copy_name(now: SystemTime) -> String {
    let at: chrono::DateTime<chrono::Utc> = now.into();
    format!("{PREFIX}{}", at.format("%Y-%m-%d_%H%M%S"))
}

/// The date a copy was made, read back from its name.
fn made_at(copy: &Path) -> Option<SystemTime> {
    let name = copy.file_name()?.to_str()?.strip_prefix(PREFIX)?;
    let at = chrono::NaiveDateTime::parse_from_str(name, "%Y-%m-%d_%H%M%S").ok()?;
    Some(at.and_utc().into())
}

/// The backup itself, with the source, the folder and the time passed in so
/// it can be tested. `Ok(Some(path))` is the copy that was made, `Ok(None)`
/// means none was due or needed.
fn backup_into(source: &Path, dir: &Path, now: SystemTime) -> Result<Option<PathBuf>, String> {
    let contents = match std::fs::read(source) {
        Ok(contents) => contents,
        // No game played yet on this machine: nothing to keep.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    // An empty file is exactly what a backup protects against, never what it
    // keeps.
    if contents.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }

    let existing = copies(dir);
    if let Some(newest) = existing.last() {
        let recent = made_at(newest)
            .and_then(|made| now.duration_since(made).ok())
            .is_some_and(|age| age < INTERVAL);
        if recent {
            return Ok(None);
        }
        // Unchanged since the last copy: another one would only push an
        // older, different copy out of the window.
        if std::fs::read(newest).is_ok_and(|previous| previous == contents) {
            return Ok(None);
        }
    }

    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let copy = dir.join(copy_name(now));
    // Written beside the target and renamed, so a crash halfway never leaves
    // a truncated copy that then counts as one of the three.
    let partial = dir.join(".partial");
    std::fs::write(&partial, &contents).map_err(|error| error.to_string())?;
    std::fs::rename(&partial, &copy).map_err(|error| error.to_string())?;

    let all = copies(dir);
    for old in all.iter().take(all.len().saturating_sub(KEEP)) {
        if let Err(error) = std::fs::remove_file(old) {
            tracing::warn!(%error, ?old, "could not remove an old game.prefs backup");
        }
    }
    Ok(Some(copy))
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: Duration = Duration::from_secs(24 * 60 * 60);

    fn at(days: u64) -> SystemTime {
        // 2026-11-01, a fixed day so the names are predictable.
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_793_491_200) + DAY * days as u32
    }

    fn names(dir: &Path) -> Vec<String> {
        copies(dir)
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn a_copy_is_made_once_a_week_and_only_three_are_kept() {
        let root = tempfile::tempdir().unwrap();
        let prefs = root.path().join("Game.prefs");
        let dir = root.path().join("backups");

        std::fs::write(&prefs, "profile = 1").unwrap();
        assert!(backup_into(&prefs, &dir, at(0)).unwrap().is_some());
        // Six days later: not due yet, however much changed.
        std::fs::write(&prefs, "profile = 2").unwrap();
        assert!(backup_into(&prefs, &dir, at(6)).unwrap().is_none());
        assert_eq!(names(&dir).len(), 1);

        for (week, contents) in [(1, "profile = 2"), (2, "profile = 3"), (3, "profile = 4")] {
            std::fs::write(&prefs, contents).unwrap();
            assert!(backup_into(&prefs, &dir, at(7 * week)).unwrap().is_some());
        }
        let kept = names(&dir);
        assert_eq!(kept.len(), KEEP);
        // The oldest went, and the newest holds the file as it is now.
        assert_eq!(kept[0], copy_name(at(7)));
        let newest = copies(&dir).pop().unwrap();
        assert_eq!(std::fs::read_to_string(newest).unwrap(), "profile = 4");
    }

    #[test]
    fn an_unchanged_file_keeps_the_older_copies() {
        let root = tempfile::tempdir().unwrap();
        let prefs = root.path().join("Game.prefs");
        let dir = root.path().join("backups");
        std::fs::write(&prefs, "good").unwrap();
        backup_into(&prefs, &dir, at(0)).unwrap();

        assert!(backup_into(&prefs, &dir, at(30)).unwrap().is_none());
        assert_eq!(names(&dir), vec![copy_name(at(0))]);
    }

    #[test]
    fn an_empty_or_missing_file_is_never_kept() {
        let root = tempfile::tempdir().unwrap();
        let prefs = root.path().join("Game.prefs");
        let dir = root.path().join("backups");

        assert!(backup_into(&prefs, &dir, at(0)).unwrap().is_none());
        std::fs::write(&prefs, "  \n").unwrap();
        assert!(backup_into(&prefs, &dir, at(0)).unwrap().is_none());
        assert!(!dir.exists());
    }

    #[test]
    fn the_date_survives_the_name() {
        assert_eq!(made_at(Path::new(&copy_name(at(3)))), Some(at(3)));
        assert_eq!(made_at(Path::new("Game.prefs.backup")), None);
    }
}
