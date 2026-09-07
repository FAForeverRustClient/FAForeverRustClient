//! Neroxis map generator: name grammar, version policy and command line.
//!
//! FAF ladder and team-matchmaking pools contain *generated* maps: rather than
//! shipping map files, the server names a map like
//! `neroxis_map_generator_1.7.7_abcdef...` and every client reproduces it
//! locally by running the Neroxis generator JAR. The name carries everything
//! needed: the generator version and the seed: so all players deterministically
//! produce byte-identical terrain.
//!
//! This module is the pure half of that: parsing and formatting those names,
//! deciding which generator versions are usable, and building the JAR's command
//! line. The IO half (downloading the JAR from GitHub, spawning Java, scraping
//! stdout) lives in `faf-app`'s `infra::map_generator`.
//!
//! Both reference clients agree on the grammar and disagree on ambition: the
//! Python client (`mapGenerator/`) only generates a map it was handed by name,
//! while the Java client (`map/generator/`) also exposes the full option surface
//! for *creating* a map to host. Everything here supports both paths.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::map_generator_name::{MAP_SIZE_STEP, NUM_BINS, SYMMETRIES};

/// The map-name template. Lower case throughout because the server rejects
/// mixed-case map names (the Java client's `GENERATED_MAP_NAME` carries the
/// same warning).
pub const GENERATED_MAP_PREFIX: &str = "neroxis_map_generator_";

/// Generator major versions this client knows how to drive.
///
/// Mirrors the Java client's `minSupportedMajorVersion`/`maxSupportedMajorVersion`.
/// Below the minimum the command line is a different, positional shape; above
/// the maximum we cannot assume the flags still mean what we think, so both
/// directions are a hard refusal rather than a guess.
pub const MIN_SUPPORTED_MAJOR: u32 = 0;
pub const MAX_SUPPORTED_MAJOR: u32 = 1;

/// First release that answers a list flag (`--styles`, `--symmetries`) with a
/// list.
///
/// Measured against the published JARs, all run under Temurin 25: 1.3.0 and
/// older do not know the flag, and because their hand-written parser ignores
/// what it does not recognise, they *generate a map* instead of printing
/// anything. Opening the dialog on such a release would drop up to six random
/// maps into the client's working directory, so this floor is a guard against
/// a side effect as much as against an empty picker.
pub const MIN_OPTION_LIST_VERSION: GeneratorVersion = GeneratorVersion {
    major: 1,
    minor: 4,
    patch: 0,
};

/// First release with the four component styles: the `--terrain-styles` family
/// of lists, and the `--terrain-style` family of flags that set them.
///
/// Measured: 1.11.0 answers `--terrain-styles` with picocli's "Unknown
/// option", 1.12.0 lists them. Before this, a map has one whole-map `--style`
/// and nothing finer.
pub const MIN_COMPONENT_STYLE_VERSION: GeneratorVersion = GeneratorVersion {
    major: 1,
    minor: 12,
    patch: 0,
};

/// The generator's command line is not one command line: it grew flag by flag
/// over five years, and a flag sent to a release that predates it is either
/// refused outright (picocli, from 1.9.0) or silently ignored (the
/// hand-written parser before it, which then generates something other than
/// what was asked for). Every boundary below is the first release whose
/// `--help` lists the flag, read off the published JARs under Temurin 25.
///
/// `--map-size`, and with it any control over how big the map is.
pub const MIN_MAP_SIZE_VERSION: GeneratorVersion = GeneratorVersion {
    major: 1,
    minor: 1,
    patch: 0,
};

/// `--num-teams`, and the three visibility flags as a complete set
/// (`--tournament-style`, `--blind`, `--unexplored`).
pub const MIN_NUM_TEAMS_VERSION: GeneratorVersion = GeneratorVersion {
    major: 1,
    minor: 3,
    patch: 0,
};

/// `--style`, `--preview-path` and `--num-to-gen`: the same release that first
/// answers a list query, which is not a coincidence, the two arrived together.
pub const MIN_STYLE_VERSION: GeneratorVersion = MIN_OPTION_LIST_VERSION;

/// The picocli rewrite: `--out-path` replaces `--folder-path`,
/// `--num-to-generate` replaces `--num-to-gen`, and `--terrain-symmetry`,
/// `--visibility` and `--visualize` appear.
pub const MIN_MODERN_CLI_VERSION: GeneratorVersion = GeneratorVersion {
    major: 1,
    minor: 9,
    patch: 0,
};

/// First release with `--parse`, which resolves options to the map name they
/// would produce without generating anything.
///
/// Measured: 1.22.0 prints the JSON, 1.21.2 does not refuse the flag but
/// ignores it and generates a whole map instead. That is minutes of work, a
/// map folder nobody asked for, and still no name in the output, which is
/// where both "the map generator did not report a map name" and "the map
/// generator did not answer in time" come from on an older release.
pub const MIN_PARSE_VERSION: GeneratorVersion = GeneratorVersion {
    major: 1,
    minor: 22,
    patch: 0,
};

/// `--symmetries` is the one list with a hole in the middle of its history:
/// the picocli rewrite dropped it and 1.12.0 brought it back, so 1.4.0-1.8.x
/// print it, 1.9.0-1.11.x reject it, and 1.12.0 onwards print it again.
const SYMMETRY_LIST_GAP_START: GeneratorVersion = GeneratorVersion {
    major: 1,
    minor: 9,
    patch: 0,
};

/// Generators from version 1 onward take named flags; older ones take four
/// positional arguments. The Java client's `GeneratorCommand` branches on the
/// same boundary.
const NAMED_ARGUMENT_MAJOR: u32 = 1;

/// The window of generator major versions this client will drive.
///
/// A *value*, not a pair of constants, because the Java client reads its
/// `minSupportedMajorVersion`/`maxSupportedMajorVersion` from configuration,
/// FAF can widen or narrow the window without shipping a new client. Infra
/// builds one from the environment (see `infra::map_generator`); the defaults
/// match the Java client's `application.yml`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VersionPolicy {
    pub min_major: u32,
    pub max_major: u32,
}

impl Default for VersionPolicy {
    fn default() -> Self {
        Self {
            min_major: MIN_SUPPORTED_MAJOR,
            max_major: MAX_SUPPORTED_MAJOR,
        }
    }
}

impl VersionPolicy {
    /// Whether a major version is inside the window. Expressed as range
    /// containment rather than two comparisons so it stays correct (and
    /// lint-clean) when `min_major` is 0.
    pub fn allows_major(&self, major: u32) -> bool {
        (self.min_major..=self.max_major).contains(&major)
    }

    /// Where a version sits relative to the window.
    ///
    /// The `Outdated` arm is unreachable while `min_major` is 0: as it is by
    /// default, matching the Java client's configuration. It is kept because
    /// FAF has raised that floor before, and because the window is now
    /// configurable, so a deployment can make it reachable.
    pub fn support(&self, version: GeneratorVersion) -> VersionSupport {
        if self.allows_major(version.major) {
            VersionSupport::Supported
        } else if version.major > self.max_major {
            VersionSupport::TooNew
        } else {
            VersionSupport::Outdated
        }
    }
}

/// How long a generation run may take before it is presumed hung. The Java
/// client uses the same three minutes; large maps on slow machines genuinely
/// approach it.
pub const GENERATION_TIMEOUT_SECONDS: u64 = 180;

/// The generator flag that opens an interactive viewer window.
///
/// A run with this flag stays alive on purpose: the user is looking at it,
/// so the timeout must not kill it. Reachable here through the raw
/// command-line passthrough, which is exactly how the Java client's users
/// reach it too.
const VISUALIZE_FLAG: &str = "--visualize";

/// Whether a built argument list opts out of the generation timeout.
///
/// Mirrors the Java client's `GenerateMapTask`, which skips its forced kill
/// when the command line contains `--visualize`. Without this, asking the
/// generator to show its viewer would reliably "fail" after three minutes and
/// have the window killed underneath you.
pub fn runs_without_timeout(args: &[String]) -> bool {
    args.iter().any(|arg| arg == VISUALIZE_FLAG)
}

