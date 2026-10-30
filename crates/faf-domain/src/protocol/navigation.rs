//! Where each kind of unit can go on a map: the regions the game's AI pathing
//! mesh divides it into, per layer.
//!
//! The game builds this mesh for its AI when a map loads
//! (`lua/sim/NavGenerator.lua` in FAForever/fa): per layer, which ogrids a
//! unit can path over, and the regions ("labels") those ogrids form. This is
//! faf-workshop's port of it (`NavGenerator.cs`, Garanas/faf-workshop, MIT),
//! which works on the ogrids themselves rather than on the game's quadtrees
//! and gives the same regions:
//!
//! - a quadtree leaf is one ogrid or a block of ogrids that are all pathable
//!   or all not; where a block of the compression threshold's size is mixed,
//!   the game makes all of it unpathable, and so does this;
//! - the game links diagonal leaves only when one of the two leaves beside
//!   both is pathable, so its regions are those of ogrids linked by their
//!   sides.
//!
//! The game numbers its labels in another order; the regions are the same.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::scmap::ScmapTerrain;

/// The largest height difference along an ogrid's side land units cross.
pub const MAX_HEIGHT_DIFFERENCE: f32 = 0.75;
/// The deepest water amphibious units path through.
pub const MAX_WATER_DEPTH_AMPHIBIOUS: f32 = 25.0;
/// The shallowest water naval units path through.
pub const MIN_WATER_DEPTH_NAVAL: f32 = 1.5;
/// The shallowest water hover units cross whatever the slope below.
pub const MIN_WATER_DEPTH_HOVER: f32 = 1.0;
/// Labels smaller than this many ogrids (0.16 km²) without resources are
/// culled.
pub const CULL_BELOW_CELLS: usize = 400;
/// The game's quadtrees per axis.
const TREES_PER_AXIS: u32 = 16;

/// The terrain types units cannot stand on (`Blocking = true` in
/// `lua/TerrainTypes.lua`): Dirt09 and Lava01.
const BLOCKING_TERRAIN: [u8; 2] = [9, 230];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum NavLayer {
    Land,
    Hover,
    Amphibious,
    Naval,
}

/// A rectangle of the map in ogrids, the playable area.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub x0: f32,
    pub z0: f32,
    pub x1: f32,
    pub z1: f32,
}

/// A mass or hydrocarbon marker's position, in game units.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Resource {
    pub hydrocarbon: bool,
    pub x: f32,
    pub z: f32,
}

