//! Decoding a generated map name back into the options that produced it.
//!
//! A generated map name is not just a label, it is the *entire recipe*:
//!
//! ```text
//! neroxis_map_generator_<version>_<seed-b32>_<options-b32>[_<time-b32>]
//! ```
//!
//! The generator's `GeneratedMapNameEncoder` packs spawn count, map size, team
//! count, symmetry and style into a handful of bytes and Base32-encodes them.
//! Decoding is pure arithmetic: no JAR, no JVM, no download. That matters
//! because it lets the lobby list say "10 km · 8 spawns · 4 teams · FLOODED"
//! for a map nobody has generated yet, at zero cost per row.
//!
//! Neither reference client does this. The Python and Java clients treat
//! everything after the version as an opaque seed, exactly as
//! [`super::map_generator::parse_generated_map_name`] does: correct for
//! reproduction, but it throws away information already present in the name.
//!
//! ## On version skew
//!
//! The packed bytes are *enum ordinals*, and enum ordinals move when the
//! generator adds a style. The tables below are the 1.22.x ordering. An ordinal
//! this client does not know decodes to `None` for that one field rather than
//! to a wrong name: a missing style label is a cosmetic gap, a confidently
//! wrong one is a lie. For an authoritative answer the generator itself can be
//! asked with `--map-name <name> --parse`, which is what
//! `MapGeneratorPort::parse_map_name` is for.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Density resolution the generator discretises to (`NUM_BINS`).
///
/// Densities never travel as raw percentages: they are binned to one of 127
/// steps so the value survives a round trip through the map name. This is the
/// same constant the command builder divides by.
pub const NUM_BINS: u32 = 127;

/// Map size is stored as a single byte of 64-unit steps, so every legal size is
/// a multiple of this.
pub const MAP_SIZE_STEP: u32 = 64;

/// Terrain symmetries, in the generator's `Symmetry` declaration order.
///
/// The second field is `numSymPoints`, which is load-bearing rather than
/// decorative: the generator refuses a symmetry whose point count is not a
/// multiple of the team count, so this table is what lets us catch that before
/// spawning Java. See [`super::map_generator::symmetry_points`].
pub const SYMMETRIES: [(&str, u32); 22] = [
    ("POINT2", 2),
    ("POINT3", 3),
    ("POINT4", 4),
    ("POINT5", 5),
    ("POINT6", 6),
    ("POINT7", 7),
    ("POINT8", 8),
    ("POINT9", 9),
    ("POINT10", 10),
    ("POINT11", 11),
    ("POINT12", 12),
    ("POINT13", 13),
    ("POINT14", 14),
    ("POINT15", 15),
    ("POINT16", 16),
    ("XZ", 2),
    ("ZX", 2),
    ("X", 2),
    ("Z", 2),
    ("QUAD", 4),
    ("DIAG", 4),
    ("NONE", 1),
];

/// Whole-map style presets, in `MapStyle.Predefined` declaration order.
pub const MAP_STYLES: [&str; 21] = [
    "BASIC",
    "BIG_ISLANDS",
    "CENTER_LAKE",
    "DROP_PLATEAU",
    "FLOODED",
    "HIGH_RECLAIM",
    "LAND_BRIDGE",
    "LITTLE_MOUNTAIN",
    "LOW_MEX",
    "MOUNTAIN_RANGE",
    "MULTILEVEL",
    "ONE_ISLAND",
    "SMALL_ISLANDS",
    "VALLEY",
    "RIVERS",
    "RIVERS_AND_OCEANS",
    "FRACTAL_LAND",
    "FRACTAL_PLATEAU",
    "FRACTAL_NAVY",
    "SETONISH",
    "FORREST_SOMETHING",
];

/// Texture styles, in `BiomeName` declaration order.
pub const BIOMES: [&str; 13] = [
    "BRIMSTONE",
    "DESERT",
    "EARLYAUTUMN",
    "FRITHEN",
    "MARS",
    "MOONLIGHT",
    "PRAYER",
    "STONES",
    "SUNSET",
    "SYRTIS",
    "WINDINGRIVER",
    "WONDER",
    "CRYSTALLINE",
];

