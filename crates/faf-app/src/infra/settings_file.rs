//! File-backed settings store: JSON in the OS config directory.
//!
//! The real [`SettingsPort`]. Resolves a per-app config directory via the
//! `directories` crate, so it needs no path injection from the shell and stays
//! free of any Tauri coupling. All IO is best-effort: a missing file yields
//! defaults, a damaged one yields everything in it that can still be read, and
//! write failures are swallowed (logged to the dev console).

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use faf_domain::state::SettingsState;
use serde_json::Value;

use crate::ports::SettingsPort;

/// How often a settings file that exists but cannot be opened is tried again
/// before the load gives up on it. A virus scanner or a sync client holding
/// the file for a moment is the case this is for.
const READ_ATTEMPTS: u32 = 3;
const READ_RETRY_DELAY: Duration = Duration::from_millis(250);

/// Persists settings to `<config-dir>/settings.json`.
pub struct FileSettings {
    path: PathBuf,
    /// Whether the file on disk may be replaced.
    ///
    /// Cleared when the last load found the file but could not open it. The
    /// session then runs on defaults, and the first save would have written
    /// those defaults over settings that were perfectly good and merely
    /// locked for a moment, which is one way a player restarts the client and
    /// finds everything reset. The file is left alone instead until a load
    /// reads it again.
    writable: AtomicBool,
}

impl FileSettings {
    /// Use the standard per-app config directory (e.g.
    /// `%APPDATA%/FAForever/FAForever Client` on Windows,
    /// `~/.config/FAForever Client` on Linux). Falls back to the current
    /// directory if no config dir can be resolved.
    pub fn faf() -> Self {
        Self::at(resolve_path())
    }

    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            writable: AtomicBool::new(true),
        }
    }
}

/// Same resolution [`FileSettings::faf`] uses, exposed standalone so the
/// shell can pre-read settings synchronously at startup (see
/// [`load_sync`]) before the async runtime: and therefore the [`SettingsPort`]
///: exists yet.
pub fn resolve_path() -> PathBuf {
    crate::infra::project_dirs()
        .map(|dirs| dirs.config_dir().join("settings.json"))
        .unwrap_or_else(|| PathBuf::from("settings.json"))
}

/// Blocking read of persisted settings, for use before the async runtime
/// starts. [`crate::infra::ports_from_env`] builds `GameConfig`/`ReplayConfig`
/// synchronously from env vars at startup, before `SettingsCommand::Load`
/// ever runs on the loop: so a persisted `game_path`/`replay_game_path`
/// needs to reach those env vars *before* that call, not through the normal
/// async [`SettingsPort::load`] path. Same defaults-on-missing-or-corrupt
/// posture as the async version.
pub fn load_sync(path: &std::path::Path) -> SettingsState {
    match std::fs::read(path) {
        Ok(bytes) => read_document(path, &bytes).normalized(),
        Err(_) => SettingsState::default(),
    }
}

/// The settings a file holds, as many of them as can still be read.
///
/// A document that parses is the whole answer. One that does not used to be
/// replaced by defaults for everything, and the load path saves soon after,
/// so a single value this client could not read (an option a newer build
/// wrote, a number that went out as `null`) cost the player every setting
/// they had, on disk as well as on screen. Now the file is copied aside first,
/// so nothing is lost for good, and every value that still fits is kept.
fn read_document(path: &Path, bytes: &[u8]) -> SettingsState {
    match parse(bytes) {
        Ok(settings) => settings,
        Err(error) => {
            let copy = keep_unreadable_copy(path, bytes);
            let (settings, dropped) = salvage(bytes);
            tracing::warn!(
                %error,
                ?dropped,
                copy = ?copy,
                "settings file partly unreadable; kept everything that could be read"
            );
            settings
        }
    }
}

/// Copy an unreadable settings file aside, beside the original.
///
/// Named after its content, so the startup read and the async load, which
/// both see the same broken file, keep one copy of it between them, while a
/// second and different failure later still gets a copy of its own.
fn keep_unreadable_copy(path: &Path, bytes: &[u8]) -> Option<PathBuf> {
    use std::hash::{Hash as _, Hasher as _};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    let copy =
        parent_directory(path).join(format!("settings.unreadable-{:016x}.json", hasher.finish()));
    if copy.exists() {
        return Some(copy);
    }
    match std::fs::write(&copy, bytes) {
        Ok(()) => Some(copy),
        Err(error) => {
            tracing::warn!(%error, path = %copy.display(), "could not keep a copy of the unreadable settings");
            None
        }
    }
}

