//! Settings slice — persisted user preferences.
//!
//! The first persisted slice: its values are loaded from disk on startup and
//! saved on change (via `SettingsPort` in `faf-app`). Today it holds the UI
//! `theme`; it is the home for every future preference (language, paths,
//! notifications) so the settings pattern is established once.
//!
//! `theme` lives here — in the source of truth — rather than in the frontend, so
//! it is type-safe across the IPC boundary and persists across restarts. The
//! frontend merely projects it onto `<html data-theme>`.

use serde::{Deserialize, Serialize};
use specta::Type;

/// The active UI theme. Each variant maps to a `[data-theme]` token set in the
/// frontend; adding a theme is a token block + a variant here (no UI changes).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    /// ForgeMapToolkit dark — the signature warm near-black aesthetic.
    #[default]
    ForgeDark,
    /// ForgeMapToolkit light.
    ForgeLight,
    /// FAF Java client aesthetic.
    JavaClient,
    /// FAF Python client aesthetic.
    PythonClient,
}

/// Persisted preferences. Serialized verbatim to the settings file.
///
/// `game_path`/`replay_game_path` back the two FA installs
/// [`crate::state::LobbyState`]/replay launch need (see
/// `faf_app::infra::game::GameConfig`'s doc comment for why they're
/// separate). Previously these were configurable only via the
/// `FAF_GAME_PATH`/`FAF_REPLAY_GAME_PATH` env vars, which meant the app was
/// effectively unusable for anyone who wasn't a developer exporting them by
/// hand — empty string means "unset", same convention `GameConfig::faf()`
/// already used for the env var. Read once at startup and baked into the
/// launch config (see `src-tauri/src/lib.rs`), so a change here needs an app
/// restart to take effect — no different from every other launch config
/// (`api_base`, `content_base`, …) already being startup-only.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsState {
    pub theme: Theme,
    pub game_path: String,
    pub replay_game_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum SettingsEvent {
    /// Settings were loaded from disk (startup) — replaces the whole slice.
    Loaded { settings: SettingsState },
    /// The theme changed.
    ThemeChanged { theme: Theme },
    /// The live-game FA install path changed.
    GamePathChanged { path: String },
    /// The replay FA install path changed.
    ReplayGamePathChanged { path: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum SettingsCommand {
    /// Load persisted settings (dispatched once at startup).
    Load,
    /// Change the active theme (persisted).
    SetTheme { theme: Theme },
    /// Change the live-game FA install path (persisted).
    SetGamePath { path: String },
    /// Change the replay FA install path (persisted).
    SetReplayGamePath { path: String },
}

pub fn reduce(state: &mut SettingsState, event: &SettingsEvent) {
    match event {
        SettingsEvent::Loaded { settings } => *state = settings.clone(),
        SettingsEvent::ThemeChanged { theme } => state.theme = *theme,
        SettingsEvent::GamePathChanged { path } => state.game_path = path.clone(),
        SettingsEvent::ReplayGamePathChanged { path } => state.replay_game_path = path.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_theme_is_forge_dark() {
        assert_eq!(SettingsState::default().theme, Theme::ForgeDark);
    }

    #[test]
    fn loaded_replaces_the_slice() {
        let mut s = SettingsState::default();
        reduce(
            &mut s,
            &SettingsEvent::Loaded {
                settings: SettingsState {
                    theme: Theme::JavaClient,
                    game_path: "C:/FA/bin/ForgedAlliance.exe".into(),
                    replay_game_path: "C:/FA-replay/bin/ForgedAlliance.exe".into(),
                },
            },
        );
        assert_eq!(s.theme, Theme::JavaClient);
        assert_eq!(s.game_path, "C:/FA/bin/ForgedAlliance.exe");
        assert_eq!(s.replay_game_path, "C:/FA-replay/bin/ForgedAlliance.exe");
    }

    #[test]
    fn theme_changed_sets_theme() {
        let mut s = SettingsState::default();
        reduce(&mut s, &SettingsEvent::ThemeChanged { theme: Theme::ForgeLight });
        assert_eq!(s.theme, Theme::ForgeLight);
    }

    #[test]
    fn game_path_changed_sets_game_path() {
        let mut s = SettingsState::default();
        reduce(
            &mut s,
            &SettingsEvent::GamePathChanged {
                path: "C:/FA/bin/ForgedAlliance.exe".into(),
            },
        );
        assert_eq!(s.game_path, "C:/FA/bin/ForgedAlliance.exe");
    }

    #[test]
    fn replay_game_path_changed_sets_replay_game_path() {
        let mut s = SettingsState::default();
        reduce(
            &mut s,
            &SettingsEvent::ReplayGamePathChanged {
                path: "C:/FA-replay/bin/ForgedAlliance.exe".into(),
            },
        );
        assert_eq!(s.replay_game_path, "C:/FA-replay/bin/ForgedAlliance.exe");
    }
}