/// A parsed `x.y.z` generator version. Ordered numerically, not lexically,
/// `1.10.0` is newer than `1.9.0`, which a string comparison gets wrong.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Serialize, Deserialize, Type,
)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl GeneratorVersion {
    /// Parse `1.7.7`. Each component is 1–3 digits, matching both clients'
    /// `\d\d?\d?\.\d\d?\d?\.\d\d?\d?`.
    pub fn parse(value: &str) -> Option<Self> {
        let mut parts = value.split('.');
        let mut next = || {
            let part = parts.next()?;
            if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            part.parse::<u32>().ok()
        };
        let major = next()?;
        let minor = next()?;
        let patch = next()?;
        if parts.next().is_some() {
            return None;
        }
        Some(Self {
            major,
            minor,
            patch,
        })
    }

    /// Where this version sits under the default policy. Callers that honour a
    /// configured window use [`VersionPolicy::support`] instead.
    pub fn support(self) -> VersionSupport {
        VersionPolicy::default().support(self)
    }

    /// Whether the map size can be chosen at all. 1.0.x generates whatever
    /// size it likes.
    pub fn supports_map_size(self) -> bool {
        self >= MIN_MAP_SIZE_VERSION
    }

    /// Whether teams, and the visibility presets, can be asked for.
    pub fn supports_num_teams(self) -> bool {
        self >= MIN_NUM_TEAMS_VERSION
    }

    /// Whether a whole-map style and a preview path can be asked for.
    pub fn supports_style(self) -> bool {
        self >= MIN_STYLE_VERSION
    }

    /// Whether this release has the picocli command line: `--out-path`,
    /// `--terrain-symmetry`, `--visualize` and the rest.
    pub fn uses_modern_cli(self) -> bool {
        self >= MIN_MODERN_CLI_VERSION
    }

    /// Where the generated map goes. Every release understands
    /// `--folder-path`; only the picocli ones understand `--out-path`, which
    /// is the name their own help gives.
    pub fn output_path_flag(self) -> &'static str {
        if self.uses_modern_cli() {
            "--out-path"
        } else {
            "--folder-path"
        }
    }

    /// 1.0.x refuses to start without an output folder: its `--folder-path` is
    /// documented "mandatory", and every later release makes it optional.
    pub fn requires_output_path(self) -> bool {
        self < MIN_MAP_SIZE_VERSION
    }

    /// How this release spells "generate several maps", if it can at all.
    pub fn map_count_flag(self) -> Option<&'static str> {
        if self.uses_modern_cli() {
            Some("--num-to-generate")
        } else if self.supports_style() {
            Some("--num-to-gen")
        } else {
            None
        }
    }

    /// Whether this release can resolve options to a map name without
    /// generating one. See [`MIN_PARSE_VERSION`] for what happens if it is
    /// asked anyway.
    pub fn supports_parse(self) -> bool {
        self >= MIN_PARSE_VERSION
    }

    /// Whether this release takes the four component-style flags. Older ones
    /// understand `--style` alone; see [`MIN_COMPONENT_STYLE_VERSION`].
    pub fn supports_component_styles(self) -> bool {
        self >= MIN_COMPONENT_STYLE_VERSION
    }

    /// Whether this version takes named flags rather than positional arguments.
    pub fn uses_named_arguments(self) -> bool {
        self.major >= NAMED_ARGUMENT_MAJOR
    }

    /// The release asset name GitHub serves for this version.
    pub fn jar_name(self) -> String {
        format!("NeroxisGen_{self}.jar")
    }

    /// The filename this client caches the JAR under. Version-stamped so
    /// several generators can coexist: joining an old lobby must not force a
    /// re-download of a version you already had.
    pub fn cached_jar_name(self) -> String {
        format!("MapGenerator_{self}.jar")
    }
}

impl std::fmt::Display for GeneratorVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum VersionSupport {
    Supported,
    /// Older than this client knows how to drive.
    Outdated,
    /// Newer than this client knows how to drive: update the client.
    TooNew,
}

/// A generated map name split into its parts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedMapName {
    pub version: GeneratorVersion,
    /// Everything after the version: the seed, or an option digest, depending
    /// on how the map was produced. Passed back to the generator verbatim.
    pub seed: String,
}

/// Parse `neroxis_map_generator_<version>_<seed>`, or `None` if `name` is not a
/// generated map. Case-insensitive on the prefix because map folders on disk
/// have been seen with mixed case even though the server lower-cases them.
pub fn parse_generated_map_name(name: &str) -> Option<GeneratedMapName> {
    let rest = name
        .get(..GENERATED_MAP_PREFIX.len())
        .filter(|prefix| prefix.eq_ignore_ascii_case(GENERATED_MAP_PREFIX))
        .map(|_| &name[GENERATED_MAP_PREFIX.len()..])?;

    let (version, seed) = rest.split_once('_')?;
    if seed.is_empty() {
        return None;
    }
    Some(GeneratedMapName {
        version: GeneratorVersion::parse(version)?,
        seed: seed.to_string(),
    })
}

/// Whether `name` is a generated map. Cheap wrapper over
/// [`parse_generated_map_name`] for call sites that only need the predicate,
/// the Java client's `isGeneratedMap`, the Python client's `isGeneratedMap`.
pub fn is_generated_map(name: &str) -> bool {
    parse_generated_map_name(name).is_some()
}

/// The preset "flavours" the Java client offers. Each is a single generator
/// flag that overrides the fine-grained style options, which is why they are
/// modeled as an enum rather than as more booleans.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GenerationType {
    /// The default; honours every style/density option below.
    #[default]
    Casual,
    /// `--tournament-style`: no preview, so nobody can scout the map in advance.
    Tournament,
    /// `--blind`: players get no preview at all.
    Blind,
    /// `--unexplored`: the map starts unexplored, fog and all.
    Unexplored,
}

impl GenerationType {
    /// The generator flag, or `None` for [`GenerationType::Casual`], which is
    /// the absence of a flag rather than a flag of its own.
    pub fn flag(self) -> Option<&'static str> {
        match self {
            GenerationType::Casual => None,
            GenerationType::Tournament => Some("--tournament-style"),
            GenerationType::Blind => Some("--blind"),
            GenerationType::Unexplored => Some("--unexplored"),
        }
    }
}

/// Everything the host-a-generated-map flow can specify.
///
/// Mirrors the Java client's `GeneratorOptions` record. `None`
/// means "let the generator decide", which is not the same as a default value,
/// omitting `--style` lets the generator pick one, while passing a style pins it.
// No `Eq`: the density fields are `f32`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorOptions {
    /// Specific generator version to run (e.g. "1.15.2"), or None for latest.
    #[serde(default)]
    pub version: Option<String>,
    /// Total spawn points. The generator requires this together with
    /// `num_teams` and `map_size`.
    pub spawn_count: Option<u32>,
    pub num_teams: Option<u32>,
    /// Map size in generator units (512 = 10 km, the engine's standard map).
    pub map_size: Option<u32>,
    /// Fixed seed, for reproducing a specific map.
    pub seed: String,
    pub generation_type: GenerationType,
    #[serde(default)]
    pub symmetry: String,
    #[serde(default)]
    pub symmetries: Vec<String>,
    /// A whole-map style preset. Mutually exclusive with the four
    /// component styles below: the generator ignores those when a style is set,
    /// so the command builder stops after emitting it.
    #[serde(default)]
    pub style: String,
    #[serde(default)]
    pub styles: Vec<String>,
    #[serde(default)]
    pub terrain_style: String,
    #[serde(default)]
    pub terrain_styles: Vec<String>,
    #[serde(default)]
    pub texture_style: String,
    #[serde(default)]
    pub texture_styles: Vec<String>,
    #[serde(default)]
    pub resource_style: String,
    #[serde(default)]
    pub resource_styles: Vec<String>,
    #[serde(default)]
    pub prop_style: String,
    #[serde(default)]
    pub prop_styles: Vec<String>,
    /// Reclaim density as a *bin index*, 0–127.
    ///
    /// The generator's flag takes 0.0–1.0 and rejects anything above it
    /// ("Must be between 0 and 1"). 127 is its `NUM_BINS`, the resolution it
    /// discretises to, not the scale. Both reference clients keep a coarser
    /// unit in the UI and convert on the way out (Java divides by 127, Python
    /// by 100); [`build_arguments`] does the same, so this field stays in the
    /// bin units the sliders speak.
    pub reclaim_density: Option<f32>,
    #[serde(default)]
    pub reclaim_density_min: Option<f32>,
    #[serde(default)]
    pub reclaim_density_max: Option<f32>,
    pub resource_density: Option<f32>,
    #[serde(default)]
    pub resource_density_min: Option<f32>,
    #[serde(default)]
    pub resource_density_max: Option<f32>,
    /// Generate several maps in one run (`--num-to-generate`).
    pub num_to_generate: Option<u32>,
    /// `--debug`: writes `debug/pipelineMaskHashes.txt` and prints the resolved
    /// parameters. The generator ignores it for tournament and blind maps,
    /// which is why it is not offered alongside those.
    #[serde(default)]
    pub debug: bool,
    /// `--visualize`: opens the generator's mask viewer. The run then stays
    /// alive on purpose, so it is exempt from the generation timeout: see
    /// [`runs_without_timeout`].
    #[serde(default)]
    pub visualize: bool,
    /// `--preview-path`: where to drop preview PNGs, separately from the map
    /// folder. Saves guessing at preview filenames on the way back out.
    /// Casual maps only; tournament and blind maps have no preview by design.
    #[serde(default)]
    pub preview_path: String,
    /// `--out-path`: where the map folder is written. Empty means "the working
    /// directory", which is how all three clients drive it by default.
    #[serde(default)]
    pub output_path: String,
    /// Raw passthrough. When set it replaces every other option: the escape
    /// hatch both clients keep for generator flags newer than the client.
    pub command_line_args: String,
}

impl Default for GeneratorOptions {
    fn default() -> Self {
        Self {
            // The Java client's `GeneratorPrefs` defaults.
            version: None,
            spawn_count: Some(6),
            num_teams: Some(2),
            map_size: Some(512),
            seed: String::new(),
            generation_type: GenerationType::Casual,
            symmetry: String::new(),
            symmetries: Vec::new(),
            style: String::new(),
            styles: Vec::new(),
            terrain_style: String::new(),
            terrain_styles: Vec::new(),
            texture_style: String::new(),
            texture_styles: Vec::new(),
            resource_style: String::new(),
            resource_styles: Vec::new(),
            prop_style: String::new(),
            prop_styles: Vec::new(),
            reclaim_density: None,
            reclaim_density_min: None,
            reclaim_density_max: None,
            resource_density: None,
            resource_density_min: None,
            resource_density_max: None,
            num_to_generate: None,
            debug: false,
            visualize: false,
            preview_path: String::new(),
            output_path: String::new(),
            command_line_args: String::new(),
        }
    }
}

/// What went wrong building a command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandError {
    /// `map_size`, `spawn_count` or `num_teams` missing for an options-driven run.
    MissingParameters,
    /// The generator version is outside [`MIN_SUPPORTED_MAJOR`]..=[`MAX_SUPPORTED_MAJOR`].
    UnsupportedVersion(VersionSupport),
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CommandError::MissingParameters => write!(
                f,
                "map size, spawn count and team count are all required to generate a map"
            ),
            CommandError::UnsupportedVersion(VersionSupport::Outdated) => write!(
                f,
                "this map needs a map generator older than this client supports"
            ),
            CommandError::UnsupportedVersion(_) => write!(
                f,
                "this map needs a newer map generator than this client supports: update the client"
            ),
        }
    }
}

