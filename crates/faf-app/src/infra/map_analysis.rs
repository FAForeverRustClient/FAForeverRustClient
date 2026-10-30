//! An installed map's pathing and reclaim, as pictures over its preview.
//!
//! The map's own files say both: the `.scmap` holds the heightmap, the water,
//! the ground and the props, the save file the mass and hydrocarbon markers
//! and the playable area. `faf_domain::protocol::navigation` turns the first
//! into the regions the game's AI pathing divides the map into, per layer;
//! `map_reclaim` adds up what the props are worth, from their blueprints in
//! the game's `env` archives. This reads the files and draws the results, one
//! picture per layer and one for the reclaim, each the size of the map.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use faf_domain::protocol::blueprint::parse_blueprint;
use faf_domain::protocol::map_reclaim::{prop_key, prop_value, summarize_reclaim, PropValue};
use faf_domain::protocol::navigation::{self, Area, NavGrid, NavLayer, Resource};
use faf_domain::protocol::scmap::parse_scmap;
use serde::Serialize;

/// The largest `.scmap` read. An 81 km map is a few hundred megabytes; more
/// is not a map.
const MAX_SCMAP_BYTES: u64 = 768 * 1024 * 1024;
/// A prop blueprint is a few kilobytes.
const MAX_PROP_BYTES: u64 = 256 * 1024;
/// The pictures are at most this many pixels a side: one per ogrid up to a
/// 20 km map, and every second or fourth ogrid on larger ones.
const MAX_PICTURE_SIDE: u32 = 1024;