/// Terrain styles, in `TerrainStyle` declaration order.
pub const TERRAIN_STYLES: [&str; 24] = [
    "BASIC",
    "BASIC_LAST",
    "BIG_ISLANDS",
    "CENTER_LAKE",
    "CENTER_LAKE_LAST",
    "DROP_PLATEAU",
    "DROP_PLATEAU_LAST",
    "FLOODED",
    "LAND_BRIDGE",
    "LITTLE_MOUNTAIN",
    "LITTLE_MOUNTAIN_LAST",
    "MOUNTAIN_RANGE",
    "MOUNTAIN_RANGE_LAST",
    "MULTILEVEL_LAST",
    "ONE_ISLAND",
    "SMALL_ISLANDS",
    "VALLEY",
    "VALLEY_LAST",
    "RIVERS",
    "RIVERS_AND_OCEANS",
    "FRACTAL_LAND",
    "FRACTAL_PLATEAU",
    "FRACTAL_NAVY",
    "SETONS",
];

/// Resource styles, in `ResourceStyle` declaration order.
pub const RESOURCE_STYLES: [&str; 6] = [
    "BASIC",
    "LOW_MEX",
    "WATER_MEX",
    "HI_MEX_LAND_LOW_MEX_WATER",
    "ONE_HYDRO_NO_MEX",
    "ONE_HYDRO_FOUR_MEX",
];

/// Prop styles, in `PropStyle` declaration order.
pub const PROP_STYLES: [&str; 10] = [
    "BASIC",
    "BOULDER_FIELD",
    "ENEMY_CIV",
    "HIGH_RECLAIM",
    "LARGE_BATTLE",
    "NAVY_WRECKS",
    "NEUTRAL_CIV",
    "ROCK_FIELD",
    "SMALL_BATTLE",
    "FORREST_SOMETHING",
];

/// Visibility presets, in `Visibility` declaration order.
pub const VISIBILITIES: [&str; 3] = ["TOURNAMENT", "BLIND", "UNEXPLORED"];

/// Turn a stored bin index back into the 0..=1 density the generator works in.
pub fn normalize_bin(bin: u8) -> f32 {
    f32::from(bin) / NUM_BINS as f32
}

/// Turn a 0..=1 density into the bin index the generator stores.
///
/// Rounds, matching the generator's `MathUtil.binPercentage`, so a value that
/// came out of [`normalize_bin`] goes back to the bin it came from.
pub fn bin_percentage(percent: f32) -> u8 {
    let clamped = percent.clamp(0.0, 1.0);
    (clamped * NUM_BINS as f32).round() as u8
}

/// The style half of a decoded name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DecodedStyle {
    /// A whole-map preset. `None` when the ordinal is newer than this client's
    /// table; the map still decodes, we just cannot name its style.
    #[serde(rename_all = "camelCase")]
    Predefined { style: Option<String> },
    /// The four component styles plus both densities.
    #[serde(rename_all = "camelCase")]
    Custom {
        terrain_style: Option<String>,
        texture_style: Option<String>,
        resource_style: Option<String>,
        prop_style: Option<String>,
        reclaim_density: f32,
        resource_density: f32,
    },
}

/// Everything a generated map name reveals about how it was made.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DecodedMapName {
    /// Generator release that produced it, e.g. `1.22.1`.
    pub version: String,
    /// The 64-bit seed. Rendered as a string because JS cannot hold it exactly.
    pub seed: String,
    pub spawn_count: u32,
    /// In generator units; divide by 51.2 for km.
    pub map_size: u32,
    pub num_teams: u32,
    /// `None` means the generator chose freely rather than "no symmetry":
    /// the latter is the `NONE` symmetry, which is a value of its own.
    pub symmetry: Option<String>,
    /// Absent when the name carries only the basic triple.
    pub style: Option<DecodedStyle>,
    /// Set for tournament/blind/unexplored maps, which carry a generation
    /// timestamp instead of style information: that is the whole point of them.
    pub visibility: Option<String>,
    /// When the map was originally generated, RFC 3339, present exactly when
    /// `visibility` is.
    ///
    /// A string rather than an integer because specta refuses to carry 64-bit
    /// numbers across the JS boundary, and because a formatted instant is what
    /// the caller wants anyway.
    pub generated_at: Option<String>,
}

impl DecodedMapName {
    /// Map size in kilometres, the unit both reference clients show.
    pub fn size_km(&self) -> f32 {
        self.map_size as f32 / 51.2
    }
}

