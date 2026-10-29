//! An installed map's picture without anything drawn on it, and where its
//! resources and spawns are, for the client to draw FAF's own icons over it.
//!
//! The map generator bakes its markers into the preview it writes, as small
//! green and yellow dots that are neither FAF's mass and hydro icons nor quite
//! on the spot: measured against the `_save.lua` of a 1.22.2 map, every dot sat
//! a pixel up and to the left of its marker. The `.scmap` carries the same
//! terrain without any of them (see [`super::scmap`]), and the `_save.lua`
//! names every marker's position in map units, so the picture can be drawn the
//! way the vault's previews are: the terrain, then hydros, then mass, then the
//! spawns on top.
//!
//! The parsing follows the Python client's (`fa/maps_/_preview.py`), which
//! reads the save file line by line rather than through a Lua parser, and for
//! the same reason: a save file is generated, its layout does not vary, and a
//! map with a few hundred markers is a few thousand lines.

use std::path::{Path, PathBuf};

use faf_domain::state::is_safe_folder_name;
use serde::Serialize;

/// Refuse a save or scenario file larger than this. The largest save file in a
/// real maps folder of 436 maps is a few megabytes; a corrupt one should not
/// be read into memory whole.
const MAX_LUA_BYTES: u64 = 32 * 1024 * 1024;

/// A map's clean picture and its markers, in map units.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkedMapPreview {
    /// The `.scmap`'s own preview, as `data:image/png;base64,...`. It covers the
    /// whole map, `width` by `height`, including any area outside the playable
    /// one.
    pub image: String,
    /// The map's extent in map units, from the scenario's `size`.
    pub width: f32,
    pub height: f32,
    /// `[x, z]` of each marker: across, then down the picture.
    pub mass: Vec<[f32; 2]>,
    pub hydro: Vec<[f32; 2]>,
    pub spawns: Vec<[f32; 2]>,
}

/// Where each kind of marker is, as read from a `_save.lua`.
#[derive(Debug, Default, Clone, PartialEq)]
struct Markers {
    mass: Vec<[f32; 2]>,
    hydro: Vec<[f32; 2]>,
    spawns: Vec<[f32; 2]>,
}

/// The installed map `folder_name`'s picture and markers.
///
/// The name arrives from the webview, so it goes through the same guard as an
/// install or an uninstall before it is joined onto the maps folder.
pub fn marked_map_preview(folder_name: &str) -> Result<MarkedMapPreview, String> {
    marked_map_preview_in(&super::maps::maps_dir(), folder_name)
}

fn marked_map_preview_in(maps_dir: &Path, folder_name: &str) -> Result<MarkedMapPreview, String> {
    if !is_safe_folder_name(folder_name) {
        return Err("that is not a map folder name".to_string());
    }
    if hides_its_layout(folder_name) {
        return Err(HIDDEN_LAYOUT.to_string());
    }
    let folder = [
        maps_dir.join(folder_name),
        maps_dir.join(folder_name.to_lowercase()),
    ]
    .into_iter()
    .find(|path| path.is_dir())
    .ok_or_else(|| "the map is not installed".to_string())?;

    let scmap = file_ending_in(&folder, ".scmap")?;
    let scenario = file_ending_in(&folder, "_scenario.lua")?;
    let save = file_ending_in(&folder, "_save.lua")?;

    let scenario = read_lua(&scenario)?;
    if scenario.contains(HIDDEN_LAYOUT_DESCRIPTION) {
        return Err(HIDDEN_LAYOUT.to_string());
    }
    let (width, height) =
        map_size(&scenario).ok_or_else(|| "the map's scenario names no size".to_string())?;
    let markers = parse_markers(&read_lua(&save)?);
    let image = super::scmap::preview_data_url(&scmap)?;
    Ok(MarkedMapPreview {
        image,
        width,
        height,
        mass: markers.mass,
        hydro: markers.hydro,
        spawns: markers.spawns,
    })
}

const HIDDEN_LAYOUT: &str = "the generator hides this map's layout";

/// How the generator opens the description of a map whose layout it hides,
/// where any other map's begins with its seed.
const HIDDEN_LAYOUT_DESCRIPTION: &str = "Map originally generated at";

/// A tournament, blind or unexplored map: the generator writes a placeholder
/// into its `.scmap` and no preview at all, so that nobody can scout it before
/// the game. Its `_save.lua` still names every mass point, and drawing them
/// would hand out exactly what the generator withholds, so these get no
/// picture from here and the caller keeps its placeholder.
///
/// Known by the name, which carries a generation time instead of a style for
/// exactly these maps; the scenario's description is checked as well, for a
/// name from a generator newer than the decoder.
fn hides_its_layout(folder_name: &str) -> bool {
    faf_domain::protocol::map_generator_name::decode(folder_name)
        .is_some_and(|decoded| decoded.visibility.is_some())
}

/// The one file in `folder` whose name ends in `suffix`. A map folder holds
/// exactly one of each; a folder with two is not guessed at.
fn file_ending_in(folder: &Path, suffix: &str) -> Result<PathBuf, String> {
    let mut found: Option<PathBuf> = None;
    for entry in std::fs::read_dir(folder)
        .map_err(|error| format!("could not read the map folder: {error}"))?
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if !name.ends_with(suffix) || !entry.path().is_file() {
            continue;
        }
        if found.is_some() {
            return Err(format!("the map folder holds more than one {suffix} file"));
        }
        found = Some(entry.path());
    }
    found.ok_or_else(|| format!("the map folder holds no {suffix} file"))
}

