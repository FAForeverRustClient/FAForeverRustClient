//! Map generator slice: producing Neroxis maps locally.
//!
//! Generated maps are not downloaded, they are *reproduced*: the map name
//! carries the generator version and seed, and every client runs the same JAR
//! to get byte-identical terrain (see
//! [`crate::protocol::map_generator`] for the grammar and command line).
//!
//! Two entry points, matching the two reference clients:
//!
//! * **Reproduce by name**: you joined a lobby or matched into a queue whose
//!   map you don't have. The Python client is built entirely around this case.
//! * **Generate from options**: you are hosting and want a fresh map with
//!   chosen size, spawns, style and so on. This is the Java client's
//!   `GenerateMapController`.
//!
//! Generation is slow (the Java client allows three minutes) and CPU-bound, so
//! the status here is a first-class progress model rather than a bool: the UI
//! has to be able to say *which* stage is taking the time.

use serde::{Deserialize, Serialize};
use specta::Type;

pub use crate::protocol::map_generator::{
    GenerationType, GeneratorOptionQuery, GeneratorOptions, GeneratorVersion, StyleConstraints,
    ValidationIssue,
};
pub use crate::protocol::map_generator_name::{DecodedMapName, DecodedStyle};

/// Where a generation run currently is.
// No `Eq`: `Failed` is compared alongside options carrying `f32` densities in
// the slice, and keeping the whole slice `PartialEq`-only is simpler than
// splitting it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum GeneratorStatus {
    #[default]
    Idle,
    /// A run has been accepted and is being set up: checking the options with
    /// the generator, resolving a release.
    ///
    /// Emitted synchronously when the command is received, before any IO. That
    /// matters twice over: it is the only feedback during the `--parse`
    /// preflight, which costs a JVM start; and it guarantees the status leaves
    /// `Generated` at the *start* of every run, so a UI watching for a result
    /// cannot mistake the previous run's maps for this one's.
    Preparing,
    /// Asking GitHub which generator release to use. Only happens for an
    /// options-driven run: reproducing a map takes its version from the name.
    ResolvingVersion,
    /// Fetching the generator JAR. Carries progress so a slow connection
    /// doesn't look like a hang.
    ///
    /// Byte counts are `u32`: specta forbids 64-bit integers across the JS
    /// boundary (precision loss), and a generator release is a few megabytes,
    /// four gigabytes of headroom is not a constraint here.
    #[serde(rename_all = "camelCase")]
    Downloading {
        version: String,
        downloaded_bytes: u32,
        total_bytes: Option<u32>,
    },
    /// The JAR is running. `detail` is the generator's own latest output line,
    /// which is the only progress signal it offers.
    #[serde(rename_all = "camelCase")]
    Generating {
        version: String,
        detail: String,
    },
    /// Finished. `maps` are the folder names now on disk.
    Generated {
        maps: Vec<String>,
    },
    Failed {
        reason: String,
    },
    /// The user stopped the run. Distinct from `Failed` because nothing went
    /// wrong: presenting a deliberate cancellation as an error trains people to
    /// ignore error messages.
    Cancelled,
}

impl GeneratorStatus {
    /// Whether a run is in flight: the UI disables re-entry on this.
    pub fn is_busy(&self) -> bool {
        matches!(
            self,
            GeneratorStatus::Preparing
                | GeneratorStatus::ResolvingVersion
                | GeneratorStatus::Downloading { .. }
                | GeneratorStatus::Generating { .. }
        )
    }
}

/// A named, saved set of generator options.
///
/// Kept as one file each rather than as a list inside the client's settings,
/// because a preset is a thing you want to *have*: to copy, to send to someone
/// setting up a tournament, to keep after a reinstall. A blob buried in
/// `settings.json` is none of those.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorPreset {
    /// What the user called it. Shown as-is; the file name is derived.
    pub name: String,
    /// RFC 3339. A string because specta refuses 64-bit numbers, and because a
    /// formatted instant is what the list wants anyway.
    #[serde(default)]
    pub saved_at: String,
    pub options: GeneratorOptions,
}

