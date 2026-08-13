//! File-backed settings store — JSON in the OS config directory.
//!
//! The real [`SettingsPort`]. Resolves a per-app config directory via the
//! `directories` crate, so it needs no path injection from the shell and stays
//! free of any Tauri coupling. All IO is best-effort: a missing or corrupt file
//! yields defaults, and write failures are swallowed (logged to the dev console).

use std::path::PathBuf;

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
        Self { path: resolve_path() }
    }

    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

/// Same resolution [`FileSettings::faf`] uses, exposed standalone so the
/// shell can pre-read settings synchronously at startup (see
/// [`load_sync`]) before the async runtime — and therefore the [`SettingsPort`]
/// — exists yet.
pub fn resolve_path() -> PathBuf {
    ProjectDirs::from("com", "forgeclient", "forge-client")
        .map(|dirs| dirs.config_dir().join("settings.json"))
        .unwrap_or_else(|| PathBuf::from("settings.json"))
}

/// Blocking read of persisted settings, for use before the async runtime
/// starts. [`crate::infra::ports_from_env`] builds `GameConfig`/`ReplayConfig`
/// synchronously from env vars at startup, before `SettingsCommand::Load`
/// ever runs on the loop — so a persisted `game_path`/`replay_game_path`
/// needs to reach those env vars *before* that call, not through the normal
/// async [`SettingsPort::load`] path. Same defaults-on-missing-or-corrupt
/// posture as the async version.
pub fn load_sync(path: &std::path::Path) -> SettingsState {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => SettingsState::default(),
    }
}

#[async_trait]
impl SettingsPort for FileSettings {
    async fn load(&self) -> SettingsState {
        match tokio::fs::read(&self.path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                eprintln!("[settings] ignoring unreadable settings file: {e}");
                SettingsState::default()
            }),
            Err(_) => SettingsState::default(), // first run — no file yet
        }
    }

    async fn save(&self, settings: &SettingsState) {
        if let Some(parent) = self.path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        match serde_json::to_vec_pretty(settings) {
            Ok(bytes) => {
                if let Err(e) = tokio::fs::write(&self.path, bytes).await {
                    eprintln!("[settings] could not write settings: {e}");
                }
            }
            Err(e) => eprintln!("[settings] could not serialize settings: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use faf_domain::state::Theme;

    #[tokio::test]
    async fn round_trips_through_a_file() {
        let dir = std::env::temp_dir().join(format!("forge-settings-{}", std::process::id()));
        let path = dir.join("settings.json");
        let store = FileSettings::at(&path);

        // Missing file → defaults.
        assert_eq!(store.load().await, SettingsState::default());

        store
            .save(&SettingsState {
                theme: Theme::PythonClient,
                game_path: "C:/FA/bin/ForgedAlliance.exe".into(),
                replay_game_path: String::new(),
            })
            .await;
        let loaded = store.load().await;
        assert_eq!(loaded.theme, Theme::PythonClient);
        assert_eq!(loaded.game_path, "C:/FA/bin/ForgedAlliance.exe");

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
