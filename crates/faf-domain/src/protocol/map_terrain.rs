//! What a map's ground is made of, and the coarse categories people search by.
//!
//! ## Where the values come from
//!
//! Not from taste. The game ships its terrain textures in themed libraries
//! under `/env/<theme>/layers/`, and a map's `.scmap` names the ones it paints
//! with; the theme covering most of a map's *dry* ground is its biome. The
//! value set is therefore fixed by what the game ships, and it is closed: both
//! installs were enumerated for `/env/` folders containing a `layers/`
//! directory, Forged Alliance provides 14 and FAF another 5, and every one of
//! them is a value below. `tools/map-terrain/API.md` carries that check.
//!
//! `Custom` is the one value with no folder behind it: about one map in forty
//! ships its own textures, either under `/maps/<map>/env/layers/` or in an
//! `/env/` folder no install provides, and no name can classify those.
//!
//! ## Why categories live here and not in the database
//!
//! A category is a *view* over the biomes, not another fact about a map. Stored
//! as its own column, every new category would need a migration and a re-import
//! of eleven thousand maps; computed here, adding one is a line of code. This is
//! the same reasoning that keeps the coverage percentages in their own columns
//! rather than baking a threshold in at write time - the threshold is a decision
//! the query makes.
//!
//! Categories do not replace the individual biomes, they sit beside them.
//! `Green` matches 64% of the vault, which is honest and nearly useless on its
//! own; it earns its place combined with the water bracket, where "green and
//! naval" is a real question and "tundra and naval" narrows 8932 maps to 106.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Coverage at or above which a biome counts as one of a map's themes.
///
/// A map can be 99% evergreen and 1% desert. Without this, asking for desert
/// maps returns it, because it does carry the value. 25 is what the search
/// uses; the API stores the percentages precisely so this stays a query
/// decision and not a re-import.
pub const MINIMUM_BIOME_PERCENT: i32 = 25;

/// Whether the API serves the terrain columns yet.
///
/// `false` until the `map_version` migration lands. This is not caution for its
/// own sake: a property the API does not recognise makes it reject the whole
/// `filter`, so shipping the clause early would take the entire map vault down
/// rather than degrade to an unfiltered search. See the note at the top of
/// `vault_query.rs`.
///
/// Flip to `true` once `latestVersion.biome` is live, and the filter and its
/// control appear together. Everything behind it is built and tested.
pub const TERRAIN_FILTER_READY: bool = false;

/// The terrain library covering most of a map's dry ground.
///
/// Carried lower case on this side and upper-cased at the API boundary, the
/// same way `ModVaultQuery` treats mod types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Biome {
    Evergreen,
    Desert,
    Tundra,
    RedBarrens,
    Tropical,
    Lava,
    Paradise,
    Crystalline,
    Geothermal,
    Swamp,
    AncientEarth,
    NewRealms,
    Seraphim,
    Wasteland,
    /// The map brings its own textures, so nothing can be said about the theme.
    Custom,
}

impl Biome {
    /// Every value, for building a picker without a list that can drift.
    pub const ALL: [Biome; 15] = [
        Biome::Evergreen,
        Biome::Desert,
        Biome::Tundra,
        Biome::RedBarrens,
        Biome::Tropical,
        Biome::Lava,
        Biome::Paradise,
        Biome::Crystalline,
        Biome::Geothermal,
        Biome::Swamp,
        Biome::AncientEarth,
        Biome::NewRealms,
        Biome::Seraphim,
        Biome::Wasteland,
        Biome::Custom,
    ];

    /// The value as the API spells it.
    pub fn api_value(self) -> &'static str {
        match self {
            Biome::Evergreen => "EVERGREEN",
            Biome::Desert => "DESERT",
            Biome::Tundra => "TUNDRA",
            Biome::RedBarrens => "RED_BARRENS",
            Biome::Tropical => "TROPICAL",
            Biome::Lava => "LAVA",
            Biome::Paradise => "PARADISE",
            Biome::Crystalline => "CRYSTALLINE",
            Biome::Geothermal => "GEOTHERMAL",
            Biome::Swamp => "SWAMP",
            Biome::AncientEarth => "ANCIENT_EARTH",
            Biome::NewRealms => "NEW_REALMS",
            Biome::Seraphim => "SERAPHIM",
            Biome::Wasteland => "WASTELAND",
            Biome::Custom => "CUSTOM",
        }
    }
}

/// A coarse grouping of biomes, for people who want "a green map" and do not
/// care whether that is evergreen, tropical, paradise or swamp.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TerrainCategory {
    /// Grass and vegetation. 5723 of 8932 maps, so coarse by design.
    Green,
    /// Sand and dry rock.
    Arid,
    /// Snow and ice.
    Snow,
    /// Lava fields and the cracked ground around them.
    Volcanic,
    /// The themes that are not meant to look like Earth at all.
    Alien,
    /// Maps carrying their own textures, which no category can describe.
    Custom,
}