/// Decode RFC 4648 Base32 (the generator lower-cases and strips padding).
///
/// Returns `None` on any character outside the alphabet rather than skipping
/// it: a malformed segment means the name is not one of ours, and guessing
/// would produce plausible-looking nonsense.
fn decode_base32(input: &str) -> Option<Vec<u8>> {
    let mut bits: u32 = 0;
    let mut bit_count: u32 = 0;
    let mut out = Vec::with_capacity(input.len() * 5 / 8);
    for ch in input.chars() {
        let value = match ch.to_ascii_uppercase() {
            c @ 'A'..='Z' => c as u32 - 'A' as u32,
            c @ '2'..='7' => c as u32 - '2' as u32 + 26,
            '=' => break,
            _ => return None,
        };
        bits = (bits << 5) | value;
        bit_count += 5;
        if bit_count >= 8 {
            bit_count -= 8;
            out.push((bits >> bit_count) as u8);
            bits &= (1 << bit_count) - 1;
        }
    }
    Some(out)
}

/// Look a name up by ordinal, or `None` if this client's table is older than
/// the generator that wrote it.
fn lookup(table: &[&str], ordinal: u8) -> Option<String> {
    table.get(ordinal as usize).map(|s| (*s).to_string())
}

/// Read the first eight bytes as a big-endian `i64`, the generator's
/// `ByteBuffer.getLong()`.
fn read_long(bytes: &[u8]) -> Option<i64> {
    let eight: [u8; 8] = bytes.get(..8)?.try_into().ok()?;
    Some(i64::from_be_bytes(eight))
}

/// Decode a generated map name into the parameters that produced it.
///
/// `None` when the name is not a generated map or its segments are malformed.
/// A name that decodes but carries ordinals from a newer generator still
/// succeeds, with the unknown fields left as `None`.
pub fn decode(map_name: &str) -> Option<DecodedMapName> {
    let lower = map_name.to_ascii_lowercase();
    let segments: Vec<&str> = lower.split('_').collect();
    // neroxis / map / generator / version / seed [/ options [/ time]]
    if segments.len() < 5 || segments[..3] != ["neroxis", "map", "generator"] {
        return None;
    }
    let version = segments[3];
    // Parsed for the check alone: the segment is carried through as written.
    super::map_generator::GeneratorVersion::parse(version)?;
    let seed = read_long(&decode_base32(segments[4])?)?;

    let mut decoded = DecodedMapName {
        version: version.to_string(),
        seed: seed.to_string(),
        // The generator's own defaults, used when the name omits the bytes.
        spawn_count: 6,
        map_size: 512,
        num_teams: 2,
        symmetry: None,
        style: None,
        visibility: None,
        generated_at: None,
    };

    let Some(option_segment) = segments.get(5) else {
        return Some(decoded);
    };
    let options = decode_base32(option_segment)?;
    // The lobby server hand-writes map names to steer generation, so the
    // option bytes are not guaranteed present: each one is read only if it is
    // actually there.
    if let Some(&spawns) = options.first() {
        decoded.spawn_count = u32::from(spawns);
    }
    if let Some(&size) = options.get(1) {
        decoded.map_size = u32::from(size) * MAP_SIZE_STEP;
    }
    if let Some(&teams) = options.get(2) {
        decoded.num_teams = u32::from(teams);
    }

    match options.len() {
        // Competitive: the fourth byte is a visibility, and the generation time
        // lives in its own trailing segment.
        4 if segments.len() >= 7 => {
            decoded.visibility = lookup(&VISIBILITIES, options[3]);
            decoded.generated_at = read_long(&decode_base32(segments[6])?)
                .and_then(|seconds| chrono::DateTime::from_timestamp(seconds, 0))
                .map(|instant| instant.to_rfc3339());
        }
        // Casual: the fourth byte is a symmetry ordinal, with -1 for "let the
        // generator pick". Stored as a Java signed byte, so 0xFF is the sentinel.
        len if len > 3 => {
            if options[3] as i8 >= 0 {
                decoded.symmetry = lookup_symmetry(options[3]);
            }
            decoded.style = match len {
                5 => Some(DecodedStyle::Predefined {
                    style: lookup(&MAP_STYLES, options[4]),
                }),
                10 => Some(DecodedStyle::Custom {
                    texture_style: lookup(&BIOMES, options[4]),
                    terrain_style: lookup(&TERRAIN_STYLES, options[5]),
                    resource_style: lookup(&RESOURCE_STYLES, options[6]),
                    prop_style: lookup(&PROP_STYLES, options[7]),
                    reclaim_density: normalize_bin(options[8]),
                    resource_density: normalize_bin(options[9]),
                }),
                _ => None,
            };
        }
        _ => {}
    }

    Some(decoded)
}