/// Keep only the entries that pass, unless that would leave nothing.
///
/// Filtering a user's selection down to zero and then silently generating
/// something unrelated would be worse than honouring an imperfect choice: if
/// nothing fits, hand back the original list and let the generator (or
/// [`validate_options`]) have the final word.
fn retain_or_keep(values: &[String], keep: impl Fn(&str) -> bool) -> Vec<String> {
    let filtered: Vec<String> = values.iter().filter(|value| keep(value)).cloned().collect();
    if filtered.is_empty() {
        values.to_vec()
    } else {
        filtered
    }
}

fn pick_choice(single: &str, multi: &[String], seed_str: &str) -> Option<String> {
    if !single.is_empty() {
        return Some(single.to_string());
    }
    if multi.is_empty() {
        return None;
    }
    if multi.len() == 1 {
        return multi.first().cloned();
    }
    let seed_num: u64 = seed_str.parse().unwrap_or_else(|_| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    });
    let idx = (seed_num as usize) % multi.len();
    multi.get(idx).cloned()
}

fn pick_density(
    single: Option<f32>,
    min: Option<f32>,
    max: Option<f32>,
    seed_str: &str,
) -> Option<f32> {
    if let Some(val) = single {
        return Some(val);
    }
    match (min, max) {
        (Some(a), Some(b)) if (a - b).abs() < f32::EPSILON => Some(a),
        (Some(a), Some(b)) => {
            let low = a.min(b);
            let high = a.max(b);
            let seed_num: u64 = seed_str.parse().unwrap_or_else(|_| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            });
            let frac = ((seed_num.wrapping_mul(6364136223846793005).wrapping_add(1) >> 32) as u32
                % 1000) as f32
                / 1000.0;
            Some(low + frac * (high - low))
        }
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

/// Build the generator's arguments (everything after `java -jar <jar>`).
///
/// Reproduces the Java client's `GeneratorCommand.getCommand()` including its
/// early returns, which are load-bearing: several options *replace* the rest of
/// the command rather than adding to it.
pub fn build_arguments(
    version: GeneratorVersion,
    map_name: Option<&str>,
    options: &GeneratorOptions,
    policy: VersionPolicy,
) -> Result<Vec<String>, CommandError> {
    // Refused here rather than at the download site so *every* path: join,
    // host, option query: is gated by the same check, and so nothing is
    // downloaded for a generator we could not drive anyway.
    let support = policy.support(version);
    if support != VersionSupport::Supported {
        return Err(CommandError::UnsupportedVersion(support));
    }

    // Pre-1.0 generators take four positional arguments and understand nothing
    // else. Only the reproduce-by-name path can reach them in practice.
    if !version.uses_named_arguments() {
        return Ok(vec![
            ".".to_string(),
            options.seed.clone(),
            version.to_string(),
            map_name.unwrap_or_default().to_string(),
        ]);
    }

    // Raw passthrough wins over everything.
    if !options.command_line_args.is_empty() {
        return Ok(split_command_line(&options.command_line_args));
    }

    // Reproducing a known map: the name alone determines the terrain.
    if let Some(name) = map_name {
        let mut args = vec!["--map-name".to_string(), name.to_string()];
        if !options.preview_path.is_empty() && version.supports_style() {
            args.push("--preview-path".to_string());
            args.push(options.preview_path.clone());
        }
        // Except on 1.0.x, which will not start without being told where to
        // write. The run's working directory is the maps folder, so "." is
        // the same place every other release would have chosen by itself.
        if version.requires_output_path() {
            args.push("--folder-path".to_string());
            args.push(".".to_string());
        }
        return Ok(args);
    }

    let (Some(size), Some(spawns), Some(teams)) =
        (options.map_size, options.spawn_count, options.num_teams)
    else {
        return Err(CommandError::MissingParameters);
    };

    // Only the parts of the triple this release has a flag for. A spawn count
    // is the one every version back to 1.0.0 understands.
    let mut args = Vec::new();
    if version.supports_map_size() {
        args.push("--map-size".to_string());
        args.push(size.to_string());
    }
    args.push("--spawn-count".to_string());
    args.push(spawns.to_string());
    if version.supports_num_teams() {
        args.push("--num-teams".to_string());
        args.push(teams.to_string());
    }
    if version.requires_output_path() && options.output_path.is_empty() {
        args.push("--folder-path".to_string());
        args.push(".".to_string());
    }

    // Paths and diagnostics sit outside the style/visibility exclusivity, so
    // they are emitted before the early returns below rather than after: a
    // tournament map still gets written where the caller asked for it.
    if !options.output_path.is_empty() {
        args.push(version.output_path_flag().to_string());
        args.push(options.output_path.clone());
    }
    if options.debug {
        args.push("--debug".to_string());
    }
    // The viewer window is picocli-era. Older releases have no such flag, and
    // the ones that ignore it would go on to generate without it anyway.
    if options.visualize && version.uses_modern_cli() {
        args.push("--visualize".to_string());
    }

    // A fixed seed pins the terrain, so asking for several maps would produce
    // several *identical* ones. The Java client resolves the same conflict in
    // `GenerateMapController.onGenerateMap`, which forces its map count to 1
    // whenever a seed is set.
    if options.seed.is_empty() {
        if let (Some(count), Some(flag)) = (
            options.num_to_generate.filter(|n| *n > 1),
            version.map_count_flag(),
        ) {
            args.push(flag.to_string());
            args.push(count.to_string());
        }
    }

    // A generation type is a whole-map preset: it replaces the style and
    // density options rather than combining with them. Before 1.3.0 the set is
    // incomplete, and a preset silently downgraded to an ordinary map would be
    // worse than one that was never offered.
    if let Some(flag) = options.generation_type.flag() {
        if version.supports_num_teams() {
            args.push(flag.to_string());
        }
        return Ok(args);
    }

    // Only reachable for casual maps, which is the only kind that has a
    // preview: tournament, blind and unexplored maps deliberately have none,
    // and the generator skips the export for them anyway.
    if !options.preview_path.is_empty() && version.supports_style() {
        args.push("--preview-path".to_string());
        args.push(options.preview_path.clone());
    }

    let mut push_flag = |flag: &str, value: &str| {
        if !value.is_empty() {
            args.push(flag.to_string());
            args.push(value.to_string());
        }
    };
    push_flag("--seed", &options.seed);

    // Narrow the candidates to those that can actually make this many teams
    // before picking. Both reference clients pick uniformly from everything the
    // user checked, so a `POINT3` sitting in a list alongside `POINT4` makes a
    // two-team run fail at random, roughly half the time, with no clue why.
    let symmetries = retain_or_keep(&options.symmetries, |symmetry| {
        symmetry_fits_teams(symmetry, teams)
    });
    if let Some(symmetry) = pick_choice(&options.symmetry, &symmetries, &options.seed) {
        // Named `--symmetry` in 1.1 and 1.2 and absent either side of that, but
        // those releases cannot list their symmetries either, so there is
        // nothing for a user to have picked.
        if version.uses_modern_cli() {
            push_flag("--terrain-symmetry", &symmetry);
        }
    }

    // A whole-map style likewise supersedes the four component styles. Styles
    // designed for a different map shape are deprioritised the same way, so a
    // mixed selection lands on one that suits the size actually chosen.
    let styles = retain_or_keep(&options.styles, |style| {
        style_constraints(style).matches(size, spawns, teams)
    });
    if let Some(style) = pick_choice(&options.style, &styles, &options.seed) {
        if version.supports_style() {
            args.push("--style".to_string());
            args.push(style);
        }
        return Ok(args);
    }

    // Everything past here is a flag the component-style releases introduced.
    // Sending one to an older generator either fails the run outright (picocli
    // refuses an unknown option) or, worse, is silently ignored by the
    // hand-written parser, so the map that comes back is not the map that was
    // asked for. Falling back to the release's defaults is the honest option.
    if !version.supports_component_styles() {
        return Ok(args);
    }

    if let Some(terrain) = pick_choice(
        &options.terrain_style,
        &options.terrain_styles,
        &options.seed,
    ) {
        push_flag("--terrain-style", &terrain);
    }
    if let Some(texture) = pick_choice(
        &options.texture_style,
        &options.texture_styles,
        &options.seed,
    ) {
        push_flag("--texture-style", &texture);
    }
    if let Some(resource) = pick_choice(
        &options.resource_style,
        &options.resource_styles,
        &options.seed,
    ) {
        push_flag("--resource-style", &resource);
    }
    if let Some(prop) = pick_choice(&options.prop_style, &options.prop_styles, &options.seed) {
        push_flag("--prop-style", &prop);
    }

    if let Some(density) = pick_density(
        options.resource_density,
        options.resource_density_min,
        options.resource_density_max,
        &options.seed,
    ) {
        args.push("--resource-density".to_string());
        args.push(format_density(density));
    }
    if let Some(density) = pick_density(
        options.reclaim_density,
        options.reclaim_density_min,
        options.reclaim_density_max,
        &options.seed,
    ) {
        args.push("--reclaim-density".to_string());
        args.push(format_density(density));
    }

    Ok(args)
}

/// Render a bin-index density (0–127) as the 0.0–1.0 fraction the generator's
/// flag actually takes.
///
/// The generator's own help is explicit: "Reclaim density for the generated
/// map. Min: 0 Max: 1", and its converter throws `Must be between 0 and 1` for
/// anything larger. Passing the bin index straight through makes every
/// custom-style run fail the moment a user touches a density slider, which is
/// exactly the bug this function exists to prevent. Both reference clients do
/// the same conversion at the same point: Java divides by 127, Python by 100.
fn format_density(bin: f32) -> String {
    let fraction = (bin / NUM_BINS as f32).clamp(0.0, 1.0);
    // Trimmed to the generator's own resolution: more digits would survive the
    // round trip through the map name as noise, since it re-bins on the way in.
    format!("{fraction:.6}")
}

/// Split a raw command line the way a shell would.
///
/// Honours single and double quotes so a path with spaces survives, which
/// `split_whitespace` does not: `--out-path "C:\Users\Max Mustermann\maps"`
/// would otherwise arrive as four arguments and the generator would write the
/// map somewhere unexpected. The Python client reaches the same place with
/// `shlex.split`; the Java client has the naive `split(" ")` and the bug.
///
/// Backslashes are left alone rather than treated as escapes: the users of this
/// field are on Windows, typing Windows paths, and `C:\maps` must not become
/// `C:maps`.
pub fn split_command_line(input: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut has_token = false;

    for ch in input.chars() {
        match quote {
            Some(open) if ch == open => quote = None,
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
                // An empty quoted string is still an argument.
                has_token = true;
            }
            None if ch.is_whitespace() => {
                if has_token {
                    args.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            None => {
                current.push(ch);
                has_token = true;
            }
        }
    }
    if has_token {
        args.push(current);
    }
    args
}

// ---------------------------------------------------------------------------
// Validation
//
// The generator refuses several parameter combinations outright, and it does so
// *after* the client has resolved a release, downloaded a JAR and started a
// JVM. Catching them here turns a minute-long round trip ending in a stack
// trace into an inline message. Every rule below mirrors one the generator
// enforces in `MapGeneratorCommand.checkParameters`, `GeneratorParameters` or
// `MapNameParameters`, and each is covered by a test naming the exact message
// the real JAR produces.
//
// This is a fast pre-check, not the authority. `--parse` asks the generator
// itself and stays correct across releases; see `MapGeneratorPort::parse`.
// ---------------------------------------------------------------------------

/// Widest values the generator accepts, from its `ParameterConstraints`.
pub const MAX_SPAWN_COUNT: u32 = 16;
pub const MAX_NUM_TEAMS: u32 = 16;
pub const MAX_MAP_SIZE: u32 = 2048;

/// Team count meaning "no teams at all": an asymmetric map.
///
/// Not a placeholder for "unset". The generator documents it as
/// "0 is no teams asymmetric" and switches off every team-related rule for it,
/// which is why each check below is guarded on it.
pub const ASYMMETRIC_TEAMS: u32 = 0;

/// How many symmetry points a named terrain symmetry has, or `None` if this
/// client has never heard of it.
///
/// Unknown symmetries return `None` and are then treated as acceptable: a
/// generator release that adds one must not make it unselectable here.
pub fn symmetry_points(symmetry: &str) -> Option<u32> {
    SYMMETRIES
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(symmetry))
        .map(|(_, points)| *points)
}

/// Whether a terrain symmetry can produce the requested number of teams.
///
/// `POINT3` has three symmetry points and so cannot make two teams; `XZ` has
/// two and cannot make four. Unknown symmetries pass.
pub fn symmetry_fits_teams(symmetry: &str, num_teams: u32) -> bool {
    if num_teams == ASYMMETRIC_TEAMS {
        return true;
    }
    symmetry_points(symmetry).is_none_or(|points| points % num_teams == 0)
}

/// The size, spawn and team window a whole-map style is designed for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StyleConstraints {
    pub min_map_size: u32,
    pub max_map_size: u32,
    pub min_spawn_count: u32,
    pub max_spawn_count: u32,
    pub min_num_teams: u32,
    pub max_num_teams: u32,
}

