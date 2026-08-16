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
            GeneratorStatus::ResolvingVersion
                | GeneratorStatus::Downloading { .. }
                | GeneratorStatus::Generating { .. }
        )
    }
}

/// The option lists the generator itself reports (`--styles`, `--symmetries`, …).
///
/// Queried from the JAR rather than hardcoded, because they change between
/// generator releases: the Java client's `GeneratorOptionsTask` does the same.
/// Empty until [`MapGeneratorCommand::LoadOptions`] has run.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorOptionLists {
    pub symmetries: Vec<String>,
    pub styles: Vec<String>,
    pub terrain_styles: Vec<String>,
    pub texture_styles: Vec<String>,
    pub resource_styles: Vec<String>,
    pub prop_styles: Vec<String>,
}

impl GeneratorOptionLists {
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
    GenerateNamed { map_name: String },
    /// Generate one or more fresh maps from options (the host flow).
    Generate { options: GeneratorOptions },
    /// Fetch every option list from the generator, downloading the specified
    /// (or newest supported) release first if needed.
    LoadOptions {
        #[serde(default)]
        version: Option<String>,
    },
    /// Remember the host dialog's current options without generating.
    SetOptions { options: GeneratorOptions },
    /// Check options against the generator's rules without running anything.
    ///
    /// Pure and instant, so the dialog can call it on every edit. It is a fast
    /// approximation of what [`MapGeneratorCommand::Preflight`] confirms.
    Validate { options: GeneratorOptions },
    /// Ask the generator itself to resolve the options, via `--parse`.
    ///
    /// Authoritative where [`MapGeneratorCommand::Validate`] is merely quick:
    /// it applies the rules of the *actual* release rather than our copy of
    /// them, and it yields the resulting map name. Costs a JVM start, no map.
    Preflight { options: GeneratorOptions },
    /// Decode generated map names into their parameters, without any IO.
    DecodeNames { map_names: Vec<String> },
    /// Fetch the generator's `--help` text.
    LoadHelp {
        #[serde(default)]
        version: Option<String>,
    },
    /// Stop the run in flight. Does nothing when none is.
    Cancel,
    /// Delete generated maps except stable folder names explicitly protected
    /// by the user's favorites.
    ///
    /// Generated maps are reproducible from their name, so keeping them costs
    /// disk for no benefit. The Java client does this on shutdown
    /// (`MapGeneratorService.destroy`); exposing it as a command instead lets
    /// the user decide when, which suits a client that may not exit cleanly.
    CleanUp,
}

pub fn reduce(state: &mut MapGeneratorState, event: &MapGeneratorEvent) {
    match event {
        MapGeneratorEvent::StatusChanged { status } => state.status = status.clone(),
        MapGeneratorEvent::VersionResolved { version } => {
            state.latest_version = version.clone();
            state.selected_version = Some(version.clone());
        }
        MapGeneratorEvent::VersionsLoaded { versions } => {
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
        assert!(s.option_lists.is_empty());
        assert!(!s.status.is_busy());
    }

    #[test]
    fn every_in_flight_status_reads_as_busy() {
        for status in [
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