/// What the map dialog draws.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapAnalysis {
    /// The `.scmap`'s preview, the picture the layers are drawn over.
    pub preview: String,
    /// In ogrids.
    pub width: u32,
    pub height: u32,
    pub has_water: bool,
    pub layers: Vec<LayerPicture>,
    pub reclaim: ReclaimPicture,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerPicture {
    pub layer: NavLayer,
    /// Regions the layer is divided into after culling.
    pub regions: usize,
    /// The share of the map, from 0 to 1, units of the layer can reach.
    pub reachable: f32,
    /// `data:image/png;base64,...`: each region its own colour, where the
    /// layer cannot go dark, the size of the map.
    pub image: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReclaimPicture {
    pub mass: f64,
    pub energy: f64,
    pub props: usize,
    /// Props whose blueprint was found and so counted.
    pub valued: usize,
    /// Where the mass is: brighter where there is more.
    pub image: String,
}

/// The installed map `folder_name`, for the game install at `game_path`
/// (whose `env` archives hold the props' values).
pub fn map_analysis(folder_name: &str, game_path: &str) -> Result<MapAnalysis, String> {
    let map = super::map_markers::installed_map(&super::maps::maps_dir(), folder_name)?;
    let size = std::fs::metadata(&map.scmap)
        .map_err(|error| format!("could not read the map file: {error}"))?
        .len();
    if size > MAX_SCMAP_BYTES {
        return Err("the map file is implausibly large".into());
    }
    let bytes = std::fs::read(&map.scmap)
        .map_err(|error| format!("could not read the map file: {error}"))?;
    let terrain = parse_scmap(&bytes)?;
    drop(bytes);

    let markers = super::map_markers::parse_markers(&map.save);
    let resources: Vec<Resource> = markers
        .mass
        .iter()
        .map(|[x, z]| (false, *x, *z))
        .chain(markers.hydro.iter().map(|[x, z]| (true, *x, *z)))
        .map(|(hydrocarbon, x, z)| Resource { hydrocarbon, x, z })
        .collect();
    let playable = navigation::playable_area(
        &scenario_type(&map.scenario).unwrap_or_default(),
        first_area(&map.save),
    );
    let mesh = navigation::generate(&terrain, &resources, playable);

    let mut layers = vec![picture_of(&mesh.land)];
    if mesh.has_water {
        layers.extend([
            picture_of(&mesh.hover),
            picture_of(&mesh.amphibious),
            picture_of(&mesh.naval),
        ]);
    }

    let values = prop_values(game_path);
    let bin = (terrain.width.max(terrain.height) / 128).max(4);
    let reclaim = summarize_reclaim(&terrain.props, terrain.width, terrain.height, bin, |key| {
        values.get(key).copied()
    });
    let reclaim = ReclaimPicture {
        mass: reclaim.mass,
        energy: reclaim.energy,
        props: reclaim.props,
        valued: reclaim.valued,
        image: heat_picture(reclaim.columns, reclaim.rows, &reclaim.mass_bins),
    };

    Ok(MapAnalysis {
        preview: super::scmap::preview_data_url(&map.scmap)?,
        width: terrain.width,
        height: terrain.height,
        has_water: mesh.has_water,
        layers,
        reclaim,
    })
}

/// `type = 'skirmish',` in the scenario file.
fn scenario_type(scenario: &str) -> Option<String> {
    scenario.lines().find_map(|line| {
        let rest = line.trim_start().strip_prefix("type")?;
        let rest = rest.trim_start().strip_prefix('=')?.trim_start();
        let quote = rest.chars().next().filter(|c| *c == '\'' || *c == '"')?;
        let inner = &rest[1..];
        Some(inner[..inner.find(quote)?].to_owned())
    })
}

/// The first `RECTANGLE( x0, z0, x1, z1 )` of the save file's areas.
fn first_area(save: &str) -> Option<Area> {
    let areas = &save[save.find("Areas")?..];
    let inner = &areas[areas.find("RECTANGLE(")? + "RECTANGLE(".len()..];
    let inner = &inner[..inner.find(')')?];
    let mut numbers = inner.split(',').map(|part| part.trim().parse::<f32>().ok());
    Some(Area {
        x0: numbers.next()??,
        z0: numbers.next()??,
        x1: numbers.next()??,
        z1: numbers.next()??,
    })
}

/// A layer as a picture: every region in its own colour, half transparent so
/// the map shows through, and the ogrids the layer cannot reach dark.
fn picture_of(grid: &NavGrid) -> LayerPicture {
    let step = grid
        .width
        .max(grid.height)
        .div_ceil(MAX_PICTURE_SIDE)
        .max(1);
    let (columns, rows) = (grid.width.div_ceil(step), grid.height.div_ceil(step));
    let mut rgba = Vec::with_capacity((columns * rows * 4) as usize);
    for row in 0..rows {
        for column in 0..columns {
            let cell = grid.cells[((row * step) * grid.width + column * step) as usize];
            rgba.extend_from_slice(&region_colour(cell));
        }
    }
    let reachable = grid.cells.iter().filter(|cell| **cell != 0).count();
    LayerPicture {
        layer: grid.layer,
        regions: grid.regions.len(),
        reachable: reachable as f32 / grid.cells.len().max(1) as f32,
        image: super::png::png_data_url(columns, rows, &rgba),
    }
}

/// Region 0 is where the layer cannot go; the others take hues a golden
/// angle apart, so neighbouring numbers never look alike.
fn region_colour(region: u32) -> [u8; 4] {
    if region == 0 {
        return [0, 0, 0, 170];
    }
    let hue = (region as f32 * 137.508) % 360.0;
    let [r, g, b] = hsl_to_rgb(hue, 0.65, 0.55);
    [r, g, b, 120]
}

fn hsl_to_rgb(hue: f32, saturation: f32, lightness: f32) -> [u8; 3] {
    let chroma = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
    let section = hue / 60.0;
    let second = chroma * (1.0 - (section % 2.0 - 1.0).abs());
    let (r, g, b) = match section as u32 {
        0 => (chroma, second, 0.0),
        1 => (second, chroma, 0.0),
        2 => (0.0, chroma, second),
        3 => (0.0, second, chroma),
        4 => (second, 0.0, chroma),
        _ => (chroma, 0.0, second),
    };
    let offset = lightness - chroma / 2.0;
    let channel = |value: f32| ((value + offset) * 255.0).round().clamp(0.0, 255.0) as u8;
    [channel(r), channel(g), channel(b)]
}

/// Mass per bin as a picture: amber, more opaque where there is more. The
/// square root keeps one big rock field from washing out every tree line.
fn heat_picture(columns: u32, rows: u32, bins: &[f32]) -> String {
    let peak = bins.iter().copied().fold(0.0_f32, f32::max);
    let mut rgba = Vec::with_capacity(bins.len() * 4);
    for value in bins {
        let share = if peak > 0.0 {
            (value / peak).sqrt()
        } else {
            0.0
        };
        rgba.extend_from_slice(&[255, 196, 64, (share * 230.0).round() as u8]);
    }
    super::png::png_data_url(columns, rows, &rgba)
}

/// Every prop blueprint's value for the install whose executable is
/// `game_path`: the original game's `env.scd` with FAF's `env.nx2` over it.
/// Read once per install and kept for the session.
fn prop_values(game_path: &str) -> Arc<HashMap<String, PropValue>> {
    type Held = Option<(String, Arc<HashMap<String, PropValue>>)>;
    static READ: OnceLock<Mutex<Held>> = OnceLock::new();
    let mut held = READ
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((path, values)) = held.as_ref() {
        if path == game_path {
            return values.clone();
        }
    }
    let retail = super::game_updater::find_retail_install();
    let install = super::unit_icons::install_dir_of(game_path);
    let mut values = HashMap::new();
    // The base game first, then FAF's copies over it.
    for archive in [
        retail.map(|dir| dir.join("gamedata").join("env.scd")),
        install.map(|dir| dir.join("gamedata").join("env.nx2")),
    ]
    .into_iter()
    .flatten()
    {
        if let Err(error) = read_prop_archive(&archive, &mut values) {
            tracing::warn!(archive = %archive.display(), %error, "could not read prop values");
        }
    }
    let values = Arc::new(values);
    *held = Some((game_path.to_owned(), values.clone()));
    values
}

fn read_prop_archive(
    archive: &Path,
    values: &mut HashMap<String, PropValue>,
) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| e.to_string())?;
    for index in 0..zip.len() {
        let Ok(mut entry) = zip.by_index(index) else {
            continue;
        };
        let Ok(name) = entry.name() else {
            continue;
        };
        let key = prop_key(&name);
        if !key.ends_with("_prop.bp") || entry.size() > MAX_PROP_BYTES {
            continue;
        }
        let mut bytes = Vec::new();
        if entry.read_to_end(&mut bytes).is_err() {
            continue;
        }
        if let Ok(blueprint) = parse_blueprint(&String::from_utf8_lossy(&bytes)) {
            values.insert(key, prop_value(&blueprint));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scenario_type_and_the_first_area_are_read() {
        let scenario = "ScenarioInfo = {\n    name = 'Dual Gap',\n    type = 'skirmish',\n    size = {512, 512},\n}";
        assert_eq!(scenario_type(scenario).as_deref(), Some("skirmish"));
        let save = "Scenario = {\n  Areas = {\n    ['AREA_1'] = {\n      ['rectangle'] = RECTANGLE( 0, 16, 512, 496 ),\n    },\n  },\n}";
        assert_eq!(
            first_area(save),
            Some(Area {
                x0: 0.0,
                z0: 16.0,
                x1: 512.0,
                z1: 496.0
            })
        );
        assert_eq!(first_area("Scenario = { Areas = { } }"), None);
    }

    #[test]
    fn regions_get_distinct_colours_and_the_closed_ground_is_dark() {
        assert_eq!(region_colour(0), [0, 0, 0, 170]);
        assert_ne!(region_colour(1), region_colour(2));
        assert_eq!(region_colour(1)[3], 120);
        assert_eq!(hsl_to_rgb(0.0, 1.0, 0.5), [255, 0, 0]);
        assert_eq!(hsl_to_rgb(120.0, 1.0, 0.5), [0, 255, 0]);
    }
}