fn lookup_symmetry(ordinal: u8) -> Option<String> {
    SYMMETRIES
        .get(ordinal as usize)
        .map(|(name, _)| (*name).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every expectation below was produced by running the real generator:
    //     java -jar NeroxisGen_1.22.1.jar --parse ...
    // so these are conformance tests against the shipped JAR, not against our
    // own reading of its source.

    #[test]
    fn decodes_a_predefined_style_name() {
        // --map-size 10km --spawn-count 6 --num-teams 2 --style MOUNTAIN_RANGE
        // --terrain-symmetry POINT2 --seed 12345
        let decoded = decode("neroxis_map_generator_1.22.1_aaaaaaaaaayds_ayeaeaaj").unwrap();
        assert_eq!(decoded.version, "1.22.1");
        assert_eq!(decoded.seed, "12345");
        assert_eq!(decoded.spawn_count, 6);
        assert_eq!(decoded.map_size, 512);
        assert_eq!(decoded.num_teams, 2);
        assert_eq!(decoded.symmetry.as_deref(), Some("POINT2"));
        assert_eq!(
            decoded.style,
            Some(DecodedStyle::Predefined {
                style: Some("MOUNTAIN_RANGE".into())
            })
        );
        assert!(decoded.visibility.is_none());
    }

    #[test]
    fn decodes_a_custom_style_name_including_densities() {
        // --map-size 512 --spawn-count 8 --num-teams 4 --terrain-style FLOODED
        // --biome SYRTIS --resource-style LOW_MEX --prop-style ROCK_FIELD
        // --reclaim-density 0.75 --resource-density 0.25
        let decoded =
            decode("neroxis_map_generator_1.22.1_mmyctirfxqlx6_baeaj7yja4aqoxza").unwrap();
        assert_eq!(decoded.seed, "7147258385031501695");
        assert_eq!(decoded.spawn_count, 8);
        assert_eq!(decoded.map_size, 512);
        assert_eq!(decoded.num_teams, 4);
        // No `--terrain-symmetry` was given, so the generator kept its freedom.
        assert!(decoded.symmetry.is_none());
        let DecodedStyle::Custom {
            terrain_style,
            texture_style,
            resource_style,
            prop_style,
            reclaim_density,
            resource_density,
        } = decoded.style.unwrap()
        else {
            panic!("expected a custom style");
        };
        assert_eq!(terrain_style.as_deref(), Some("FLOODED"));
        assert_eq!(texture_style.as_deref(), Some("SYRTIS"));
        assert_eq!(resource_style.as_deref(), Some("LOW_MEX"));
        assert_eq!(prop_style.as_deref(), Some("ROCK_FIELD"));
        // The generator reported 0.7480315 and 0.2519685: 95/127 and 32/127.
        assert!(
            (reclaim_density - 0.748_031_5).abs() < 1e-6,
            "{reclaim_density}"
        );
        assert!(
            (resource_density - 0.251_968_5).abs() < 1e-6,
            "{resource_density}"
        );
    }

    #[test]
    fn decodes_a_tournament_name_with_its_generation_time() {
        // --tournament-style, which swaps style information for a timestamp.
        let decoded =
            decode("neroxis_map_generator_1.22.1_wu7icwk3azjf4_ayeaeaa_aaaaaadkqecre").unwrap();
        assert_eq!(decoded.spawn_count, 6);
        assert_eq!(decoded.map_size, 512);
        assert_eq!(decoded.num_teams, 2);
        assert_eq!(decoded.visibility.as_deref(), Some("TOURNAMENT"));
        // Epoch second 1786840338, as the generator reported it.
        assert_eq!(
            decoded.generated_at.as_deref(),
            Some("2026-08-16T00:32:18+00:00")
        );
        assert!(decoded.style.is_none());
    }

    #[test]
    fn decodes_a_name_carrying_only_the_basic_triple() {
        // An unknown flag was passed, so no style survived into the name.
        let decoded = decode("neroxis_map_generator_1.22.1_ed577kmcvkh22_ayeae").unwrap();
        assert_eq!(decoded.spawn_count, 6);
        assert_eq!(decoded.map_size, 512);
        assert_eq!(decoded.num_teams, 2);
        assert!(decoded.symmetry.is_none());
        assert!(decoded.style.is_none());
    }

    #[test]
    fn decodes_an_asymmetric_map() {
        // `--map-size 1024 --spawn-count 8 --num-teams 0 --terrain-symmetry NONE`,
        // a shape the dialog could not even express before: team count 0 is a
        // real option ("no teams asymmetric"), not an unset value.
        let decoded = decode("neroxis_map_generator_1.22.1_r3sexv7gb7mjq_baiaafi").unwrap();
        assert_eq!(decoded.spawn_count, 8);
        assert_eq!(decoded.map_size, 1024);
        assert_eq!(decoded.num_teams, 0);
        assert_eq!(decoded.symmetry.as_deref(), Some("NONE"));
        assert_eq!(decoded.seed, "-8150306034983905128");
    }

    #[test]
    fn decodes_the_densities_our_own_command_line_produces() {
        // Round trip proof for the density fix: slider bin 64 leaves as
        // 64/127 = 0.503937, and the generator hands back exactly that. A raw
        // 64 would have been refused outright.
        let decoded =
            decode("neroxis_map_generator_1.22.1_ezlq7khcxrudk_ayeaf7yhaabacqd7").unwrap();
        let DecodedStyle::Custom {
            reclaim_density,
            resource_density,
            ..
        } = decoded.style.unwrap()
        else {
            panic!("expected a custom style");
        };
        assert!(
            (reclaim_density - 0.503_937).abs() < 1e-6,
            "{reclaim_density}"
        );
        assert!((resource_density - 1.0).abs() < 1e-6, "{resource_density}");
        assert_eq!(bin_percentage(reclaim_density), 64);
    }

    #[test]
    fn a_negative_symmetry_ordinal_means_unspecified() {
        // 0xFF is Java's -1: "the generator picked one".
        assert_eq!(0xFFu8 as i8, -1);
        assert!(lookup_symmetry(0).is_some());
    }

    #[test]
    fn an_ordinal_from_a_newer_generator_decodes_to_none_not_a_wrong_name() {
        // The whole point of the version-skew guard: no confident lies.
        assert_eq!(lookup(&MAP_STYLES, 250), None);
        assert_eq!(lookup(&BIOMES, 99), None);
    }

    #[test]
    fn rejects_names_that_are_not_generated_maps() {
        for name in [
            "scmp_009",
            "neroxis_map_generator_1.22.1",
            "neroxis_map_generator_x.y.z_aaaa",
            "something_else_entirely_1.22.1_aaaa",
        ] {
            assert!(decode(name).is_none(), "{name} should not decode");
        }
    }

    #[test]
    fn rejects_a_segment_that_is_not_base32() {
        assert!(decode("neroxis_map_generator_1.22.1_!!!!!!!!!!!!!").is_none());
    }

    #[test]
    fn the_prefix_match_is_case_insensitive() {
        assert!(decode("Neroxis_Map_Generator_1.22.1_aaaaaaaaaayds_ayeaeaaj").is_some());
    }

    #[test]
    fn density_bins_round_trip() {
        // 0.75 -> bin 95 -> 0.7480315, which is what the generator reported.
        assert_eq!(bin_percentage(0.75), 95);
        assert!((normalize_bin(95) - 0.748_031_5).abs() < 1e-6);
        assert_eq!(bin_percentage(0.25), 32);
        assert_eq!(bin_percentage(0.0), 0);
        assert_eq!(bin_percentage(1.0), 127);
        // Out-of-range input is clamped rather than wrapping around.
        assert_eq!(bin_percentage(9.0), 127);
        assert_eq!(bin_percentage(-1.0), 0);
    }

    #[test]
    fn size_in_km_matches_the_generators_conversion() {
        let decoded = decode("neroxis_map_generator_1.22.1_aaaaaaaaaayds_ayeaeaaj").unwrap();
        assert!((decoded.size_km() - 10.0).abs() < 0.01);
    }

    #[test]
    fn every_symmetry_point_count_is_positive() {
        // A zero would make the team-compatibility modulo divide by zero.
        for (name, points) in SYMMETRIES {
            assert!(points > 0, "{name} has no symmetry points");
        }
    }
}