fn read_lua(path: &Path) -> Result<String, String> {
    // Bounded on the read as well as on the stated size: a file that grew
    // after it was measured is refused rather than read whole.
    let bytes = super::metadata_file::read_bounded(path, MAX_LUA_BYTES)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    // Lossy: a map's description is sometimes in a legacy code page, and a
    // stray byte in it says nothing about where the markers are.
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// `size = {1024, 1024},` in the scenario file.
fn map_size(scenario: &str) -> Option<(f32, f32)> {
    scenario.lines().find_map(|line| {
        let rest = line.trim_start().strip_prefix("size")?;
        let rest = rest.trim_start().strip_prefix('=')?;
        let inner = rest.trim_start().strip_prefix('{')?;
        let inner = &inner[..inner.find('}')?];
        let mut numbers = inner.split(',').map(|part| part.trim().parse::<f32>());
        let width = numbers.next()?.ok()?;
        let height = numbers.next()?.ok()?;
        (width > 0.0 && height > 0.0).then_some((width, height))
    })
}

/// Every mass, hydrocarbon and army marker in a `_save.lua`.
///
/// A marker is a block that opens with `['Name'] = {` and closes with `},`; its
/// `type` and `position` lines come in either order. The armies are known by
/// their name (`ARMY_1`), since their type is only `Blank Marker`.
fn parse_markers(save: &str) -> Markers {
    #[derive(Clone, Copy)]
    enum Kind {
        Mass,
        Hydro,
    }
    let mut markers = Markers::default();
    let mut is_army = false;
    let mut kind: Option<Kind> = None;
    let mut position: Option<[f32; 2]> = None;

    for line in save.lines() {
        let line = line.trim();
        if line.starts_with("['") && line.ends_with('{') {
            is_army = line[2..].starts_with("ARMY_");
            kind = None;
            position = None;
        } else if line.starts_with("['type']") {
            if line.contains("'Mass'") {
                kind = Some(Kind::Mass);
            } else if line.contains("'Hydrocarbon'") {
                kind = Some(Kind::Hydro);
            }
        } else if line.starts_with("['position']") {
            position = vector3_xz(line);
        } else if line == "}," || line == "}" {
            if let Some(at) = position {
                match kind {
                    Some(Kind::Mass) => markers.mass.push(at),
                    Some(Kind::Hydro) => markers.hydro.push(at),
                    None if is_army => markers.spawns.push(at),
                    None => {}
                }
            }
            is_army = false;
            kind = None;
            position = None;
        }
    }
    markers
}

/// `['position'] = VECTOR3( x, y, z ),` as `[x, z]`: `y` is the height.
fn vector3_xz(line: &str) -> Option<[f32; 2]> {
    let inner = &line[line.find('(')? + 1..];
    let inner = &inner[..inner.find(')')?];
    let mut parts = inner.split(',').map(|part| part.trim().parse::<f32>());
    let x = parts.next()?.ok()?;
    let _height = parts.next()?.ok()?;
    let z = parts.next()?.ok()?;
    Some([x, z])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape of a generator's save file, cut down to one of each marker.
    const SAVE: &str = r"
Scenario = {
  Areas = {
    ['AREA_1'] = {
       ['rectangle'] = RECTANGLE( 128, 128, 896, 896 ),
    },
  },
  MasterChain = {
    ['_MASTERCHAIN_'] = {
      Markers = {
        ['ARMY_1'] = {
          ['type'] = STRING( 'Blank Marker' ),
          ['position'] = VECTOR3( 373.500000, 25.328125, 353.500000 ),
          ['orientation'] = VECTOR3( 0.00, 0.00, 0.00 ),
        },
        ['Mex 0'] = {
          ['size'] = FLOAT( 1.000000 ),
          ['type'] = STRING( 'Mass' ),
          ['position'] = VECTOR3( 360.500000, 25.328125, 351.500000 ),
        },
        ['Hydro 0'] = {
          ['position'] = VECTOR3( 269.500000, 25.320313, 217.500000 ),
          ['type'] = STRING( 'Hydrocarbon' ),
        },
        ['AIMarker 1'] = {
          ['type'] = STRING( 'Land Path Node' ),
          ['position'] = VECTOR3( 1.0, 2.0, 3.0 ),
        },
      },
    },
  },
}
";

    #[test]
    fn each_kind_of_marker_is_read_and_the_height_dropped() {
        let markers = parse_markers(SAVE);
        assert_eq!(markers.spawns, vec![[373.5, 353.5]]);
        assert_eq!(markers.mass, vec![[360.5, 351.5]]);
        // Position before type is the same marker.
        assert_eq!(markers.hydro, vec![[269.5, 217.5]]);
    }

    #[test]
    fn a_path_node_is_not_a_resource() {
        let markers = parse_markers(SAVE);
        assert_eq!(
            markers.mass.len() + markers.hydro.len() + markers.spawns.len(),
            3
        );
    }

    #[test]
    fn the_size_is_read_from_the_scenario() {
        let scenario =
            "ScenarioInfo = {\n  starts = true,\n  size = {1024, 512},\n  norushradius = 50.0,\n}";
        assert_eq!(map_size(scenario), Some((1024.0, 512.0)));
        assert_eq!(map_size("norushradius = 50.0"), None);
    }

    #[test]
    fn a_map_whose_layout_is_hidden_gets_no_markers() {
        // A tournament-style name from 1.22.2: a generation time where a
        // casual map carries its style.
        let error = marked_map_preview_in(
            Path::new("."),
            "neroxis_map_generator_1.22.2_l5k24r7tlgih4_bieaeai_aaaaaadkzvo6q",
        )
        .unwrap_err();
        assert_eq!(error, HIDDEN_LAYOUT);
    }

    #[test]
    fn a_name_that_leaves_the_maps_folder_is_refused() {
        let error = marked_map_preview_in(Path::new("."), "../secrets").unwrap_err();
        assert!(error.contains("not a map folder name"), "{error}");
    }
}
