//! Which ICE adapter a game is joined and hosted on, and the diagnostic
//! windows the helper processes may put on screen.

use super::*;

/// Which connectivity backend starts games.
///
/// The long-standing Java `faf-ice-adapter` is the production default used by
/// the established clients. The newer Go faf-pioneer remains available for
/// explicit testing while it is experimental. The two cannot connect to each
/// other, so a game only works when everybody in it uses the host's adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum IceAdapter {
    /// Follow the host: Go for a lobby whose title carries the go-adapter mark
    /// (see `lobby::GO_ADAPTER_TITLE_TAG`), Java for every other game, and Java
    /// when hosting. The default, because it is right wherever the host is on
    /// Java, which is every client's default, or on Go in this client.
    #[default]
    Dynamic,
    /// `faf-ice-adapter`, driven over JSON-RPC.
    Java,
    /// Experimental Java adapter (v4.0.0).
    ExpJava,
    /// Experimental faf-pioneer backend. Owns a local GPGNet relay the Java
    /// adapter has no equivalent of.
    Go,
}

impl IceAdapter {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Dynamic => "Dynamic (follows the host)",
            Self::Java => "Java (faf-ice-adapter)",
            Self::ExpJava => "Exp Java (faf-ice-adapter 4.0.0)",
            Self::Go => "Go (faf-pioneer)",
        }
    }

    /// The adapter a game with this title starts on. Never `Dynamic`.
    pub fn for_game(self, title: &str) -> Self {
        match self {
            Self::Dynamic if crate::state::lobby::title_marks_go_adapter(title) => Self::Go,
            Self::Dynamic if crate::state::lobby::title_marks_exp_java_adapter(title) => {
                Self::ExpJava
            }
            Self::Dynamic => Self::Java,
            chosen => chosen,
        }
    }
}

/// Two choices, because joining and hosting are different questions.
///
/// Joining can follow the host (`Dynamic`), since the host's title says which
/// adapter it runs; hosting has nobody to follow, so it is a plain Java or Go.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectivityPreferences {
    /// The adapter games are joined on. `Dynamic` by default.
    pub adapter: IceAdapter,
    /// The adapter games this client hosts run on: Java, ExpJava, or Go, Java by
    /// default. Hosting on Go marks the title (see
    /// `lobby::GO_ADAPTER_TITLE_TAG`) and hosting on ExpJava marks the title (see
    /// `lobby::EXP_JAVA_ADAPTER_TITLE_TAG`) so a `Dynamic` joiner follows.
    pub host_adapter: IceAdapter,
    /// Version of the explicit adapter choice. Version zero was written by
    /// builds where Pioneer was the implicit/default path, so a stored `go`
    /// value from that era is not evidence that the user opted into an
    /// experimental backend. Version one had Java as the default, so a stored
    /// `java` from it is the default rather than a choice: version two moves it
    /// to `Dynamic`, which behaves the same for every unmarked game.
    pub selection_version: u8,
}

const CONNECTIVITY_SELECTION_VERSION: u8 = 2;

impl Default for ConnectivityPreferences {
    fn default() -> Self {
        Self {
            adapter: IceAdapter::Dynamic,
            host_adapter: IceAdapter::Java,
            selection_version: CONNECTIVITY_SELECTION_VERSION,
        }
    }
}

impl ConnectivityPreferences {
    /// The adapter a hosted game runs on. Never `Dynamic`: there is no host to
    /// follow when this client is the host.
    pub fn hosting(&self) -> IceAdapter {
        match self.host_adapter {
            IceAdapter::Go => IceAdapter::Go,
            IceAdapter::ExpJava => IceAdapter::ExpJava,
            _ => IceAdapter::Java,
        }
    }
}

