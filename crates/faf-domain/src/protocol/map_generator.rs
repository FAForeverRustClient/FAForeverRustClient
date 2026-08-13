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
/// Mirrors the Java client's `GeneratorOptions` record one-for-one. `None`
/// means "let the generator decide", which is not the same as a default value,
/// omitting `--style` lets the generator pick one, while passing a style pins it.
// No `Eq`: the density fields are `f32`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorOptions {
    /// Total spawn points. The generator requires this together with
    /// `num_teams` and `map_size`.
    pub spawn_count: Option<u32>,
    pub num_teams: Option<u32>,
    /// Map size in generator units (512 = 10 km, the engine's standard map).
    pub map_size: Option<u32>,
    /// Fixed seed, for reproducing a specific map.
    pub seed: String,
    pub generation_type: GenerationType,
    pub symmetry: String,
    /// A whole-map style preset. Mutually exclusive with the four
    /// component styles below: the generator ignores those when a style is set,
    /// so the command builder stops after emitting it.
    pub style: String,
    pub terrain_style: String,
    pub texture_style: String,
    pub resource_style: String,
    pub prop_style: String,
    /// 0–127 in the generator's units; the Java client's sliders use the same.
    pub reclaim_density: Option<f32>,
    pub resource_density: Option<f32>,
    /// Generate several maps in one run (`--num-to-generate`).
    pub num_to_generate: Option<u32>,
    /// Raw passthrough. When set it replaces every other option: the escape
    /// hatch both clients keep for generator flags newer than the client.
    pub command_line_args: String,
}

impl Default for GeneratorOptions {
    fn default() -> Self {
        Self {
            // The Java client's `GeneratorPrefs` defaults.
            spawn_count: Some(6),
            num_teams: Some(2),
            map_size: Some(512),
            seed: String::new(),
            generation_type: GenerationType::Casual,
            symmetry: String::new(),
            style: String::new(),
            terrain_style: String::new(),
            texture_style: String::new(),
            resource_style: String::new(),
            prop_style: String::new(),
            reclaim_density: None,
            resource_density: None,
            num_to_generate: None,
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
        return Ok(options
            .command_line_args
            .split_whitespace()
            .map(str::to_string)
            .collect());
    }

    // Reproducing a known map: the name alone determines the terrain.
    if let Some(name) = map_name {
        return Ok(vec!["--map-name".to_string(), name.to_string()]);
    }

    let (Some(size), Some(spawns), Some(teams)) =
        (options.map_size, options.spawn_count, options.num_teams)
    else {
        return Err(CommandError::MissingParameters);
    };

    let mut args = vec![
        "--map-size".to_string(),
        size.to_string(),
        "--spawn-count".to_string(),
        spawns.to_string(),
        "--num-teams".to_string(),
        teams.to_string(),
    ];

    if let Some(count) = options.num_to_generate.filter(|n| *n > 1) {
        args.push("--num-to-generate".to_string());
        args.push(count.to_string());
    }

    // A generation type is a whole-map preset: it replaces the style and
    // density options rather than combining with them.
    if let Some(flag) = options.generation_type.flag() {
        args.push(flag.to_string());
        return Ok(args);
    }

    let mut push_flag = |flag: &str, value: &str| {
        if !value.is_empty() {
            args.push(flag.to_string());
            args.push(value.to_string());
        }
    };
    push_flag("--seed", &options.seed);
    push_flag("--terrain-symmetry", &options.symmetry);

    // A whole-map style likewise supersedes the four component styles.
    if !options.style.is_empty() {
        args.push("--style".to_string());
        args.push(options.style.clone());
        return Ok(args);
    }

    push_flag("--terrain-style", &options.terrain_style);
    push_flag("--texture-style", &options.texture_style);
    push_flag("--resource-style", &options.resource_style);
    push_flag("--prop-style", &options.prop_style);

    if let Some(density) = options.resource_density {
        args.push("--resource-density".to_string());
        args.push(density.to_string());
    }
    if let Some(density) = options.reclaim_density {
        args.push("--reclaim-density".to_string());
        args.push(density.to_string());
    }

    Ok(args)
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
            reclaim_density: Some(0.5),
            resource_density: Some(0.25),
            ..Default::default()
        };
        let args =
            build_arguments(version(1, 7, 7), None, &options, VersionPolicy::default()).unwrap();
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
            "--resource-density",
            "0.25",
            "--reclaim-density",
            "0.5",
        ] {
            assert!(
                args.contains(&expected.to_string()),
                "missing {expected} in {args:?}"
            );
        }
    }

    #[test]
    fn num_to_generate_is_omitted_for_a_single_map() {
        let one = GeneratorOptions {
            num_to_generate: Some(1),
            ..Default::default()
        };
        assert!(
            !build_arguments(version(1, 7, 7), None, &one, VersionPolicy::default())
                .unwrap()
                .contains(&"--num-to-generate".to_string())
        );

        let many = GeneratorOptions {
            num_to_generate: Some(4),
            ..Default::default()
        };
        let args =
            build_arguments(version(1, 7, 7), None, &many, VersionPolicy::default()).unwrap();
        assert!(args.windows(2).any(|w| w == ["--num-to-generate", "4"]));
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
    fn every_option_query_has_a_distinct_flag() {
        let flags: Vec<&str> = GeneratorOptionQuery::ALL.iter().map(|q| q.flag()).collect();
        let mut sorted = flags.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), flags.len());
    }
}
