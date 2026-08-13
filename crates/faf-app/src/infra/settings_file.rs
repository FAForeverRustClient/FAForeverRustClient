//! File-backed settings store: JSON in the OS config directory.
//!
//! The real [`SettingsPort`]. Resolves a per-app config directory via the
//! `directories` crate, so it needs no path injection from the shell and stays
//! free of any Tauri coupling. All IO is best-effort: a missing or corrupt file
//! yields defaults, and write failures are swallowed (logged to the dev console).

use std::io::Write as _;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use directories::ProjectDirs;
use faf_domain::state::SettingsState;

use crate::ports::SettingsPort;

/// Persists settings to `<config-dir>/settings.json`.
pub struct FileSettings {
    path: PathBuf,
}

impl FileSettings {
    /// Use the standard per-app config directory (e.g. `%APPDATA%/forge-client`
    /// on Windows, `~/.config/forge-client` on Linux). Falls back to the current
    /// directory if no config dir can be resolved.
    pub fn faf() -> Self {
        Self {
            path: resolve_path(),
        }
    }

    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

/// Same resolution [`FileSettings::faf`] uses, exposed standalone so the
/// shell can pre-read settings synchronously at startup (see
/// [`load_sync`]) before the async runtime: and therefore the [`SettingsPort`]
///: exists yet.
pub fn resolve_path() -> PathBuf {
    ProjectDirs::from("com", "forgeclient", "forge-client")
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
        Ok(bytes) => serde_json::from_slice::<SettingsState>(&bytes)
            .unwrap_or_default()
            .normalized(),
        Err(_) => SettingsState::default(),
    }
}

#[async_trait]
impl SettingsPort for FileSettings {
    async fn load(&self) -> SettingsState {
        match tokio::fs::read(&self.path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                tracing::warn!(error = %e, "ignoring unreadable settings file");
                SettingsState::default()
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                SettingsState::default() // first run: no file yet
            }
            Err(error) => {
                tracing::warn!(error = %error, path = %self.path.display(), "could not read settings");
                SettingsState::default()
            }
        }
    }

    async fn save(&self, settings: &SettingsState) {
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

    #[test]
    fn atomic_write_replaces_an_existing_file() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"old").expect("seed old settings");

        write_atomically(&path, b"new").expect("replace settings");

        assert_eq!(std::fs::read(path).expect("read settings"), b"new");
    }
}