impl<'de> Deserialize<'de> for ConnectivityPreferences {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Default, Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            adapter: IceAdapter,
            host_adapter: Option<IceAdapter>,
            selection_version: u8,
        }

        let wire = Wire::deserialize(deserializer)?;
        let adapter = match (wire.selection_version, wire.adapter) {
            // Pioneer was the implicit path then, not a choice.
            (0, IceAdapter::Go) => IceAdapter::Dynamic,
            // Java was the default until version two; Dynamic is Java for
            // every game that is not marked as hosted on Go or ExpJava.
            (0 | 1, IceAdapter::Java) => IceAdapter::Dynamic,
            (_, adapter) => adapter,
        };
        // Absent before hosting had its own choice. A player who had set Go
        // for everything meant hosting on it too.
        let host_adapter = match wire.host_adapter {
            Some(IceAdapter::Go) => IceAdapter::Go,
            Some(IceAdapter::ExpJava) => IceAdapter::ExpJava,
            Some(_) => IceAdapter::Java,
            None if adapter == IceAdapter::Go => IceAdapter::Go,
            None if adapter == IceAdapter::ExpJava => IceAdapter::ExpJava,
            None => IceAdapter::Java,
        };
        Ok(Self {
            adapter,
            host_adapter,
            selection_version: CONNECTIVITY_SELECTION_VERSION,
        })
    }
}

/// Diagnostic windows the helper processes can put on screen.
///
/// Every one of these is off, and that is the point: a GUI client spawning a
/// console-subsystem child (`java.exe`, the Go adapter, `faf-uid`) makes
/// Windows open a console window for it, and the Java ICE adapter can raise two
/// JavaFX windows of its own. None of that is something a player asked for, so
/// the client suppresses all of it and these switches hand it back to whoever
/// is actually debugging a connection or a generator run.
///
/// The two adapter windows are the same pair the Java client exposes, and map
/// onto `faf-ice-adapter`'s `--debug-window` and `--info-window`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DebugPreferences {
    /// `--debug-window`: the adapter's peer and candidate table.
    pub ice_adapter_debug_window: bool,
    /// `--info-window`: the adapter's smaller status window.
    pub ice_adapter_info_window: bool,
    /// The console window the adapter's JVM would otherwise open, carrying its
    /// stdout. Separate from the two above because it is a different thing to
    /// look at: those are the adapter's own view of the connection, this is the
    /// raw log it prints while forming one.
    pub ice_adapter_console_window: bool,
    /// The console window the map generator's JVM would otherwise open, which
    /// carries the generator's own output.
    pub map_generator_window: bool,
}

impl<'de> Deserialize<'de> for DebugPreferences {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        /// As on [`SettingsState`]: read tolerance belongs here rather than on
        /// the exported type, where `#[serde(default)]` would make every
        /// TypeScript field optional.
        #[derive(Default, Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            ice_adapter_debug_window: bool,
            ice_adapter_info_window: bool,
            ice_adapter_console_window: bool,
            map_generator_window: bool,
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            ice_adapter_debug_window: wire.ice_adapter_debug_window,
            ice_adapter_info_window: wire.ice_adapter_info_window,
            ice_adapter_console_window: wire.ice_adapter_console_window,
            map_generator_window: wire.map_generator_window,
        })
    }
}

preference_patch! {
    /// A change to [`ConnectivityPreferences`].
    ConnectivityPreferencesPatch for ConnectivityPreferences {
        adapter: IceAdapter,
        host_adapter: IceAdapter,
        selection_version: u8,
    }
}