impl TerrainCategory {
    pub const ALL: [TerrainCategory; 6] = [
        TerrainCategory::Green,
        TerrainCategory::Arid,
        TerrainCategory::Snow,
        TerrainCategory::Volcanic,
        TerrainCategory::Alien,
        TerrainCategory::Custom,
    ];

    /// The biomes this category stands for.
    ///
    /// Every biome belongs to exactly one category, so the six of them cover
    /// the value set with nothing counted twice. A *map* can still land in two
    /// categories, because a map can carry two biomes - that is the point of
    /// tagging rather than filing, and 1372 maps do.
    pub fn biomes(self) -> &'static [Biome] {
        match self {
            TerrainCategory::Green => &[
                Biome::Evergreen,
                Biome::Tropical,
                Biome::Paradise,
                Biome::Swamp,
            ],
            TerrainCategory::Arid => &[Biome::Desert, Biome::RedBarrens],
            TerrainCategory::Snow => &[Biome::Tundra],
            TerrainCategory::Volcanic => &[Biome::Lava, Biome::Geothermal],
            TerrainCategory::Alien => &[
                Biome::Crystalline,
                Biome::Seraphim,
                Biome::NewRealms,
                Biome::AncientEarth,
                Biome::Wasteland,
            ],
            TerrainCategory::Custom => &[Biome::Custom],
        }
    }
}

/// What the terrain filter is set to: nothing, a whole category, or one biome.
///
/// Both kinds resolve to the same thing - a set of biome values - so the query
/// builder does not care which the user picked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum TerrainFilter {
    Category(TerrainCategory),
    Biome(Biome),
}

impl TerrainFilter {
    /// The biome values this selection accepts.
    pub fn biomes(self) -> Vec<Biome> {
        match self {
            TerrainFilter::Category(category) => category.biomes().to_vec(),
            TerrainFilter::Biome(biome) => vec![biome],
        }
    }
}

/// How much of a map is under water, as the three brackets people actually ask
/// for.
///
/// Thresholds rather than a slider because "is this a naval map" is a yes/no
/// question, and the answer at 49% and 51% is the same answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum WaterBracket {
    /// 15% or less. Land maps.
    Land,
    /// Between the two.
    Mixed,
    /// 50% or more. Naval maps.
    Naval,
}

impl WaterBracket {
    pub const ALL: [WaterBracket; 3] =
        [WaterBracket::Land, WaterBracket::Mixed, WaterBracket::Naval];

    /// Inclusive `(min, max)` percentage bounds, `None` where unbounded.
    pub fn bounds(self) -> (Option<i32>, Option<i32>) {
        match self {
            WaterBracket::Land => (None, Some(15)),
            WaterBracket::Mixed => (Some(16), Some(49)),
            WaterBracket::Naval => (Some(50), None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_biome_belongs_to_exactly_one_category() {
        // The categories are a partition of the value set. If a biome appeared
        // in two, a map could be double counted; if it appeared in none, it
        // would be unreachable through the coarse picker.
        let mut seen: Vec<Biome> = Vec::new();
        for category in TerrainCategory::ALL {
            seen.extend_from_slice(category.biomes());
        }
        let unique: HashSet<Biome> = seen.iter().copied().collect();
        assert_eq!(seen.len(), unique.len(), "a biome is in two categories");
        assert_eq!(
            unique.len(),
            Biome::ALL.len(),
            "a biome belongs to no category"
        );
        for biome in Biome::ALL {
            assert!(unique.contains(&biome), "{biome:?} is in no category");
        }
    }

    #[test]
    fn api_values_are_distinct_and_upper_snake() {
        let values: HashSet<&str> = Biome::ALL.iter().map(|b| b.api_value()).collect();
        assert_eq!(values.len(), Biome::ALL.len());
        for biome in Biome::ALL {
            let value = biome.api_value();
            assert!(
                value.chars().all(|c| c.is_ascii_uppercase() || c == '_'),
                "{value} is not the shape the API stores"
            );
        }
    }

    #[test]
    fn a_category_resolves_to_its_biomes_and_a_biome_to_itself() {
        assert_eq!(
            TerrainFilter::Category(TerrainCategory::Arid).biomes(),
            vec![Biome::Desert, Biome::RedBarrens]
        );
        assert_eq!(
            TerrainFilter::Biome(Biome::Tundra).biomes(),
            vec![Biome::Tundra]
        );
    }

    #[test]
    fn water_brackets_tile_the_range_without_gaps_or_overlap() {
        // A map at any percentage lands in exactly one bracket, or the picker
        // would hide maps at the seams.
        for percent in 0..=100 {
            let matched: Vec<WaterBracket> = WaterBracket::ALL
                .into_iter()
                .filter(|bracket| {
                    let (min, max) = bracket.bounds();
                    min.is_none_or(|m| percent >= m) && max.is_none_or(|m| percent <= m)
                })
                .collect();
            assert_eq!(matched.len(), 1, "{percent}% matched {matched:?}");
        }
    }
}