/// Longest preset name accepted. Generous, but bounded: the name becomes a
/// file name, and file systems have limits that a silent truncation would hit
/// in confusing ways.
pub const MAX_PRESET_NAME: usize = 80;

/// Whether a name can be saved as a preset.
///
/// The name has to survive becoming a file name, so the same constraints as
/// [`crate::state::is_safe_folder_name`] apply: nothing that could climb out
/// of the presets folder, nothing hidden, nothing empty.
pub fn is_valid_preset_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && trimmed.len() <= MAX_PRESET_NAME
        && !trimmed.starts_with('.')
        && !trimmed.contains("..")
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ' '))
}

/// The file a preset is stored in, or `None` if the name is unusable.
///
/// Lower-cased and space-collapsed so "Team Ladder" and "team ladder" are the
/// same preset rather than two files that look identical in the list.
pub fn preset_file_name(name: &str) -> Option<String> {
    if !is_valid_preset_name(name) {
        return None;
    }
    let slug: String = name
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c == ' ' { '-' } else { c })
        .collect();
    // Collapse runs of separators left by consecutive spaces.
    let mut collapsed = String::with_capacity(slug.len());
    for c in slug.chars() {
        if c == '-' && collapsed.ends_with('-') {
            continue;
        }
        collapsed.push(c);
    }
    let trimmed = collapsed.trim_matches('-');
    (!trimmed.is_empty()).then(|| format!("{trimmed}.json"))
}

/// The option lists the generator itself reports (`--styles`, `--symmetries`, …).
///
/// Queried from the JAR rather than hardcoded, because they change between
/// generator releases: the Java client's `GeneratorOptionsTask` does the same.
/// Empty until [`MapGeneratorCommand::LoadOptions`] has run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorOptionLists {
    pub symmetries: Vec<String>,
    pub styles: Vec<String>,
    pub terrain_styles: Vec<String>,
    pub texture_styles: Vec<String>,
    pub resource_styles: Vec<String>,
    pub prop_styles: Vec<String>,
}

impl Default for GeneratorOptionLists {
    fn default() -> Self {
        Self::fallback()
    }
}

impl GeneratorOptionLists {
    pub fn empty() -> Self {
        Self {
            symmetries: Vec::new(),
            styles: Vec::new(),
            terrain_styles: Vec::new(),
            texture_styles: Vec::new(),
            resource_styles: Vec::new(),
            prop_styles: Vec::new(),
        }
    }

