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

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InstallState {
    /// The configured live-game executable exists on disk.
    pub game_ready: bool,
    /// The configured replay-playback executable exists on disk.
    pub replay_ready: bool,
    /// The original retail/Steam Forged Alliance folder, as actually resolved:
    /// the one configured in Settings when it is set and real, otherwise
    /// whatever auto-detection found. Empty means nothing was found, which is
    /// worth showing: without it every launch fails, and it fails in the engine
    /// with a message about a shader file.
    pub retail_path: String,
    /// Whether the paths have been checked at all yet.
    ///
    /// Without this the UI cannot tell "no install" from "not looked yet", and
    /// would flash a missing-install warning during the startup window before
    /// the first check completes.
    pub checked: bool,
}

impl InstallState {
    /// Nothing can be launched: neither a live game nor a replay.
    pub fn nothing_ready(&self) -> bool {
        !self.game_ready && !self.replay_ready
    }

    /// The base game was located, so `fa_path.lua` can be written truthfully.
    pub fn retail_ready(&self) -> bool {
        !self.retail_path.is_empty()
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
        /// The resolved retail install, or empty when none was found.
        retail_path: String,
    },
}

pub fn reduce(state: &mut InstallState, event: &InstallEvent) {
    match event {
        InstallEvent::Checked {
            game_ready,
            replay_ready,
            retail_path,
        } => {
            state.game_ready = *game_ready;
            state.replay_ready = *replay_ready;
            state.retail_path = retail_path.clone();
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
        assert!(!s.retail_ready());
    }

    #[test]
    fn checked_records_both_paths_and_flips_checked() {
        let mut s = InstallState::default();
        reduce(
            &mut s,
            &InstallEvent::Checked {
                game_ready: true,
                replay_ready: false,
                retail_path: r"C:\Games\Supreme Commander Forged Alliance".into(),
            },
        );
        assert!(s.checked);
        assert!(s.game_ready);
        assert!(!s.replay_ready);
        assert!(!s.nothing_ready());
        assert!(s.retail_ready());
    }

    #[test]
    fn a_later_check_can_report_an_install_that_went_away() {
        let mut s = InstallState {
            game_ready: true,
            replay_ready: true,
            retail_path: r"C:\Games\Supreme Commander Forged Alliance".into(),
            checked: true,
        };
        reduce(
            &mut s,
            &InstallEvent::Checked {
                game_ready: false,
                replay_ready: false,
                retail_path: String::new(),
            },
        );
        assert!(s.checked, "still checked: we looked and found nothing");
        assert!(s.nothing_ready());
        assert!(!s.retail_ready(), "a base game that went away is not ready");
    }
}
