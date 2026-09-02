//! Install slice: whether the client can actually find Forged Alliance.
//!
//! Separate from [`settings`](crate::state::settings) on purpose: the settings
//! slice is a *configuration record* that round-trips to `settings.json`, while
//! this is a *derived runtime fact* re-checked on every startup and on every
//! path change. Persisting "the install was there last time" would be stale the
//! moment the user moved or uninstalled the game: which is precisely the case
//! the missing-install banner exists to catch.
//!
//! Both reference clients gate the same way: the Python client's
//! `validate_game_path` refuses to proceed without a real install, and the Java
//! client's first-run wizard asks for one before anything can be launched.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Where each configurable location currently resolves to.
///
/// Reported by the backend rather than worked out in the interface: the
/// fallbacks live in the adapters - a Java client's vault, FAF's Documents
/// convention, a platform data directory - and the settings tab would
/// otherwise have nothing to show for a path nobody has set, which is most of
/// them for most people.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPaths {
    pub vault_dir: String,
    pub maps_dir: String,
    pub mods_dir: String,
    pub replays_dir: String,
    pub game_prefs_path: String,
    pub map_generator_dir: String,
    pub java_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InstallState {
    /// The configured live-game executable exists on disk.
    pub game_ready: bool,
    /// The configured replay-playback executable exists on disk.
    pub replay_ready: bool,
    /// Whether the paths have been checked at all yet.
    ///
    /// Without this the UI cannot tell "no install" from "not looked yet", and
    /// would flash a missing-install warning during the startup window before
    /// the first check completes.
    pub checked: bool,
    /// Where the configurable locations point right now. See [`ResolvedPaths`].
    ///
    /// No `#[serde(default)]`: this slice is runtime state, never read back
    /// from a file written by an older build, and the attribute would only
    /// make the field optional in the generated TypeScript for nothing.
    pub resolved: ResolvedPaths,
}

impl InstallState {
    /// Nothing can be launched: neither a live game nor a replay.
    pub fn nothing_ready(&self) -> bool {
        !self.game_ready && !self.replay_ready
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InstallEvent {
    /// The configured paths were stat'd. Emitted at startup and after every
    /// change to either path.
    Checked {
        game_ready: bool,
        replay_ready: bool,
        resolved: ResolvedPaths,
    },
}

pub fn reduce(state: &mut InstallState, event: &InstallEvent) {
    match event {
        InstallEvent::Checked {
            game_ready,
            replay_ready,
            resolved,
        } => {
            state.game_ready = *game_ready;
            state.replay_ready = *replay_ready;
            state.resolved = resolved.clone();
            state.checked = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_unchecked_so_the_ui_stays_quiet_at_startup() {
        let s = InstallState::default();
        assert!(!s.checked);
        assert!(s.nothing_ready());
    }

    #[test]
    fn checked_records_both_paths_and_flips_checked() {
        let mut s = InstallState::default();
        reduce(
            &mut s,
            &InstallEvent::Checked {
                game_ready: true,
                replay_ready: false,
                resolved: ResolvedPaths::default(),
            },
        );
        assert!(s.checked);
        assert!(s.game_ready);
        assert!(!s.replay_ready);
        assert!(!s.nothing_ready());
    }

    #[test]
    fn a_later_check_can_report_an_install_that_went_away() {
        let mut s = InstallState {
            game_ready: true,
            replay_ready: true,
            checked: true,
            resolved: ResolvedPaths {
                maps_dir: "D:/old/maps".into(),
                ..ResolvedPaths::default()
            },
        };
        reduce(
            &mut s,
            &InstallEvent::Checked {
                game_ready: false,
                replay_ready: false,
                resolved: ResolvedPaths {
                    maps_dir: "D:/new/maps".into(),
                    ..ResolvedPaths::default()
                },
            },
        );
        assert!(s.checked, "still checked: we looked and found nothing");
        assert!(s.nothing_ready());
        // The check reports where things resolve now, not where they used to.
        assert_eq!(s.resolved.maps_dir, "D:/new/maps");
    }
}