preference_patch! {
    /// A change to [`DebugPreferences`].
    DebugPreferencesPatch for DebugPreferences {
        ice_adapter_debug_window: bool,
        ice_adapter_info_window: bool,
        ice_adapter_console_window: bool,
        map_generator_window: bool,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_pioneer_default_migrates_to_dynamic() {
        let settings: SettingsState =
            serde_json::from_str(r#"{"connectivity":{"adapter":"go"}}"#).unwrap();

        assert_eq!(settings.connectivity.adapter, IceAdapter::Dynamic);
        assert_eq!(
            settings.connectivity.selection_version,
            CONNECTIVITY_SELECTION_VERSION
        );
    }

    #[test]
    fn the_old_java_default_becomes_dynamic() {
        // Java was what everybody had without choosing it, and Dynamic starts
        // Java for every game that is not marked as hosted on Go.
        let settings: SettingsState =
            serde_json::from_str(r#"{"connectivity":{"adapter":"java","selectionVersion":1}}"#)
                .unwrap();
        assert_eq!(settings.connectivity.adapter, IceAdapter::Dynamic);
        assert_eq!(
            settings.connectivity.selection_version,
            CONNECTIVITY_SELECTION_VERSION
        );

        // A Java chosen once Dynamic existed is a choice, and it stays.
        let settings: SettingsState =
            serde_json::from_str(r#"{"connectivity":{"adapter":"java","selectionVersion":2}}"#)
                .unwrap();
        assert_eq!(settings.connectivity.adapter, IceAdapter::Java);
    }

    #[test]
    fn dynamic_is_the_default_and_follows_the_host() {
        assert_eq!(
            SettingsState::default().connectivity.adapter,
            IceAdapter::Dynamic
        );
        assert_eq!(
            IceAdapter::Dynamic.for_game("Friday 4v4 [go-adapter]"),
            IceAdapter::Go
        );
        assert_eq!(
            IceAdapter::Dynamic.for_game("Friday 4v4 [GO-ADAPTER]"),
            IceAdapter::Go
        );
        assert_eq!(
            IceAdapter::Dynamic.for_game("Friday 4v4 [exp-java-adapter]"),
            IceAdapter::ExpJava
        );
        assert_eq!(
            IceAdapter::Dynamic.for_game("Friday 4v4 [EXP-JAVA-ADAPTER]"),
            IceAdapter::ExpJava
        );
        assert_eq!(IceAdapter::Dynamic.for_game("Friday 4v4"), IceAdapter::Java);
        // An explicit choice is never second-guessed by the title.
        assert_eq!(
            IceAdapter::Java.for_game("Friday 4v4 [go-adapter]"),
            IceAdapter::Java
        );
        assert_eq!(
            IceAdapter::ExpJava.for_game("Friday 4v4 [go-adapter]"),
            IceAdapter::ExpJava
        );
        assert_eq!(IceAdapter::Go.for_game("Friday 4v4"), IceAdapter::Go);

        let defaults = ConnectivityPreferences::default();
        assert_eq!(defaults.host_adapter, IceAdapter::Java);
        assert_eq!(defaults.hosting(), IceAdapter::Java);
        let odd = ConnectivityPreferences {
            host_adapter: IceAdapter::Dynamic,
            ..defaults
        };
        assert_eq!(
            odd.hosting(),
            IceAdapter::Java,
            "nobody to follow when hosting"
        );
    }

    #[test]
    fn hosting_has_its_own_choice_and_an_old_go_carries_over() {
        let settings: SettingsState =
            serde_json::from_str(r#"{"connectivity":{"adapter":"go","selectionVersion":2}}"#)
                .unwrap();
        assert_eq!(settings.connectivity.host_adapter, IceAdapter::Go);

        let settings: SettingsState = serde_json::from_str(
            r#"{"connectivity":{"adapter":"dynamic","hostAdapter":"go","selectionVersion":2}}"#,
        )
        .unwrap();
        assert_eq!(settings.connectivity.adapter, IceAdapter::Dynamic);
        assert_eq!(settings.connectivity.hosting(), IceAdapter::Go);

        let settings: SettingsState =
            serde_json::from_str(r#"{"connectivity":{"adapter":"dynamic","selectionVersion":2}}"#)
                .unwrap();
        assert_eq!(settings.connectivity.hosting(), IceAdapter::Java);
    }

    #[test]
    fn an_explicit_current_pioneer_choice_is_preserved() {
        let settings: SettingsState =
            serde_json::from_str(r#"{"connectivity":{"adapter":"go","selectionVersion":1}}"#)
                .unwrap();

        assert_eq!(settings.connectivity.adapter, IceAdapter::Go);
        assert_eq!(
            settings.connectivity.selection_version,
            CONNECTIVITY_SELECTION_VERSION
        );
    }
}