/// One layer's regions.
#[derive(Debug, Clone, PartialEq)]
pub struct NavGrid {
    pub layer: NavLayer,
    pub width: u32,
    pub height: u32,
    /// Per ogrid, row by row: its region from 1, or 0 where the layer cannot
    /// go (or the region was culled).
    pub cells: Vec<u32>,
    pub regions: Vec<NavRegion>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NavRegion {
    pub id: u32,
    /// Ogrids in the region.
    pub size: usize,
    pub mass: u32,
    pub hydrocarbons: u32,
}

/// Every layer of one map. On a map without water, hover and amphibious units
/// move like land units and the game uses the land layer for both.
#[derive(Debug, Clone, PartialEq)]
pub struct MapNavigation {
    pub has_water: bool,
    pub compression: u32,
    pub land: NavGrid,
    pub hover: NavGrid,
    pub amphibious: NavGrid,
    pub naval: NavGrid,
}

/// The compression threshold of `Generate`: 1, doubled from 1024 ogrids (20
/// km) and again from 2048 (40 km).
pub fn compression_threshold(map_size: u32) -> u32 {
    if map_size >= 2048 {
        4
    } else if map_size >= 1024 {
        2
    } else {
        1
    }
}

/// The playable area the game generates the mesh for: the first area of the
/// save file when it is larger than 32 by 32 ogrids, which is the area the
/// map editor's script makes playable. Only skirmish maps use it.
pub fn playable_area(scenario_type: &str, first_area: Option<Area>) -> Option<Area> {
    let area = first_area?;
    (scenario_type.eq_ignore_ascii_case("skirmish")
        && area.x1 - area.x0 > 32.0
        && area.z1 - area.z0 > 32.0)
        .then_some(area)
}

/// Generate every layer of a map.
pub fn generate(
    terrain: &ScmapTerrain,
    resources: &[Resource],
    playable: Option<Area>,
) -> MapNavigation {
    let (width, height) = (terrain.width, terrain.height);
    let map_size = width.max(height);
    let threshold = compression_threshold(map_size);
    let tree_size = map_size / TREES_PER_AXIS;
    let caches = Caches::populate(terrain, playable);
    let has_water = caches.depth.iter().any(|depth| *depth > 0.0);

    let build = |layer: NavLayer, rule: fn(bool, f32, bool) -> bool| {
        let mut pathable: Vec<bool> = (0..caches.flat.len())
            .map(|cell| rule(caches.flat[cell], caches.depth[cell], caches.open[cell]))
            .collect();
        // Naval units compress twice as coarse (`GenerateCompressionGrids`).
        let factor = if layer == NavLayer::Naval { 2 } else { 1 };
        let block = (threshold * factor).min((tree_size / 2).max(1));
        apply_compression(&mut pathable, width, height, block);
        let mut grid = label(layer, width, height, &pathable);
        // `GenerateMarkerMetadata` assigns resources on the land layer and,
        // on a map with water, on hover and amphibious too; naval regions
        // never hold a marker, so they are culled by size alone.
        if layer != NavLayer::Naval {
            assign_resources(&mut grid, resources);
        }
        cull(&mut grid);
        grid
    };

    let land = build(NavLayer::Land, land_rule);
    let naval = build(NavLayer::Naval, naval_rule);
    let (hover, amphibious) = if has_water {
        (
            build(NavLayer::Hover, hover_rule),
            build(NavLayer::Amphibious, amphibious_rule),
        )
    } else {
        (
            NavGrid {
                layer: NavLayer::Hover,
                ..land.clone()
            },
            NavGrid {
                layer: NavLayer::Amphibious,
                ..land.clone()
            },
        )
    };
    MapNavigation {
        has_water,
        compression: threshold,
        land,
        hover,
        amphibious,
        naval,
    }
}

// `ComputeLandPathingMatrix` and its siblings.
fn land_rule(flat: bool, depth: f32, open: bool) -> bool {
    depth <= 0.0 && open && flat
}
fn naval_rule(_flat: bool, depth: f32, open: bool) -> bool {
    depth >= MIN_WATER_DEPTH_NAVAL && open
}
fn hover_rule(flat: bool, depth: f32, open: bool) -> bool {
    open && (depth >= MIN_WATER_DEPTH_HOVER || flat)
}
fn amphibious_rule(flat: bool, depth: f32, open: bool) -> bool {
    depth <= MAX_WATER_DEPTH_AMPHIBIOUS && open && flat
}

/// What `PopulateCaches` computes per ogrid: whether its sides are flat
/// enough, the average water depth at its corners, and whether it is inside
/// the playable area on ground that does not block.
struct Caches {
    flat: Vec<bool>,
    depth: Vec<f32>,
    open: Vec<bool>,
}

impl Caches {
    fn populate(terrain: &ScmapTerrain, playable: Option<Area>) -> Self {
        let (width, height) = (terrain.width, terrain.height);
        let cells = (width * height) as usize;
        let mut flat = vec![false; cells];
        let mut depth = vec![0.0_f32; cells];
        let mut open = vec![false; cells];
        let (tlx, tlz, brx, brz) = playable
            .map_or((0.0, 0.0, width as f32, height as f32), |area| {
                (area.x0, area.z0, area.x1, area.z1)
            });
        let corner_depth = |x: u32, z: u32| {
            let ground = terrain.height_at(x, z);
            terrain
                .water_elevation
                .map_or(0.0, |water| water.max(ground) - ground)
        };
        for z in 0..height {
            for x in 0..width {
                let cell = (z * width + x) as usize;
                let (tl, tr) = (terrain.height_at(x, z), terrain.height_at(x + 1, z));
                let (bl, br) = (terrain.height_at(x, z + 1), terrain.height_at(x + 1, z + 1));
                flat[cell] = (tl - tr).abs() < MAX_HEIGHT_DIFFERENCE
                    && (bl - br).abs() < MAX_HEIGHT_DIFFERENCE
                    && (tl - bl).abs() < MAX_HEIGHT_DIFFERENCE
                    && (tr - br).abs() < MAX_HEIGHT_DIFFERENCE;
                depth[cell] = (corner_depth(x, z)
                    + corner_depth(x + 1, z)
                    + corner_depth(x, z + 1)
                    + corner_depth(x + 1, z + 1))
                    * 0.25;
                // The game samples the playable area and the terrain type at
                // the ogrid's far corner; past the last row or column that is
                // outside the map, where the terrain type is Default.
                let (ax, az) = (x + 1, z + 1);
                let (fx, fz) = (ax as f32, az as f32);
                let inside = tlx <= fx && brx >= fx && tlz <= fz && brz >= fz;
                let blocking = ax < width
                    && az < height
                    && BLOCKING_TERRAIN
                        .contains(&terrain.terrain_types[(az * width + ax) as usize]);
                open[cell] = inside && !blocking;
            }
        }
        Caches { flat, depth, open }
    }
}

/// The effect of `CompressedLabelTree.Compress`: every aligned block of
/// `block` ogrids that holds both pathable and unpathable ogrids becomes
/// unpathable as a whole.
fn apply_compression(pathable: &mut [bool], width: u32, height: u32, block: u32) {
    if block <= 1 {
        return;
    }
    let (width, height, block) = (width as usize, height as usize, block as usize);
    for bz in (0..height).step_by(block) {
        for bx in (0..width).step_by(block) {
            let (z_end, x_end) = ((bz + block).min(height), (bx + block).min(width));
            let first = pathable[bz * width + bx];
            let uniform = (bz..z_end).all(|z| {
                pathable[z * width + bx..z * width + x_end]
                    .iter()
                    .all(|cell| *cell == first)
            });
            if !uniform {
                for z in bz..z_end {
                    pathable[z * width + bx..z * width + x_end].fill(false);
                }
            }
        }
    }
}

/// The regions of ogrids linked by their sides (`GenerateLabels`), from 1.
fn label(layer: NavLayer, width: u32, height: u32, pathable: &[bool]) -> NavGrid {
    let (w, h) = (width as usize, height as usize);
    let mut cells = vec![0_u32; pathable.len()];
    let mut regions = Vec::new();
    let mut stack = Vec::new();
    for start in 0..pathable.len() {
        if !pathable[start] || cells[start] != 0 {
            continue;
        }
        let id = regions.len() as u32 + 1;
        let mut size = 0;
        cells[start] = id;
        stack.push(start);
        while let Some(cell) = stack.pop() {
            size += 1;
            let (x, z) = (cell % w, cell / w);
            let neighbours = [
                (x > 0).then(|| cell - 1),
                (x + 1 < w).then(|| cell + 1),
                (z > 0).then(|| cell - w),
                (z + 1 < h).then(|| cell + w),
            ];
            for neighbour in neighbours.into_iter().flatten() {
                if pathable[neighbour] && cells[neighbour] == 0 {
                    cells[neighbour] = id;
                    stack.push(neighbour);
                }
            }
        }
        regions.push(NavRegion {
            id,
            size,
            mass: 0,
            hydrocarbons: 0,
        });
    }
    NavGrid {
        layer,
        width,
        height,
        cells,
        regions,
    }
}

/// Counts each mass and hydrocarbon marker in the region of the ogrid it
/// stands on.
fn assign_resources(grid: &mut NavGrid, resources: &[Resource]) {
    for resource in resources {
        let (x, z) = (resource.x.floor(), resource.z.floor());
        if x < 0.0 || z < 0.0 || x >= grid.width as f32 || z >= grid.height as f32 {
            continue;
        }
        let id = grid.cells[(z as u32 * grid.width + x as u32) as usize];
        if id == 0 {
            continue;
        }
        let region = &mut grid.regions[id as usize - 1];
        if resource.hydrocarbon {
            region.hydrocarbons += 1;
        } else {
            region.mass += 1;
        }
    }
}

/// Removes the small regions without resources (`GenerateCullLabels`) and
/// numbers the rest again from 1.
fn cull(grid: &mut NavGrid) {
    let mut renumbered = vec![0_u32; grid.regions.len() + 1];
    let mut next = 1;
    for region in &grid.regions {
        let culled = region.size < CULL_BELOW_CELLS && region.mass == 0 && region.hydrocarbons == 0;
        if !culled {
            renumbered[region.id as usize] = next;
            next += 1;
        }
    }
    for cell in &mut grid.cells {
        *cell = renumbered[*cell as usize];
    }
    grid.regions
        .retain(|region| renumbered[region.id as usize] != 0);
    for region in &mut grid.regions {
        region.id = renumbered[region.id as usize];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A flat map of `size` by `size` ogrids at height `ground`, with the
    /// heights in `raise` (corner x, corner z, height) set higher.
    fn terrain(
        size: u32,
        ground: u16,
        water: Option<f32>,
        raise: &[(u32, u32, u16)],
    ) -> ScmapTerrain {
        let mut heights = vec![ground; ((size + 1) * (size + 1)) as usize];
        for (x, z, value) in raise {
            heights[(z * (size + 1) + x) as usize] = *value;
        }
        ScmapTerrain {
            version: 56,
            width: size,
            height: size,
            height_scale: 1.0,
            heights,
            water_elevation: water,
            terrain_types: vec![1; (size * size) as usize],
            props: Vec::new(),
        }
    }

    #[test]
    fn a_wall_of_cliffs_splits_the_land_in_two() {
        // A 40 by 40 map, cut down the middle by a ridge one corner wide.
        let raise: Vec<_> = (0..=40).map(|z| (20, z, 50)).collect();
        let map = terrain(40, 10, None, &raise);
        let navigation = generate(&map, &[], None);
        assert!(!navigation.has_water);
        // Both halves are 19 by 40 ogrids, over the 400 culling threshold.
        assert_eq!(navigation.land.regions.len(), 2);
        assert_eq!(navigation.land.cells[0], 1);
        assert_eq!(navigation.land.cells[39], 2);
        // The two ogrids beside the ridge are cliffs.
        assert_eq!(navigation.land.cells[19], 0);
        assert_eq!(navigation.land.cells[20], 0);
        // Without water, hover and amphibious move like land.
        assert_eq!(navigation.hover.cells, navigation.land.cells);
    }

    #[test]
    fn a_small_region_survives_only_with_a_resource_in_it() {
        // A plateau of 3 by 3 ogrids, walled by cliffs, on a 40 by 40 map.
        let mut raise = Vec::new();
        for z in 10..=13 {
            for x in 10..=13 {
                raise.push((x, z, 50));
            }
        }
        let map = terrain(40, 10, None, &raise);
        let bare = generate(&map, &[], None);
        let plateau = (11 * 40 + 11) as usize;
        assert_eq!(bare.land.cells[plateau], 0, "culled: small and empty");

        let mass = Resource {
            hydrocarbon: false,
            x: 11.5,
            z: 11.5,
        };
        let held = generate(&map, &[mass], None);
        let id = held.land.cells[plateau];
        assert_ne!(id, 0, "kept: it holds a mass point");
        assert_eq!(held.land.regions[id as usize - 1].mass, 1);
    }

    #[test]
    fn water_is_naval_deep_enough_and_amphibious_below_its_limit() {
        // Ground at 0 under water at 10: ten deep everywhere.
        let map = terrain(40, 0, Some(10.0), &[]);
        let navigation = generate(&map, &[], None);
        assert!(navigation.has_water);
        assert!(navigation.land.cells.iter().all(|cell| *cell == 0));
        assert!(navigation.naval.cells.iter().all(|cell| *cell == 1));
        assert!(navigation.amphibious.cells.iter().all(|cell| *cell == 1));
        assert!(navigation.hover.cells.iter().all(|cell| *cell == 1));
    }

    #[test]
    fn blocking_ground_and_the_playable_area_close_ogrids() {
        let mut map = terrain(40, 10, None, &[]);
        // Lava under the ogrid whose far corner is (6, 6).
        map.terrain_types[6 * 40 + 6] = 230;
        let navigation = generate(&map, &[], None);
        assert_eq!(navigation.land.cells[5 * 40 + 5], 0);
        assert_ne!(navigation.land.cells[0], 0);

        let area = Some(Area {
            x0: 0.0,
            z0: 0.0,
            x1: 33.0,
            z1: 33.0,
        });
        assert_eq!(playable_area("skirmish", area), area);
        assert_eq!(playable_area("campaign", area), None);
        let fenced = generate(&map, &[], playable_area("skirmish", area));
        assert_ne!(fenced.land.cells[31 * 40 + 31], 0);
        assert_eq!(fenced.land.cells[33 * 40 + 33], 0);
    }

    #[test]
    fn a_mixed_block_is_closed_whole_on_a_large_map() {
        let mut pathable = vec![true; 16];
        pathable[0] = false;
        apply_compression(&mut pathable, 4, 4, 2);
        assert_eq!(&pathable[0..2], [false, false]);
        assert_eq!(&pathable[4..6], [false, false]);
        assert!(pathable[2] && pathable[3] && pathable[15]);
    }
}