impl Default for StyleConstraints {
    /// `ParameterConstraints.ANY`: the generator's own unconstrained default.
    fn default() -> Self {
        Self {
            min_map_size: 0,
            max_map_size: MAX_MAP_SIZE,
            min_spawn_count: 0,
            max_spawn_count: MAX_SPAWN_COUNT,
            min_num_teams: 0,
            max_num_teams: MAX_NUM_TEAMS,
        }
    }
}

impl StyleConstraints {
    const fn sizes(min: u32, max: u32) -> Self {
        Self {
            min_map_size: min,
            max_map_size: max,
            min_spawn_count: 0,
            max_spawn_count: MAX_SPAWN_COUNT,
            min_num_teams: 0,
            max_num_teams: MAX_NUM_TEAMS,
        }
    }

    const fn with_teams(mut self, min: u32, max: u32) -> Self {
        self.min_num_teams = min;
        self.max_num_teams = max;
        self
    }

    const fn with_spawns(mut self, min: u32, max: u32) -> Self {
        self.min_spawn_count = min;
        self.max_spawn_count = max;
        self
    }

    /// Whether this style is designed for the given shape of map.
    pub fn matches(&self, map_size: u32, spawn_count: u32, num_teams: u32) -> bool {
        (self.min_map_size..=self.max_map_size).contains(&map_size)
            && (self.min_spawn_count..=self.max_spawn_count).contains(&spawn_count)
            && (self.min_num_teams..=self.max_num_teams).contains(&num_teams)
    }
}

/// Per-style parameter windows, from each `MapStyle.Predefined` constant.
///
/// The generator applies these only when it picks a style *at random*: an
/// explicitly requested style is used whatever the map shape, which is how you
/// end up asking for `BIG_ISLANDS` on a 5 km map and getting something that is
/// neither big nor islands. Surfacing the window is therefore genuinely new;
/// no reference client shows it.
///
/// Styles absent from this table are unconstrained. That also makes the table
/// safe to be out of date: a new style simply has no advice attached.
pub fn style_constraints(style: &str) -> StyleConstraints {
    match style.to_ascii_uppercase().as_str() {
        "BIG_ISLANDS" | "SMALL_ISLANDS" => StyleConstraints::sizes(768, 1024),
        "LAND_BRIDGE" => StyleConstraints::sizes(768, 1024).with_teams(2, 4),
        "CENTER_LAKE" | "FLOODED" | "ONE_ISLAND" | "VALLEY" => StyleConstraints::sizes(384, 1024),
        "MOUNTAIN_RANGE" => StyleConstraints::sizes(256, 640),
        "LOW_MEX" => StyleConstraints::sizes(256, 640)
            .with_spawns(0, 4)
            .with_teams(2, 2),
        "SETONISH" => StyleConstraints::sizes(512, 1024).with_teams(2, 2),
        _ => StyleConstraints::default(),
    }
}

/// A parameter combination the generator will reject, or advise against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "payload", rename_all = "camelCase")]
pub enum ValidationIssue {
    /// The generator aborts: spawns must divide evenly among teams.
    #[serde(rename_all = "camelCase")]
    SpawnsNotDivisibleByTeams { spawn_count: u32, num_teams: u32 },
    /// The generator aborts: map size is stored as 64-unit steps.
    #[serde(rename_all = "camelCase")]
    MapSizeNotAMultiple { map_size: u32 },
    /// The generator aborts: no selected symmetry can make this many teams.
    #[serde(rename_all = "camelCase")]
    SymmetryIncompatible {
        symmetries: Vec<String>,
        num_teams: u32,
    },
    /// Outside the generator's accepted range.
    #[serde(rename_all = "camelCase")]
    OutOfRange {
        field: String,
        value: u32,
        min: u32,
        max: u32,
    },
    /// Accepted, but the style was not designed for this map shape, so the
    /// result will not look like its name. A warning, not a refusal.
    #[serde(rename_all = "camelCase")]
    StyleOutsideItsRange {
        style: String,
        constraints: StyleConstraints,
    },
    /// The generator's `--seed` is a signed 64-bit integer; anything else is a
    /// type-conversion failure before generation starts.
    #[serde(rename_all = "camelCase")]
    SeedNotAnInteger { seed: String },
}

impl ValidationIssue {
    /// Whether the generator would refuse outright, as opposed to producing
    /// something disappointing. The UI blocks on the former only.
    pub fn is_fatal(&self) -> bool {
        !matches!(self, ValidationIssue::StyleOutsideItsRange { .. })
    }
}

impl std::fmt::Display for ValidationIssue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // Worded as the generator words it, so a user who sees both
            // recognises them as the same complaint.
            ValidationIssue::SpawnsNotDivisibleByTeams {
                spawn_count,
                num_teams,
            } => write!(
                f,
                "spawn count {spawn_count} is not a multiple of {num_teams} teams"
            ),
            ValidationIssue::MapSizeNotAMultiple { map_size } => write!(
                f,
                "map size {map_size} is not a multiple of {MAP_SIZE_STEP}"
            ),
            ValidationIssue::SymmetryIncompatible {
                symmetries,
                num_teams,
            } => write!(
                f,
                "terrain symmetry {} is not compatible with {num_teams} teams",
                symmetries.join(", ")
            ),
            ValidationIssue::OutOfRange {
                field,
                value,
                min,
                max,
            } => write!(
                f,
                "{field} {value} is outside the allowed range {min}-{max}"
            ),
            ValidationIssue::StyleOutsideItsRange { style, constraints } => write!(
                f,
                "{style} is designed for maps of {}-{} units with {}-{} teams",
                constraints.min_map_size,
                constraints.max_map_size,
                constraints.min_num_teams,
                constraints.max_num_teams
            ),
            ValidationIssue::SeedNotAnInteger { seed } => {
                write!(f, "the seed {seed} is not a whole number")
            }
        }
    }
}