/// Everything in a stored document that this client can read, on top of
/// defaults, and the JSON pointers of what it had to leave out.
///
/// Value by value: each stored value is tried in place of its default, and
/// kept if the whole state still parses with it. A group that does not fit as
/// a whole is taken apart and tried member by member, so an unknown value
/// three levels down costs that one value and not its section.
fn salvage(bytes: &[u8]) -> (SettingsState, Vec<String>) {
    let Ok(stored) = serde_json::from_slice::<Value>(bytes) else {
        return (SettingsState::default(), vec!["".into()]);
    };
    let Ok(mut accepted) = serde_json::to_value(SettingsState::default()) else {
        return (SettingsState::default(), vec!["".into()]);
    };
    let mut dropped = Vec::new();
    adopt(&mut accepted, "", &migrated(stored), &mut dropped);
    let settings = serde_json::from_value(accepted).unwrap_or_default();
    (settings, dropped)
}

fn adopt(accepted: &mut Value, pointer: &str, stored: &Value, dropped: &mut Vec<String>) {
    let Some(members) = stored.as_object() else {
        dropped.push(pointer.to_string());
        return;
    };
    for (key, value) in members {
        let child = format!("{pointer}/{}", key.replace('~', "~0").replace('/', "~1"));
        let mut candidate = accepted.clone();
        if let Some(Value::Object(parent)) = candidate.pointer_mut(pointer) {
            parent.insert(key.clone(), value.clone());
        }
        if serde_json::from_value::<SettingsState>(candidate.clone()).is_ok() {
            *accepted = candidate;
        } else if value.is_object() && accepted.pointer(&child).is_some_and(Value::is_object) {
            adopt(accepted, &child, value, dropped);
        } else {
            dropped.push(child);
        }
    }
}

/// Read a settings document, migrating renamed values on the way in.
///
/// The migration step is not a nicety. A value that fails to parse is only
/// salvaged around ([`read_document`]): the value itself is lost, and a
/// renamed start page is not a corrupt one, just an old one. Anything renamed
/// on the wire has to be translated here rather than left to fail.
fn parse(bytes: &[u8]) -> Result<SettingsState, serde_json::Error> {
    let document: serde_json::Value = serde_json::from_slice(bytes)?;
    serde_json::from_value(migrated(document))
}

/// Rewrite values whose spelling changed between client versions.
fn migrated(mut document: serde_json::Value) -> serde_json::Value {
    // Two tabs have been renamed so far. `Tab::Tutorials` became `Tab::Training`
    // when the tutorials tab grew into the training hub, and `Tab::Contribution`
    // became `Tab::Links` when the repository list grew into the link directory.
    // `general.startPage` is the one place a `Tab` is persisted, so this is the
    // whole of both renames' migration.
    if let Some(start_page) = document.pointer_mut("/general/startPage") {
        let renamed = match start_page.as_str() {
            Some("tutorials") => Some("training"),
            Some("contribution") => Some("links"),
            _ => None,
        };
        if let Some(name) = renamed {
            *start_page = serde_json::Value::String(name.into());
        }
    }
    document
}

#[async_trait]
impl SettingsPort for FileSettings {
    async fn load(&self) -> SettingsState {
        let mut attempt = 1;
        loop {
            match tokio::fs::read(&self.path).await {
                Ok(bytes) => {
                    self.writable.store(true, Ordering::SeqCst);
                    let path = self.path.clone();
                    return tokio::task::spawn_blocking(move || read_document(&path, &bytes))
                        .await
                        .unwrap_or_default();
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    self.writable.store(true, Ordering::SeqCst);
                    return SettingsState::default(); // first run: no file yet
                }
                Err(error) if attempt < READ_ATTEMPTS => {
                    tracing::debug!(%error, attempt, "settings file busy, trying again");
                    attempt += 1;
                    tokio::time::sleep(READ_RETRY_DELAY).await;
                }
                Err(error) => {
                    self.writable.store(false, Ordering::SeqCst);
                    tracing::warn!(
                        %error,
                        path = %self.path.display(),
                        "could not read settings; running on defaults and leaving the file alone"
                    );
                    return SettingsState::default();
                }
            }
        }
    }

    async fn save(&self, settings: &SettingsState) {
        if !self.writable.load(Ordering::SeqCst) {
            tracing::error!(
                path = %self.path.display(),
                "not saving settings over a file that could not be read at startup"
            );
            return;
        }
        let bytes = match serde_json::to_vec_pretty(settings) {
            Ok(bytes) => bytes,
            Err(error) => {
                tracing::error!(%error, "could not serialize settings");
                return;
            }
        };
        let parent = parent_directory(&self.path);
        if let Err(error) = tokio::fs::create_dir_all(parent).await {
            tracing::error!(%error, path = %parent.display(), "could not create settings directory");
            return;
        }

        let path = self.path.clone();
        match tokio::task::spawn_blocking(move || write_atomically(&path, &bytes)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::error!(%error, path = %self.path.display(), "could not write settings");
            }
            Err(error) => {
                tracing::error!(%error, "settings writer task failed");
            }
        }
    }
}

