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
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsState {
    pub theme: Theme,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum SettingsEvent {
    /// Settings were loaded from disk (startup) — replaces the whole slice.
    Loaded { settings: SettingsState },
    /// The theme changed.
    ThemeChanged { theme: Theme },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum SettingsCommand {
    /// Load persisted settings (dispatched once at startup).
    Load,
    /// Change the active theme (persisted).
    SetTheme { theme: Theme },
}

pub fn reduce(state: &mut SettingsState, event: &SettingsEvent) {
    match event {
        SettingsEvent::Loaded { settings } => *state = settings.clone(),
        SettingsEvent::ThemeChanged { theme } => state.theme = *theme,
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
                },
            },
        );
        assert_eq!(s.theme, Theme::JavaClient);
    }

    #[test]
    fn theme_changed_sets_theme() {
        let mut s = SettingsState::default();
        reduce(&mut s, &SettingsEvent::ThemeChanged { theme: Theme::ForgeLight });
        assert_eq!(s.theme, Theme::ForgeLight);
    }
}