/// Check an options set against every rule the generator enforces.
///
/// Returns all issues rather than the first, so the dialog can show everything
/// wrong at once instead of making the user fix one thing to discover the next.
/// An empty result does not *guarantee* the generator will accept the run: it
/// guarantees only that none of the known rules are broken.
///
/// Raw command-line arguments bypass every option, so they bypass this too:
/// somebody typing flags by hand has opted out of our help.
pub fn validate_options(options: &GeneratorOptions) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    if !options.command_line_args.is_empty() {
        return issues;
    }

    let spawn_count = options.spawn_count.unwrap_or(0);
    let num_teams = options.num_teams.unwrap_or(0);
    let map_size = options.map_size.unwrap_or(0);

    let mut range = |field: &str, value: u32, min: u32, max: u32| {
        if !(min..=max).contains(&value) {
            issues.push(ValidationIssue::OutOfRange {
                field: field.to_string(),
                value,
                min,
                max,
            });
        }
    };
    range("spawn count", spawn_count, 0, MAX_SPAWN_COUNT);
    range("team count", num_teams, 0, MAX_NUM_TEAMS);
    range("map size", map_size, MAP_SIZE_STEP, MAX_MAP_SIZE);

    if !map_size.is_multiple_of(MAP_SIZE_STEP) {
        issues.push(ValidationIssue::MapSizeNotAMultiple { map_size });
    }
    // `is_multiple_of` rather than `%`: the range check above records an issue
    // without returning, so a zero team count reaches here, and `% 0` panics.
    if num_teams != ASYMMETRIC_TEAMS && !spawn_count.is_multiple_of(num_teams) {
        issues.push(ValidationIssue::SpawnsNotDivisibleByTeams {
            spawn_count,
            num_teams,
        });
    }

    // A visibility preset replaces the whole casual branch, so none of the
    // style, seed or symmetry rules below apply to it.
    if options.generation_type != GenerationType::Casual {
        return issues;
    }

    let seed = options.seed.trim();
    if !seed.is_empty() && seed.parse::<i64>().is_err() {
        issues.push(ValidationIssue::SeedNotAnInteger {
            seed: seed.to_string(),
        });
    }

    // Several symmetries may be selected, and the command builder picks a
    // compatible one. Only complain when *none* of them can work.
    let selected: Vec<String> = if !options.symmetry.is_empty() {
        vec![options.symmetry.clone()]
    } else {
        options.symmetries.clone()
    };
    if !selected.is_empty()
        && !selected
            .iter()
            .any(|symmetry| symmetry_fits_teams(symmetry, num_teams))
    {
        issues.push(ValidationIssue::SymmetryIncompatible {
            symmetries: selected,
            num_teams,
        });
    }

    // Style advice is per selected style; with several selected, warn only if
    // every one of them is a poor fit, since the builder picks among them.
    let styles: Vec<String> = if !options.style.is_empty() {
        vec![options.style.clone()]
    } else {
        options.styles.clone()
    };
    if !styles.is_empty()
        && !styles
            .iter()
            .any(|style| style_constraints(style).matches(map_size, spawn_count, num_teams))
    {
        let style = styles[0].clone();
        issues.push(ValidationIssue::StyleOutsideItsRange {
            constraints: style_constraints(&style),
            style,
        });
    }

    issues
}

/// Which option list to ask the generator for. The Java client runs the JAR
/// once per list with these exact flags and reads the answers off stdout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GeneratorOptionQuery {
    Symmetries,
    Styles,
    TerrainStyles,
    TextureStyles,
    ResourceStyles,
    PropStyles,
}

impl GeneratorOptionQuery {
    pub fn flag(self) -> &'static str {
        match self {
            GeneratorOptionQuery::Symmetries => "--symmetries",
            GeneratorOptionQuery::Styles => "--styles",
            GeneratorOptionQuery::TerrainStyles => "--terrain-styles",
            GeneratorOptionQuery::TextureStyles => "--texture-styles",
            GeneratorOptionQuery::ResourceStyles => "--resource-styles",
            GeneratorOptionQuery::PropStyles => "--prop-styles",
        }
    }

    /// Whether `version` answers this list flag.
    ///
    /// Asking a release that does not is worse than useless: the pre-picocli
    /// parser ignores the flag and generates a map instead of refusing, and
    /// picocli releases fail the query outright. Both end with an empty picker
    /// and no way for the user to tell why, which is exactly what selecting an
    /// old release used to look like.
    pub fn supported_by(self, version: GeneratorVersion) -> bool {
        match self {
            GeneratorOptionQuery::Styles => version >= MIN_OPTION_LIST_VERSION,
            GeneratorOptionQuery::Symmetries => {
                version >= MIN_OPTION_LIST_VERSION
                    && !(version >= SYMMETRY_LIST_GAP_START
                        && version < MIN_COMPONENT_STYLE_VERSION)
            }
            GeneratorOptionQuery::TerrainStyles
            | GeneratorOptionQuery::TextureStyles
            | GeneratorOptionQuery::ResourceStyles
            | GeneratorOptionQuery::PropStyles => version.supports_component_styles(),
        }
    }

    pub const ALL: [GeneratorOptionQuery; 6] = [
        GeneratorOptionQuery::Symmetries,
        GeneratorOptionQuery::Styles,
        GeneratorOptionQuery::TerrainStyles,
        GeneratorOptionQuery::TextureStyles,
        GeneratorOptionQuery::ResourceStyles,
        GeneratorOptionQuery::PropStyles,
    ];
}

/// Pull generated map names out of a line of generator output.
///
/// The generator announces each map it writes; both reference clients scrape
/// stdout for the same pattern rather than predicting the name, because with
/// `--num-to-generate` the client cannot know the seeds in advance.
pub fn scrape_map_names(line: &str) -> Vec<String> {
    let lower = line.to_lowercase();
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(offset) = lower[from..].find(GENERATED_MAP_PREFIX) {
        let start = from + offset;
        // A map name runs until whitespace or a character no folder name uses.
        let end = lower[start..]
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',')
            .map(|i| start + i)
            .unwrap_or(lower.len());
        let candidate = lower[start..end].trim_end_matches(['.', ':', ')']);
        if is_generated_map(candidate) {
            found.push(candidate.to_string());
        }
        from = end.max(start + 1);
    }
    found
}