fn parent_directory(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

/// Write beside the destination, flush the complete JSON, then replace it in
/// one filesystem operation. `NamedTempFile::persist` provides the platform-
/// specific replacement semantics (including Windows) and removes the
/// temporary file if any earlier step fails.
fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut temporary = tempfile::NamedTempFile::new_in(parent_directory(path))?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map(|_| ())
        .map_err(|error| error.error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use faf_domain::state::Theme;

    #[tokio::test]
    async fn round_trips_through_a_file() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        let store = FileSettings::at(&path);

        // Missing file → defaults.
        assert_eq!(store.load().await, SettingsState::default());

        store
            .save(&SettingsState {
                theme: Theme::PythonClient,
                game_path: "C:/FA/bin/ForgedAlliance.exe".into(),
                replay_game_path: String::new(),
                ..SettingsState::default()
            })
            .await;
        let loaded = store.load().await;
        assert_eq!(loaded.theme, Theme::PythonClient);
        assert_eq!(loaded.game_path, "C:/FA/bin/ForgedAlliance.exe");
    }

    #[tokio::test]
    async fn a_start_page_saved_under_its_old_name_still_loads() {
        // The tutorials tab became the training hub. Without the migration the
        // whole document fails to parse and the player silently loses every
        // other setting in it, not just this one.
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            br#"{"theme":"pythonClient","general":{"startPage":"tutorials","autoLogin":false}}"#,
        )
        .expect("seed an older settings file");

        let loaded = FileSettings::at(&path).load().await;
        assert_eq!(loaded.general.start_page, faf_domain::state::Tab::Training);
        assert_eq!(
            loaded.theme,
            Theme::PythonClient,
            "and nothing else was lost"
        );
        assert!(!loaded.general.auto_login);

        assert_eq!(
            load_sync(&path).general.start_page,
            faf_domain::state::Tab::Training,
            "the startup path reads the same file"
        );
    }

    #[test]
    fn the_contribution_tab_is_read_as_the_link_directory() {
        // The second of the two renames, and the reason this is a `match` now:
        // somebody whose start page was the Contribution tab would otherwise
        // lose their theme, their game path and everything else in the file.
        let document =
            migrated(serde_json::from_str(r#"{"general":{"startPage":"contribution"}}"#).unwrap());
        let settings: SettingsState =
            serde_json::from_value(document).expect("an older document still parses");
        assert_eq!(settings.general.start_page, faf_domain::state::Tab::Links);
    }

    #[test]
    fn a_start_page_this_client_does_not_know_is_still_a_parse_failure() {
        // The migration translates what was renamed; it does not paper over
        // anything else, because a value nobody has ever written is a corrupt
        // file rather than an old one.
        let document =
            migrated(serde_json::from_str(r#"{"general":{"startPage":"somethingElse"}}"#).unwrap());
        assert!(serde_json::from_value::<SettingsState>(document).is_err());
    }

    fn unreadable_copies(dir: &Path) -> Vec<Vec<u8>> {
        std::fs::read_dir(dir)
            .expect("list the settings directory")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("settings.unreadable-")
            })
            .map(|entry| std::fs::read(entry.path()).expect("read the copy"))
            .collect()
    }

    /// The reported reset: a restart, and every setting back to its default.
    /// One value this client cannot read used to cost the whole file, and the
    /// load path saves soon after, so the loss reached the disk as well. Now
    /// it costs that value, even three levels down, and the file as it was
    /// is kept aside.
    #[tokio::test]
    async fn an_unreadable_value_costs_that_value_and_nothing_else() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        let stored = br#"{
            "theme": "pythonClient",
            "general": { "startPage": "somethingElse", "autoLogin": false },
            "mapGenerator": { "seed": "kept-seed", "generationType": "fromTheFuture" }
        }"#;
        std::fs::write(&path, stored).expect("seed a partly unreadable file");

        let loaded = FileSettings::at(&path).load().await;

        assert_eq!(loaded.theme, Theme::PythonClient);
        assert!(
            !loaded.general.auto_login,
            "the start page's neighbour survives"
        );
        assert_eq!(
            loaded.general.start_page,
            SettingsState::default().general.start_page
        );
        assert_eq!(loaded.map_generator.seed, "kept-seed");
        assert_eq!(unreadable_copies(dir.path()), vec![stored.to_vec()]);

        // The startup read sees the same file and keeps no second copy.
        assert_eq!(load_sync(&path).theme, Theme::PythonClient);
        assert_eq!(unreadable_copies(dir.path()).len(), 1);
    }

    #[tokio::test]
    async fn a_file_that_is_not_json_at_all_is_kept_aside() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"{\"theme\": \"pythonCl").expect("seed a truncated file");

        assert_eq!(
            FileSettings::at(&path).load().await,
            SettingsState::default()
        );
        assert_eq!(
            unreadable_copies(dir.path()),
            vec![b"{\"theme\": \"pythonCl".to_vec()]
        );
    }

    #[test]
    fn atomic_write_replaces_an_existing_file() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"old").expect("seed old settings");

        write_atomically(&path, b"new").expect("replace settings");

        assert_eq!(std::fs::read(path).expect("read settings"), b"new");
    }
}