    /// Pre-populated standard built-in option lists for Neroxis map generator.
    ///
    /// Available from millisecond zero even on fresh installations, and
    /// updated dynamically when [`MapGeneratorCommand::LoadOptions`] queries
    /// the specific JAR release.
    pub fn fallback() -> Self {
        Self {
            symmetries: vec![
                "POINT2", "POINT3", "POINT4", "POINT5", "POINT6", "POINT7", "POINT8", "POINT9",
                "POINT10", "POINT11", "POINT12", "POINT13", "POINT14", "POINT15", "POINT16", "XZ",
                "ZX", "X", "Z", "QUAD", "DIAG", "NONE",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            styles: vec![
                "ACCEL",
                "BIG_ISLANDS",
                "CENTER_ISLAND",
                "CLEAN",
                "CORRIDOR",
                "DROP_PLATEAU",
                "DUAL_GAP",
                "FLOODED",
                "GAP",
                "GLACIER",
                "HILLY",
                "ISLANDS",
                "LAND",
                "LOW_PLATEAU",
                "MOUNTAIN_RANGE",
                "ONE_ISLAND",
                "PASSES",
                "PLATEAU",
                "RAMP_PLATEAU",
                "RIVERS",
                "SCARRED",
                "SLOPE",
                "TUNDRA",
                "VALLEY",
                "WATER",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            terrain_styles: vec![
                "BIG_ISLANDS",
                "CENTER_ISLAND",
                "CLEAN",
                "CORRIDOR",
                "DROP_PLATEAU",
                "DUAL_GAP",
                "FLOODED",
                "GAP",
                "GLACIER",
                "HILLY",
                "ISLANDS",
                "LAND",
                "LOW_PLATEAU",
                "MOUNTAIN_RANGE",
                "ONE_ISLAND",
                "PASSES",
                "PLATEAU",
                "RAMP_PLATEAU",
                "RIVERS",
                "SCARRED",
                "SLOPE",
                "TUNDRA",
                "VALLEY",
                "WATER",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            texture_styles: vec![
                "BRIMSTONE",
                "DESERT",
                "FROST",
                "LUSH",
                "MARS",
                "MOON",
                "SAVANNAH",
                "STEPPE",
                "TUNDRA",
                "WONDER",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            resource_styles: vec!["BASIC", "DENSE", "EXPANSIVE", "SPARSE"]
                .into_iter()
                .map(String::from)
                .collect(),
            prop_styles: vec![
                "BASIC",
                "BOULDERS",
                "FOREST",
                "ROCKS",
                "ROCK_FIELD",
                "TREE_FIELD",
                "WRECKAGE",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
        }
    }

    /// Whether anything has been loaded yet.
    pub fn is_empty(&self) -> bool {
        self.symmetries.is_empty()
            && self.styles.is_empty()
            && self.terrain_styles.is_empty()
            && self.texture_styles.is_empty()
            && self.resource_styles.is_empty()
            && self.prop_styles.is_empty()
    }

    fn set(&mut self, query: GeneratorOptionQuery, values: Vec<String>) {
        match query {
            GeneratorOptionQuery::Symmetries => self.symmetries = values,
            GeneratorOptionQuery::Styles => self.styles = values,
            GeneratorOptionQuery::TerrainStyles => self.terrain_styles = values,
            GeneratorOptionQuery::TextureStyles => self.texture_styles = values,
            GeneratorOptionQuery::ResourceStyles => self.resource_styles = values,
            GeneratorOptionQuery::PropStyles => self.prop_styles = values,
        }
    }
}

// No `Eq`: `options` carries `f32` densities.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MapGeneratorState {
    pub status: GeneratorStatus,
    /// The newest supported generator release, once resolved. Empty until then.
    pub latest_version: String,
    /// All available supported generator releases from GitHub.
    #[serde(default)]
    pub available_versions: Vec<String>,
    /// Currently selected version in the UI.
    #[serde(default)]
    pub selected_version: Option<String>,
    pub option_lists: GeneratorOptionLists,
    /// The last options the user configured, kept so the host dialog reopens
    /// where it was left: the Java client persists the same set in
    /// `GeneratorPrefs`.
    pub options: GeneratorOptions,
    /// Data URLs of newly generated map previews (`map_name` -> `data:image/png;base64,...`).
    #[serde(default)]
    pub previews: std::collections::HashMap<String, String>,
    /// Problems with the current options, from the pure rule checks. Refreshed
    /// as the dialog is edited so the user is told *before* a JAR is fetched
    /// and a JVM started, which is when the generator would otherwise object.
    #[serde(default)]
    pub validation: Vec<ValidationIssue>,
    /// The map name the current options would produce, as reported by the
    /// generator's own `--parse`. Empty until a preflight has run.
    ///
    /// Worth showing on its own: it is shareable before the map exists, and it
    /// is the authoritative confirmation that the options are acceptable.
    #[serde(default)]
    pub predicted_name: String,
    /// Parameters decoded out of generated map names, keyed by name.
    ///
    /// Filled by [`MapGeneratorCommand::DecodeNames`], which is pure
    /// arithmetic: a lobby list can afford to decode every row.
    #[serde(default)]
    pub decoded: std::collections::HashMap<String, DecodedMapName>,
    /// The generator's own `--help` output, for the escape hatch users who
    /// write raw arguments. The Python client offers the same button.
    #[serde(default)]
    pub help_text: String,
    /// The saved preset library, newest first. Empty until loaded.
    #[serde(default)]
    pub presets: Vec<GeneratorPreset>,
}

// No `Eq`: `OptionsChanged` carries `GeneratorOptions`.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MapGeneratorEvent {
    StatusChanged {
        status: GeneratorStatus,
    },
    VersionResolved {
        version: String,
    },
    VersionsLoaded {
        versions: Vec<String>,
    },
    OptionListLoaded {
        query: GeneratorOptionQuery,
        values: Vec<String>,
    },
    OptionsChanged {
        options: GeneratorOptions,
    },
    PreviewsLoaded {
        previews: std::collections::HashMap<String, String>,
    },
    ValidationChanged {
        issues: Vec<ValidationIssue>,
    },
    /// A `--parse` preflight resolved the options to a map name. An empty name
    /// clears a stale prediction when the options change.
    NamePredicted {
        map_name: String,
    },
    NamesDecoded {
        decoded: std::collections::HashMap<String, DecodedMapName>,
    },
    HelpLoaded {
        text: String,
    },
    /// The whole library, re-read after every change. Small enough that
    /// sending the list beats sending deltas and keeping two copies in step.
    PresetsLoaded {
        presets: Vec<GeneratorPreset>,
    },
}

// No `Eq`: `Generate` carries `GeneratorOptions`.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MapGeneratorCommand {
    /// Reproduce a specific generated map, downloading the matching generator
    /// version first. The join path calls this when the map is missing.
    GenerateNamed {
        map_name: String,
    },
    /// Generate one or more fresh maps from options (the host flow).
    Generate {
        options: GeneratorOptions,
    },
    /// Fetch every option list from the generator, downloading the specified
    /// (or newest supported) release first if needed.
    LoadOptions {
        #[serde(default)]
        version: Option<String>,
    },
    /// Remember the host dialog's current options without generating.
    SetOptions {
        options: GeneratorOptions,
    },
    /// Check options against the generator's rules without running anything.
    ///
    /// Pure and instant, so the dialog can call it on every edit. It is a fast
    /// approximation of what [`MapGeneratorCommand::Preflight`] confirms.
    Validate {
        options: GeneratorOptions,
    },
    /// Ask the generator itself to resolve the options, via `--parse`.
    ///
    /// Authoritative where [`MapGeneratorCommand::Validate`] is merely quick:
    /// it applies the rules of the *actual* release rather than our copy of
    /// them, and it yields the resulting map name. Costs a JVM start, no map.
    Preflight {
        options: GeneratorOptions,
    },
    /// Decode generated map names into their parameters, without any IO.
    DecodeNames {
        map_names: Vec<String>,
    },
    /// Fetch the generator's `--help` text.
    LoadHelp {
        #[serde(default)]
        version: Option<String>,
    },
    /// Stop the run in flight. Does nothing when none is.
    Cancel,
    /// Write the current options to the preset library under `name`,
    /// overwriting a preset of the same name.
    SavePreset {
        name: String,
        options: GeneratorOptions,
    },
    /// Re-read the preset library from disk.
    LoadPresets,
    DeletePreset {
        name: String,
    },
    /// Delete generated maps except stable folder names explicitly protected
    /// by the user's favorites.
    ///
    /// Generated maps are reproducible from their name, so keeping them costs
    /// disk for no benefit. The Java client does this on shutdown
    /// (`MapGeneratorService.destroy`); exposing it as a command instead lets
    /// the user decide when, which suits a client that may not exit cleanly.
    CleanUp,
    /// The same sweep, run while the client is shutting down, and only if
    /// [`crate::state::GamePreferences::delete_generated_maps_on_exit`] asks
    /// for it.
    ///
    /// Separate from [`Self::CleanUp`] rather than a flag on it, because the
    /// two differ in more than their trigger: this one is silent (there is no
    /// window left to show a notification in), it is skipped outright while a
    /// generation is running, and it does nothing at all unless the user opted
    /// in. Python runs the same sweep from its shutdown path
    /// (`fa.maps.clear_generated_maps`) but defaults it on; here the default is
    /// to keep, so nobody loses a map they meant to keep by never having found
    /// the setting.
    CleanUpOnExit,
}

pub fn reduce(state: &mut MapGeneratorState, event: &MapGeneratorEvent) {
    match event {
        MapGeneratorEvent::StatusChanged { status } => state.status = status.clone(),
        MapGeneratorEvent::VersionResolved { version } => {
            state.latest_version = version.clone();
            state.selected_version = Some(version.clone());
        }
        MapGeneratorEvent::VersionsLoaded { versions } => {
            if state.latest_version.is_empty() {
                if let Some(first) = versions.first() {
                    state.latest_version = first.clone();
                }
            }
            state.available_versions = versions.clone();
        }
        MapGeneratorEvent::OptionListLoaded { query, values } => {
            state.option_lists.set(*query, values.clone())
        }
        MapGeneratorEvent::OptionsChanged { options } => {
            if let Some(v) = &options.version {
                state.selected_version = Some(v.clone());
            }
            state.options = options.clone();
        }
        MapGeneratorEvent::PreviewsLoaded { previews } => {
            state.previews.extend(previews.clone());
        }
        MapGeneratorEvent::ValidationChanged { issues } => state.validation = issues.clone(),
        MapGeneratorEvent::NamePredicted { map_name } => state.predicted_name = map_name.clone(),
        MapGeneratorEvent::NamesDecoded { decoded } => state.decoded.extend(decoded.clone()),
        MapGeneratorEvent::HelpLoaded { text } => state.help_text = text.clone(),
        MapGeneratorEvent::PresetsLoaded { presets } => state.presets = presets.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_idle_with_nothing_loaded() {
        let s = MapGeneratorState::default();
        assert_eq!(s.status, GeneratorStatus::Idle);
        assert!(s.latest_version.is_empty());
        assert!(!s.option_lists.is_empty());
        assert!(GeneratorOptionLists::empty().is_empty());
        assert!(!s.status.is_busy());
    }

    #[test]
    fn every_in_flight_status_reads_as_busy() {
        for status in [
            GeneratorStatus::Preparing,
            GeneratorStatus::ResolvingVersion,
            GeneratorStatus::Downloading {
                version: "1.7.7".into(),
                downloaded_bytes: 1,
                total_bytes: Some(2),
            },
            GeneratorStatus::Generating {
                version: "1.7.7".into(),
                detail: "…".into(),
            },
        ] {
            assert!(status.is_busy(), "{status:?} should be busy");
        }
        for status in [
            GeneratorStatus::Idle,
            GeneratorStatus::Generated { maps: vec![] },
            GeneratorStatus::Cancelled,
            GeneratorStatus::Failed { reason: "x".into() },
        ] {
            assert!(!status.is_busy(), "{status:?} should not be busy");
        }
    }

    #[test]
    fn status_changes_are_recorded() {
        let mut s = MapGeneratorState::default();
        reduce(
            &mut s,
            &MapGeneratorEvent::StatusChanged {
                status: GeneratorStatus::Generated {
                    maps: vec!["neroxis_map_generator_1.7.7_abc".into()],
                },
            },
        );
        assert_eq!(
            s.status,
            GeneratorStatus::Generated {
                maps: vec!["neroxis_map_generator_1.7.7_abc".into()]
            }
        );
    }

    #[test]
    fn each_option_list_lands_in_its_own_field() {
        let mut s = MapGeneratorState::default();
        for (query, value) in [
            (GeneratorOptionQuery::Symmetries, "POINT4"),
            (GeneratorOptionQuery::Styles, "LAND"),
            (GeneratorOptionQuery::TerrainStyles, "BIG_ISLANDS"),
            (GeneratorOptionQuery::TextureStyles, "BRIMSTONE"),
            (GeneratorOptionQuery::ResourceStyles, "BASIC"),
            (GeneratorOptionQuery::PropStyles, "ROCK_FIELD"),
        ] {
            reduce(
                &mut s,
                &MapGeneratorEvent::OptionListLoaded {
                    query,
                    values: vec![value.into()],
                },
            );
        }
        assert_eq!(s.option_lists.symmetries, vec!["POINT4"]);
        assert_eq!(s.option_lists.styles, vec!["LAND"]);
        assert_eq!(s.option_lists.terrain_styles, vec!["BIG_ISLANDS"]);
        assert_eq!(s.option_lists.texture_styles, vec!["BRIMSTONE"]);
        assert_eq!(s.option_lists.resource_styles, vec!["BASIC"]);
        assert_eq!(s.option_lists.prop_styles, vec!["ROCK_FIELD"]);
        assert!(!s.option_lists.is_empty());
    }

    #[test]
    fn options_round_trip() {
        let mut s = MapGeneratorState::default();
        let options = GeneratorOptions {
            spawn_count: Some(8),
            num_teams: Some(4),
            generation_type: GenerationType::Tournament,
            ..Default::default()
        };
        reduce(
            &mut s,
            &MapGeneratorEvent::OptionsChanged {
                options: options.clone(),
            },
        );
        assert_eq!(s.options, options);
    }

    #[test]
    fn preset_names_become_predictable_file_names() {
        assert_eq!(
            preset_file_name("Team Ladder").as_deref(),
            Some("team-ladder.json")
        );
        // Case and spacing must not create two files that look identical in
        // the list and then shadow each other.
        assert_eq!(
            preset_file_name("team   ladder").as_deref(),
            Some("team-ladder.json")
        );
        assert_eq!(
            preset_file_name("  Team Ladder  ").as_deref(),
            Some("team-ladder.json")
        );
        assert_eq!(preset_file_name("1v1").as_deref(), Some("1v1.json"));
    }

    #[test]
    fn a_preset_name_can_never_escape_its_folder() {
        // The name becomes a path component, so this is a security boundary,
        // not a tidiness rule.
        for name in [
            "../../etc/passwd",
            "..",
            ".hidden",
            "with/slash",
            "with\\backslash",
            "",
            "   ",
            "nul\0byte",
        ] {
            assert!(!is_valid_preset_name(name), "{name:?} should be refused");
            assert_eq!(preset_file_name(name), None, "{name:?} should have no file");
        }
    }

    #[test]
    fn an_over_long_preset_name_is_refused() {
        assert!(is_valid_preset_name(&"a".repeat(MAX_PRESET_NAME)));
        assert!(!is_valid_preset_name(&"a".repeat(MAX_PRESET_NAME + 1)));
    }

    #[test]
    fn the_preset_library_is_replaced_wholesale() {
        // Re-read after every change: a delta protocol would need two copies
        // of the library to stay in step for no benefit at this size.
        let mut s = MapGeneratorState::default();
        let preset = |name: &str| GeneratorPreset {
            name: name.into(),
            saved_at: "2026-08-16T00:00:00+00:00".into(),
            options: GeneratorOptions::default(),
        };
        reduce(
            &mut s,
            &MapGeneratorEvent::PresetsLoaded {
                presets: vec![preset("one"), preset("two")],
            },
        );
        assert_eq!(s.presets.len(), 2);
        reduce(
            &mut s,
            &MapGeneratorEvent::PresetsLoaded {
                presets: vec![preset("one")],
            },
        );
        assert_eq!(s.presets.len(), 1, "a deleted preset must disappear");
    }

    #[test]
    fn resolved_version_is_remembered() {
        let mut s = MapGeneratorState::default();
        reduce(
            &mut s,
            &MapGeneratorEvent::VersionResolved {
                version: "1.7.7".into(),
            },
        );
        assert_eq!(s.latest_version, "1.7.7");
    }
}
