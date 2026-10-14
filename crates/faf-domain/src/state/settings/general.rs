//! The general group: the tab the client opens on, whether it signs in by
//! itself, and how long the filters of its lists are remembered.

use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneralPreferences {
    /// Destination selected when the persisted settings are loaded.
    pub start_page: Tab,
    /// Automatically restore the saved session at startup.
    #[serde(default = "default_true")]
    pub auto_login: bool,
    /// Let the window offer things typed into a text field before.
    ///
    /// This is the embedded browser's own form history, not anything this
    /// client stores, and it showed up as a "Saved info" dropdown over the
    /// host dialog's game title. Off by default, which is a deliberate change
    /// of behaviour: the client already restores the last title *into* that
    /// field (`BrowsingPreferences::host_game`), so the dropdown was a second,
    /// worse copy of a feature that was already there, covering the value it
    /// had just put in. A setting rather than a removal because the thread
    /// asked for one, and because somebody who hosts under half a dozen
    /// rotating titles is served by it.
    #[serde(default)]
    pub remember_typed_entries: bool,
    /// How long the filters of every list in the client are remembered (#447).
    ///
    /// One setting for all of them, not a switch per tab: the thread asked
    /// for exactly these three answers to one question, and a filter that
    /// behaves differently from the one in the next tab reads as a bug either
    /// way. `default` so a settings file written before this existed reads as
    /// the default rather than failing.
    #[serde(default)]
    pub filter_memory: FilterMemory,
    /// Closing the client during a game hides it to the tray instead.
    ///
    /// The window's close button and the tray's Quit both: the client keeps
    /// the lobby connection, the ICE adapter and the replay relay up until the
    /// game has ended, then exits by itself, unless it was brought back from
    /// the tray in the meantime. An accidental click on the close button in the
    /// middle of a game used to cost that game's connection; the Java and
    /// Python clients only ask first. Off, the client asks before closing, as
    /// it did before this existed. `default_true` so a settings file written
    /// before it reads as on.
    #[serde(default = "default_true")]
    pub keep_running_during_game: bool,
}

/// How long a filter outlives the moment it was set (#447).
///
/// What counts as a filter is anything that narrows a list: a search, a
/// "hide" or "only" switch, a picker, a vault preset, a rule. How a list is
/// sorted and how its columns are laid out are not filters and are always
/// kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FilterMemory {
    /// Every list starts unfiltered whenever it is opened.
    Never,
    /// Filters survive leaving a tab and coming back, and are cleared when the
    /// client starts. The default, because a search typed yesterday that
    /// still hid games after a restart was reported as a bug (#447).
    #[default]
    Session,
    /// Filters survive a restart.
    Restart,
}

impl Default for GeneralPreferences {
    fn default() -> Self {
        Self {
            start_page: Tab::News,
            auto_login: true,
            remember_typed_entries: false,
            filter_memory: FilterMemory::Session,
            keep_running_during_game: true,
        }
    }
}

preference_patch! {
    /// A change to [`GeneralPreferences`]; see `preference_patch!`.
    GeneralPreferencesPatch for GeneralPreferences {
        start_page: Tab,
        auto_login: bool,
        remember_typed_entries: bool,
        filter_memory: FilterMemory,
        keep_running_during_game: bool,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_last_one_session_unless_told_otherwise() {
        // A settings file from before #447 has no answer and gets the default.
        let general: GeneralPreferences = serde_json::from_str(r#"{"startPage":"news"}"#).unwrap();
        assert_eq!(general.filter_memory, FilterMemory::Session);
    }
}