/// Filter the option list the generator prints.
///
/// The JAR emits headings alongside the values; the Java client's
/// `GeneratorOptionsTask` keeps only lines without a colon, which is exactly
/// what separates a value from a heading here.
pub fn parse_option_list(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.contains(':'))
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(major: u32, minor: u32, patch: u32) -> GeneratorVersion {
        GeneratorVersion {
            major,
            minor,
            patch,
        }
    }

    #[test]
    fn parses_a_generated_map_name() {
        let parsed = parse_generated_map_name("neroxis_map_generator_1.7.7_abcdef").unwrap();
        assert_eq!(parsed.version, version(1, 7, 7));
        assert_eq!(parsed.seed, "abcdef");
    }

    #[test]
    fn seeds_may_contain_underscores() {
        // Option-digest names carry several underscore-separated segments; the
        // split must take the *first* underscore after the version only.
        let parsed = parse_generated_map_name("neroxis_map_generator_1.7.7_aaa_bbb_ccc").unwrap();
        assert_eq!(parsed.seed, "aaa_bbb_ccc");
    }

    #[test]
    fn rejects_names_that_are_not_generated_maps() {
        for name in [
            "SCMP_009",
            "neroxis_map_generator_",
            "neroxis_map_generator_1.7.7",
            "neroxis_map_generator_1.7.7_",
            "neroxis_map_generator_x.y.z_seed",
            "not_neroxis_map_generator_1.7.7_seed",
        ] {
            assert!(!is_generated_map(name), "{name} should not parse");
        }
    }

    #[test]
    fn the_prefix_match_is_case_insensitive() {
        assert!(is_generated_map("Neroxis_Map_Generator_1.7.7_seed"));
    }

    #[test]
    fn versions_compare_numerically_not_lexically() {
        assert!(version(1, 10, 0) > version(1, 9, 0));
        assert!(version(1, 0, 0) > version(0, 99, 99));
    }

    #[test]
    fn version_parsing_rejects_malformed_input() {
        assert!(GeneratorVersion::parse("1.7").is_none());
        assert!(GeneratorVersion::parse("1.7.7.7").is_none());
        assert!(GeneratorVersion::parse("1.7.abc").is_none());
        assert!(GeneratorVersion::parse("1.7.7777").is_none());
        assert!(GeneratorVersion::parse("").is_none());
    }

    #[test]
    fn version_support_brackets_the_known_majors() {
        assert_eq!(version(0, 1, 0).support(), VersionSupport::Supported);
        assert_eq!(version(1, 7, 7).support(), VersionSupport::Supported);
        assert_eq!(version(2, 0, 0).support(), VersionSupport::TooNew);
    }

    #[test]
    fn the_default_policy_matches_the_java_clients_configuration() {
        let policy = VersionPolicy::default();
        assert_eq!(policy.min_major, MIN_SUPPORTED_MAJOR);
        assert_eq!(policy.max_major, MAX_SUPPORTED_MAJOR);
    }

    #[test]
    fn a_raised_floor_makes_old_generators_outdated() {
        // The window is configurable precisely so FAF can do this without a
        // client release; `Outdated` is unreachable under the default policy.
        let policy = VersionPolicy {
            min_major: 1,
            max_major: 2,
        };
        assert_eq!(policy.support(version(0, 9, 0)), VersionSupport::Outdated);
        assert_eq!(policy.support(version(1, 7, 7)), VersionSupport::Supported);
        assert_eq!(policy.support(version(2, 0, 0)), VersionSupport::Supported);
        assert_eq!(policy.support(version(3, 0, 0)), VersionSupport::TooNew);
    }

    #[test]
    fn a_single_version_window_admits_only_that_major() {
        let policy = VersionPolicy {
            min_major: 1,
            max_major: 1,
        };
        assert!(policy.allows_major(1));
        assert!(!policy.allows_major(0));
        assert!(!policy.allows_major(2));
    }

    #[test]
    fn an_outdated_version_is_refused_with_its_own_message() {
        let policy = VersionPolicy {
            min_major: 1,
            max_major: 1,
        };
        let error = build_arguments(version(0, 9, 0), None, &GeneratorOptions::default(), policy)
            .unwrap_err();
        assert_eq!(
            error,
            CommandError::UnsupportedVersion(VersionSupport::Outdated)
        );
        // The two directions need different advice: one is unfixable, the
        // other is "update the client".
        assert!(error.to_string().contains("older"), "{error}");
    }

    #[test]
    fn a_too_new_version_tells_the_user_to_update() {
        let error = build_arguments(
            version(9, 0, 0),
            None,
            &GeneratorOptions::default(),
            VersionPolicy::default(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("update the client"), "{error}");
    }

    #[test]
    fn the_visualize_flag_opts_out_of_the_timeout() {
        // A viewer window is meant to stay open; killing it after three
        // minutes would look like a failure.
        assert!(runs_without_timeout(&["--visualize".to_string()]));
        assert!(runs_without_timeout(&[
            "--map-size".to_string(),
            "512".to_string(),
            "--visualize".to_string(),
        ]));
    }

    #[test]
    fn an_ordinary_run_keeps_the_timeout() {
        assert!(!runs_without_timeout(&[
            "--map-size".to_string(),
            "512".to_string()
        ]));
        assert!(!runs_without_timeout(&[]));
        // Not a prefix match: a different flag must not disarm the timeout.
        assert!(!runs_without_timeout(&["--visualize-nothing".to_string()]));
    }

    #[test]
    fn raw_args_can_reach_the_visualize_flag() {
        let options = GeneratorOptions {
            command_line_args: "--map-size 512 --visualize".into(),
            ..Default::default()
        };
        let args =
            build_arguments(version(1, 7, 7), None, &options, VersionPolicy::default()).unwrap();
        assert!(runs_without_timeout(&args));
    }

    #[test]
    fn jar_names_follow_the_release_and_cache_conventions() {
        assert_eq!(version(1, 7, 7).jar_name(), "NeroxisGen_1.7.7.jar");
        assert_eq!(version(1, 7, 7).cached_jar_name(), "MapGenerator_1.7.7.jar");
    }

    #[test]
    fn reproducing_a_named_map_passes_only_the_name() {
        let args = build_arguments(
            version(1, 7, 7),
            Some("neroxis_map_generator_1.7.7_abc"),
            &GeneratorOptions::default(),
            VersionPolicy::default(),
        )
        .unwrap();
        assert_eq!(args, vec!["--map-name", "neroxis_map_generator_1.7.7_abc"]);
    }

    #[test]
    fn a_pre_1_0_generator_takes_positional_arguments() {
        let options = GeneratorOptions {
            seed: "12345".into(),
            ..Default::default()
        };
        let args = build_arguments(
            version(0, 9, 0),
            Some("mapname"),
            &options,
            VersionPolicy::default(),
        )
        .unwrap();
        assert_eq!(args, vec![".", "12345", "0.9.0", "mapname"]);
    }

    #[test]
    fn an_options_run_emits_the_required_triple() {
        let args = build_arguments(
            version(1, 7, 7),
            None,
            &GeneratorOptions::default(),
            VersionPolicy::default(),
        )
        .unwrap();
        assert_eq!(
            args,
            vec![
                "--map-size",
                "512",
                "--spawn-count",
                "6",
                "--num-teams",
                "2"
            ]
        );
    }

    #[test]
    fn missing_required_parameters_is_an_error() {
        let options = GeneratorOptions {
            map_size: None,
            ..Default::default()
        };
        assert_eq!(
            build_arguments(version(1, 7, 7), None, &options, VersionPolicy::default()),
            Err(CommandError::MissingParameters)
        );
    }

    #[test]
    fn a_generation_type_replaces_the_style_options() {
        // The preset is the whole instruction: emitting styles too would make
        // the generator reject the combination.
        let options = GeneratorOptions {
            generation_type: GenerationType::Blind,
            style: "LAND".into(),
            seed: "9".into(),
            ..Default::default()
        };
        let args =
            build_arguments(version(1, 7, 7), None, &options, VersionPolicy::default()).unwrap();
        assert!(args.contains(&"--blind".to_string()));
        assert!(!args.contains(&"--style".to_string()));
        assert!(!args.contains(&"--seed".to_string()));
    }

    #[test]
    fn casual_emits_no_generation_type_flag() {
        let args = build_arguments(
            version(1, 7, 7),
            None,
            &GeneratorOptions::default(),
            VersionPolicy::default(),
        )
        .unwrap();
        assert!(!args
            .iter()
            .any(|a| a.starts_with("--tournament") || a == "--blind" || a == "--unexplored"));
    }

    #[test]
    fn a_whole_map_style_supersedes_the_component_styles() {
        let options = GeneratorOptions {
            style: "BIG_ISLANDS".into(),
            terrain_style: "TERRAIN".into(),
            texture_style: "TEXTURE".into(),
            resource_density: Some(1.0),
            ..Default::default()
        };
        let args =
            build_arguments(version(1, 7, 7), None, &options, VersionPolicy::default()).unwrap();
        assert!(args.ends_with(&["--style".to_string(), "BIG_ISLANDS".to_string()]));
        assert!(!args.contains(&"--terrain-style".to_string()));
        assert!(!args.contains(&"--resource-density".to_string()));
    }

    #[test]
    fn component_styles_and_densities_are_emitted_together() {
        let options = GeneratorOptions {
            symmetry: "POINT4".into(),
            seed: "42".into(),
            terrain_style: "T".into(),
            texture_style: "X".into(),
            resource_style: "R".into(),
            prop_style: "P".into(),
            // Bin units, the same scale the sliders use.
            reclaim_density: Some(127.0),
            resource_density: Some(0.0),
            ..Default::default()
        };
        let args = build_arguments(
            MIN_COMPONENT_STYLE_VERSION,
            None,
            &options,
            VersionPolicy::default(),
        )
        .unwrap();
        for expected in [
            "--seed",
            "42",
            "--terrain-symmetry",
            "POINT4",
            "--terrain-style",
            "T",
            "--texture-style",
            "X",
            "--resource-style",
            "R",
            "--prop-style",
            "P",
            // Converted to the 0..1 fraction the flag actually accepts.
            "--resource-density",
            "0.000000",
            "--reclaim-density",
            "1.000000",
        ] {
            assert!(
                args.contains(&expected.to_string()),
                "missing {expected} in {args:?}"
            );
        }
    }

    /// Every density the sliders can produce has to land inside the range the
    /// generator's converter accepts, or the run dies with
    /// "Must be between 0 and 1" the moment anyone touches a slider.
    #[test]
    fn densities_are_always_emitted_inside_the_generators_accepted_range() {
        for bin in [0.0, 1.0, 63.5, 100.0, 127.0] {
            let options = GeneratorOptions {
                terrain_style: "T".into(),
                reclaim_density: Some(bin),
                resource_density: Some(bin),
                ..Default::default()
            };
            let args = build_arguments(
                MIN_COMPONENT_STYLE_VERSION,
                None,
                &options,
                VersionPolicy::default(),
            )
            .unwrap();
            let emitted: Vec<f32> = args
                .windows(2)
                .filter(|w| w[0] == "--reclaim-density" || w[0] == "--resource-density")
                .map(|w| w[1].parse().expect("a density must parse as a number"))
                .collect();
            assert_eq!(emitted.len(), 2, "{args:?}");
            for value in emitted {
                assert!(
                    (0.0..=1.0).contains(&value),
                    "bin {bin} emitted {value}, outside the generator's 0..1"
                );
            }
        }
    }

    #[test]
    fn a_full_slider_is_the_generators_maximum_not_a_hundred_and_twenty_seven() {
        let options = GeneratorOptions {
            terrain_style: "T".into(),
            reclaim_density: Some(NUM_BINS as f32),
            ..Default::default()
        };
        let args = build_arguments(
            MIN_COMPONENT_STYLE_VERSION,
            None,
            &options,
            VersionPolicy::default(),
        )
        .unwrap();
        assert!(args
            .windows(2)
            .any(|w| w[0] == "--reclaim-density" && w[1].parse::<f32>().unwrap() == 1.0));
    }

    #[test]
    fn raw_arguments_keep_quoted_paths_in_one_piece() {
        // The whole reason for shell-style splitting: a Windows path with a
        // space must not become four arguments.
        assert_eq!(
            split_command_line(r#"--out-path "C:\Users\Max Mustermann\maps" --debug"#),
            vec![r"--out-path", r"C:\Users\Max Mustermann\maps", "--debug"]
        );
        // Backslashes are path separators here, not escapes.
        assert_eq!(split_command_line(r"C:\maps"), vec![r"C:\maps"]);
        assert_eq!(split_command_line("  --a   'b c'  "), vec!["--a", "b c"]);
        assert_eq!(split_command_line(""), Vec::<String>::new());
        assert_eq!(split_command_line("--empty \"\""), vec!["--empty", ""]);
    }

    #[test]
    fn the_paths_and_diagnostics_reach_the_command_line() {
        let options = GeneratorOptions {
            output_path: "D:/maps".into(),
            preview_path: "D:/previews".into(),
            debug: true,
            visualize: true,
            ..Default::default()
        };
        let args = build_arguments(
            MIN_MODERN_CLI_VERSION,
            None,
            &options,
            VersionPolicy::default(),
        )
        .unwrap();
        assert!(args.windows(2).any(|w| w == ["--out-path", "D:/maps"]));
        assert!(args
            .windows(2)
            .any(|w| w == ["--preview-path", "D:/previews"]));
        assert!(args.contains(&"--debug".to_string()));
        // And the viewer run must still be exempt from the timeout.
        assert!(runs_without_timeout(&args));
    }

    #[test]
    fn a_visibility_preset_gets_no_preview_path() {
        // Tournament and blind maps have no preview by design, so asking for
        // one would be a flag the generator quietly ignores.
        let options = GeneratorOptions {
            generation_type: GenerationType::Tournament,
            preview_path: "D:/previews".into(),
            output_path: "D:/maps".into(),
            ..Default::default()
        };
        let args = build_arguments(
            MIN_MODERN_CLI_VERSION,
            None,
            &options,
            VersionPolicy::default(),
        )
        .unwrap();
        assert!(!args.contains(&"--preview-path".to_string()), "{args:?}");
        // The output path is not style-dependent and must survive.
        assert!(args.windows(2).any(|w| w == ["--out-path", "D:/maps"]));
    }

    #[test]
    fn an_incompatible_symmetry_is_never_picked_when_a_workable_one_is_offered() {
        // POINT3 cannot make two teams. The Java client picks uniformly from
        // the checked items and fails roughly half the time; we filter first.
        let options = GeneratorOptions {
            num_teams: Some(2),
            spawn_count: Some(6),
            symmetries: vec!["POINT3".into(), "POINT4".into()],
            ..Default::default()
        };
        for seed in ["1", "2", "3", "4", "5", "6", "7"] {
            let args = build_arguments(
                MIN_MODERN_CLI_VERSION,
                None,
                &GeneratorOptions {
                    seed: seed.to_string(),
                    ..options.clone()
                },
                VersionPolicy::default(),
            )
            .unwrap();
            assert!(
                args.windows(2)
                    .any(|w| w == ["--terrain-symmetry", "POINT4"]),
                "seed {seed} picked an incompatible symmetry: {args:?}"
            );
        }
    }

    #[test]
    fn an_all_incompatible_selection_is_still_honoured() {
        // Filtering to nothing and silently generating something unrelated
        // would be worse than letting the generator refuse with a clear reason.
        let options = GeneratorOptions {
            num_teams: Some(2),
            symmetries: vec!["POINT3".into()],
            ..Default::default()
        };
        let args = build_arguments(
            MIN_MODERN_CLI_VERSION,
            None,
            &options,
            VersionPolicy::default(),
        )
        .unwrap();
        assert!(args
            .windows(2)
            .any(|w| w == ["--terrain-symmetry", "POINT3"]));
    }

    #[test]
    fn a_style_that_suits_the_map_size_is_preferred() {
        // BIG_ISLANDS needs 768+; on a 256 map the other choice is the sane one.
        let options = GeneratorOptions {
            map_size: Some(256),
            styles: vec!["BIG_ISLANDS".into(), "MOUNTAIN_RANGE".into()],
            ..Default::default()
        };
        for seed in ["1", "2", "3", "4", "5"] {
            let args = build_arguments(
                MIN_MODERN_CLI_VERSION,
                None,
                &GeneratorOptions {
                    seed: seed.to_string(),
                    ..options.clone()
                },
                VersionPolicy::default(),
            )
            .unwrap();
            assert!(args.windows(2).any(|w| w == ["--style", "MOUNTAIN_RANGE"]));
        }
    }

    // --- validation -------------------------------------------------------

    fn options(spawns: u32, teams: u32, size: u32) -> GeneratorOptions {
        GeneratorOptions {
            spawn_count: Some(spawns),
            num_teams: Some(teams),
            map_size: Some(size),
            ..Default::default()
        }
    }

    #[test]
    fn a_workable_combination_reports_nothing() {
        assert!(validate_options(&options(6, 2, 512)).is_empty());
        assert!(validate_options(&GeneratorOptions::default()).is_empty());
    }

    #[test]
    fn spawns_that_do_not_divide_among_teams_are_caught() {
        // The generator's own words: "Spawn Count `5` not a multiple of Num
        // Teams `2`". Verified against NeroxisGen_1.22.1.jar.
        let issues = validate_options(&options(5, 2, 512));
        assert_eq!(
            issues,
            vec![ValidationIssue::SpawnsNotDivisibleByTeams {
                spawn_count: 5,
                num_teams: 2
            }]
        );
        assert!(issues[0].is_fatal());
    }

    #[test]
    fn an_asymmetric_map_switches_off_every_team_rule() {
        // "0 is no teams asymmetric": 5 spawns is then perfectly legal.
        assert!(validate_options(&options(5, 0, 512)).is_empty());
        let odd = GeneratorOptions {
            symmetries: vec!["POINT3".into()],
            ..options(5, 0, 512)
        };
        assert!(validate_options(&odd).is_empty());
    }

    #[test]
    fn a_map_size_off_the_sixty_four_grid_is_caught() {
        let issues = validate_options(&options(6, 2, 500));
        assert!(issues.contains(&ValidationIssue::MapSizeNotAMultiple { map_size: 500 }));
    }

    #[test]
    fn an_incompatible_symmetry_is_caught_only_when_nothing_else_fits() {
        // Verified message: "Terrain symmetry `POINT3` not compatible with Num
        // Teams `2`".
        let bad = GeneratorOptions {
            symmetries: vec!["POINT3".into()],
            ..options(6, 2, 512)
        };
        assert!(validate_options(&bad)
            .iter()
            .any(|i| matches!(i, ValidationIssue::SymmetryIncompatible { .. })));

        // One workable option among several is enough, because the builder
        // filters to it.
        let mixed = GeneratorOptions {
            symmetries: vec!["POINT3".into(), "POINT2".into()],
            ..options(6, 2, 512)
        };
        assert!(validate_options(&mixed).is_empty());
    }

    #[test]
    fn symmetry_point_counts_match_the_generators_table() {
        assert_eq!(symmetry_points("POINT3"), Some(3));
        assert_eq!(symmetry_points("point4"), Some(4));
        assert_eq!(symmetry_points("XZ"), Some(2));
        assert_eq!(symmetry_points("QUAD"), Some(4));
        assert_eq!(symmetry_points("NONE"), Some(1));
        // A symmetry from a future release must not become unselectable.
        assert_eq!(symmetry_points("POINT99"), None);
        assert!(symmetry_fits_teams("POINT99", 3));
    }

    #[test]
    fn out_of_range_values_are_reported_with_their_bounds() {
        let issues = validate_options(&options(20, 2, 512));
        assert!(issues.iter().any(|i| matches!(
            i,
            ValidationIssue::OutOfRange { field, value: 20, .. } if field == "spawn count"
        )));
    }

    #[test]
    fn a_style_outside_its_range_warns_without_blocking() {
        let bad = GeneratorOptions {
            style: "BIG_ISLANDS".into(),
            ..options(6, 2, 256)
        };
        let issues = validate_options(&bad);
        let issue = issues
            .iter()
            .find(|i| matches!(i, ValidationIssue::StyleOutsideItsRange { .. }))
            .expect("expected a style warning");
        // The generator accepts it, it just will not look like its name.
        assert!(!issue.is_fatal());
        assert!(issue.to_string().contains("768"), "{issue}");
    }

    #[test]
    fn style_constraints_match_the_generators_table() {
        assert!(style_constraints("BIG_ISLANDS").matches(1024, 6, 2));
        assert!(!style_constraints("BIG_ISLANDS").matches(256, 6, 2));
        // LOW_MEX is the narrowest: 256-640, at most 4 spawns, exactly 2 teams.
        assert!(style_constraints("LOW_MEX").matches(512, 4, 2));
        assert!(!style_constraints("LOW_MEX").matches(512, 6, 2));
        assert!(!style_constraints("LOW_MEX").matches(512, 4, 4));
        assert!(style_constraints("SETONISH").matches(512, 8, 2));
        assert!(!style_constraints("SETONISH").matches(256, 8, 2));
        // Unknown and unconstrained styles both accept anything.
        assert!(style_constraints("BASIC").matches(256, 16, 8));
        assert!(style_constraints("A_STYLE_FROM_2030").matches(256, 16, 8));
    }

    #[test]
    fn a_visibility_preset_skips_the_style_and_symmetry_rules() {
        // Those options are not sent at all for tournament maps, so warning
        // about them would be noise.
        let tournament = GeneratorOptions {
            generation_type: GenerationType::Tournament,
            symmetries: vec!["POINT3".into()],
            style: "BIG_ISLANDS".into(),
            ..options(6, 2, 256)
        };
        assert!(validate_options(&tournament).is_empty());
        // But the arithmetic rules still hold: they are checked before the split.
        let broken = GeneratorOptions {
            generation_type: GenerationType::Blind,
            ..options(5, 2, 512)
        };
        assert!(!validate_options(&broken).is_empty());
    }

    #[test]
    fn a_seed_that_is_not_a_number_is_caught() {
        // The generator's `--seed` is a Long; "abc" fails type conversion
        // before generation begins.
        let bad = GeneratorOptions {
            seed: "not-a-number".into(),
            ..options(6, 2, 512)
        };
        assert!(validate_options(&bad)
            .iter()
            .any(|i| matches!(i, ValidationIssue::SeedNotAnInteger { .. })));

        // Negative seeds are legal: the generator reports them itself.
        let negative = GeneratorOptions {
            seed: "-5386725883509321122".into(),
            ..options(6, 2, 512)
        };
        assert!(validate_options(&negative).is_empty());
        // As is no seed at all, which means "pick one".
        assert!(validate_options(&options(6, 2, 512)).is_empty());
    }

    #[test]
    fn raw_arguments_opt_out_of_validation_entirely() {
        let raw = GeneratorOptions {
            command_line_args: "--map-size 500 --spawn-count 5 --num-teams 2".into(),
            ..options(5, 2, 500)
        };
        assert!(validate_options(&raw).is_empty());
    }

    #[test]
    fn num_to_generate_is_omitted_for_a_single_map() {
        let one = GeneratorOptions {
            num_to_generate: Some(1),
            ..Default::default()
        };
        assert!(
            !build_arguments(MIN_MODERN_CLI_VERSION, None, &one, VersionPolicy::default())
                .unwrap()
                .contains(&"--num-to-generate".to_string())
        );

        let many = GeneratorOptions {
            num_to_generate: Some(4),
            ..Default::default()
        };
        let args = build_arguments(
            MIN_MODERN_CLI_VERSION,
            None,
            &many,
            VersionPolicy::default(),
        )
        .unwrap();
        assert!(args.windows(2).any(|w| w == ["--num-to-generate", "4"]));
    }

    #[test]
    fn a_fixed_seed_suppresses_the_map_count() {
        // Otherwise the generator is asked for four copies of one map.
        let options = GeneratorOptions {
            seed: "12345".into(),
            num_to_generate: Some(4),
            ..Default::default()
        };
        let args =
            build_arguments(version(1, 7, 7), None, &options, VersionPolicy::default()).unwrap();
        assert!(!args.contains(&"--num-to-generate".to_string()), "{args:?}");
        assert!(
            args.windows(2).any(|w| w == ["--seed", "12345"]),
            "{args:?}"
        );
    }

    #[test]
    fn raw_command_line_args_replace_everything() {
        let options = GeneratorOptions {
            command_line_args: "--map-size 256 --spawn-count 2".into(),
            style: "IGNORED".into(),
            ..Default::default()
        };
        let args =
            build_arguments(version(1, 7, 7), None, &options, VersionPolicy::default()).unwrap();
        assert_eq!(args, vec!["--map-size", "256", "--spawn-count", "2"]);
    }

    #[test]
    fn an_unsupported_version_refuses_to_build_a_command() {
        assert_eq!(
            build_arguments(
                version(9, 0, 0),
                None,
                &GeneratorOptions::default(),
                VersionPolicy::default()
            ),
            Err(CommandError::UnsupportedVersion(VersionSupport::TooNew))
        );
    }

    #[test]
    fn scrapes_map_names_from_generator_output() {
        let line = "Saved map to neroxis_map_generator_1.7.7_abcdef";
        assert_eq!(
            scrape_map_names(line),
            vec!["neroxis_map_generator_1.7.7_abcdef"]
        );
    }

    #[test]
    fn scrapes_several_names_from_one_line_and_lowercases_them() {
        let line = "Generated Neroxis_Map_Generator_1.7.7_aaa, neroxis_map_generator_1.7.7_bbb.";
        assert_eq!(
            scrape_map_names(line),
            vec![
                "neroxis_map_generator_1.7.7_aaa",
                "neroxis_map_generator_1.7.7_bbb"
            ]
        );
    }

    #[test]
    fn ignores_output_without_a_map_name() {
        assert!(scrape_map_names("Generating terrain... 42%").is_empty());
        assert!(scrape_map_names("neroxis_map_generator_ has no version").is_empty());
    }

    #[test]
    fn option_lists_drop_headings_and_blanks() {
        let stdout = "Available styles:\nBIG_ISLANDS\n\nLAND\nMOUNTAIN_RANGE\nNote: something\n";
        assert_eq!(
            parse_option_list(stdout),
            vec!["BIG_ISLANDS", "LAND", "MOUNTAIN_RANGE"]
        );
    }

    #[test]
    fn a_list_is_only_asked_of_a_release_that_answers_it() {
        // Read off the published JARs, run under Temurin 25. The gap in the
        // middle of `--symmetries` is real: the picocli rewrite dropped it and
        // 1.12.0 brought it back.
        let cases = [
            (version(1, 3, 0), GeneratorOptionQuery::Styles, false),
            (version(1, 4, 0), GeneratorOptionQuery::Styles, true),
            (version(1, 9, 0), GeneratorOptionQuery::Styles, true),
            (version(1, 3, 0), GeneratorOptionQuery::Symmetries, false),
            (version(1, 8, 0), GeneratorOptionQuery::Symmetries, true),
            (version(1, 9, 0), GeneratorOptionQuery::Symmetries, false),
            (version(1, 11, 0), GeneratorOptionQuery::Symmetries, false),
            (version(1, 12, 0), GeneratorOptionQuery::Symmetries, true),
            (
                version(1, 11, 0),
                GeneratorOptionQuery::TerrainStyles,
                false,
            ),
            (version(1, 12, 0), GeneratorOptionQuery::TerrainStyles, true),
            (version(1, 22, 1), GeneratorOptionQuery::PropStyles, true),
        ];
        for (release, query, expected) in cases {
            assert_eq!(
                query.supported_by(release),
                expected,
                "{} on {release}",
                query.flag()
            );
        }
    }

    #[test]
    fn a_release_without_component_styles_gets_none_of_their_flags() {
        // The flags would not be refused by every old generator: the ones
        // before picocli ignore what they do not know, so the run succeeds and
        // quietly produces a different map. Leaving them off is the only way
        // the result matches what was asked for.
        let options = GeneratorOptions {
            terrain_style: "T".into(),
            texture_style: "X".into(),
            resource_style: "R".into(),
            prop_style: "P".into(),
            reclaim_density: Some(64.0),
            ..Default::default()
        };
        let args =
            build_arguments(version(1, 9, 0), None, &options, VersionPolicy::default()).unwrap();
        assert!(!args.iter().any(|arg| arg.ends_with("-style")));
        assert!(!args.contains(&"--reclaim-density".to_string()));
        // The size/spawn/team triple every release understands still goes out.
        assert!(args.starts_with(&["--map-size".to_string()]));
    }

    #[test]
    fn the_oldest_releases_get_only_the_flags_they_have() {
        // 1.0.x has no map size, no teams and no style, and refuses to start
        // without being told where to write. Sending it the modern triple
        // would not fail loudly: its parser ignores what it does not know and
        // generates something else entirely.
        let options = GeneratorOptions {
            map_size: Some(512),
            spawn_count: Some(4),
            num_teams: Some(2),
            style: "BIG_ISLANDS".into(),
            ..Default::default()
        };
        let args =
            build_arguments(version(1, 0, 0), None, &options, VersionPolicy::default()).unwrap();
        assert_eq!(
            args,
            vec!["--spawn-count", "4", "--folder-path", "."],
            "1.0.0 takes a spawn count and an output folder, and nothing else here"
        );

        // 1.1.0 gained the size, 1.3.0 the teams.
        let sized =
            build_arguments(version(1, 1, 0), None, &options, VersionPolicy::default()).unwrap();
        assert!(sized.starts_with(&["--map-size".to_string(), "512".to_string()]));
        assert!(!sized.contains(&"--num-teams".to_string()));
        let teamed =
            build_arguments(version(1, 3, 0), None, &options, VersionPolicy::default()).unwrap();
        assert!(teamed.contains(&"--num-teams".to_string()));
        // The whole-map style is 1.4.0 and later, so neither of these gets one.
        assert!(!teamed.contains(&"--style".to_string()));
    }

    #[test]
    fn the_flag_names_follow_the_release_that_will_run() {
        let options = GeneratorOptions {
            map_size: Some(512),
            spawn_count: Some(2),
            num_teams: Some(2),
            output_path: "D:/maps".into(),
            num_to_generate: Some(3),
            ..Default::default()
        };
        let old =
            build_arguments(version(1, 5, 0), None, &options, VersionPolicy::default()).unwrap();
        assert!(old.windows(2).any(|w| w == ["--folder-path", "D:/maps"]));
        assert!(old.windows(2).any(|w| w == ["--num-to-gen", "3"]));

        let modern =
            build_arguments(version(1, 9, 0), None, &options, VersionPolicy::default()).unwrap();
        assert!(modern.windows(2).any(|w| w == ["--out-path", "D:/maps"]));
        assert!(modern.windows(2).any(|w| w == ["--num-to-generate", "3"]));

        // Before 1.4.0 there is no way to ask for several maps at all.
        let ancient =
            build_arguments(version(1, 3, 0), None, &options, VersionPolicy::default()).unwrap();
        assert!(!ancient.iter().any(|arg| arg.starts_with("--num-to-gen")));
    }

    #[test]
    fn reproducing_on_a_1_0_release_still_says_where_to_write() {
        let args = build_arguments(
            version(1, 0, 0),
            Some("neroxis_map_generator_1.0.0_abc"),
            &GeneratorOptions::default(),
            VersionPolicy::default(),
        )
        .unwrap();
        assert_eq!(
            args,
            vec![
                "--map-name",
                "neroxis_map_generator_1.0.0_abc",
                "--folder-path",
                "."
            ]
        );
    }

    #[test]
    fn only_the_releases_with_parse_are_asked_to_resolve_a_name() {
        // 1.21.2 does not refuse `--parse`, it generates a map instead, so
        // "can I ask this release" is not a question the generator answers for
        // us: the boundary has to be known here.
        assert!(!version(1, 21, 2).supports_parse());
        assert!(version(1, 22, 0).supports_parse());
        assert!(version(1, 22, 1).supports_parse());
    }

    #[test]
    fn every_option_query_has_a_distinct_flag() {
        let flags: Vec<&str> = GeneratorOptionQuery::ALL.iter().map(|q| q.flag()).collect();
        let mut sorted = flags.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), flags.len());
    }
}
