//! What the page's native requests (`ui/src/ipc/native.ts`) answer with, when
//! `faf-app`'s adapters build the answer: plain data that crosses the shell
//! boundary outside [`crate::AppState`].
//!
//! Here rather than beside the adapters because the bindings export in
//! `faf-ipc` sees this crate and not `faf-app`, and a type it cannot see is a
//! type the frontend has to write out by hand. What only the shell builds is
//! in `faf_ipc::shell`.
//!
//! Specta refuses `usize` (a count past 2^53 would not survive as a JavaScript
//! number), so the counts below are exported as `u32`, which they never pass.

use serde::Serialize;
use specta::Type;

use crate::protocol::navigation::NavLayer;

/// What the map dialog draws: an installed map's pathing regions per layer
/// and its reclaim, over its preview.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MapAnalysis {
    /// The `.scmap`'s preview, the picture the layers are drawn over.
    pub preview: String,
    /// In ogrids.
    pub width: u32,
    pub height: u32,
    pub has_water: bool,
    /// Land first; hover, amphibious and naval only on a map with water.
    pub layers: Vec<MapLayerPicture>,
    pub reclaim: ReclaimPicture,
}

/// One pathing layer of a [`MapAnalysis`].
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MapLayerPicture {
    pub layer: NavLayer,
    /// Regions the layer is divided into after culling.
    #[specta(type = u32)]
    pub regions: usize,
    /// The share of the map, from 0 to 1, units of the layer can reach.
    pub reachable: f32,
    /// `data:image/png;base64,...`: each region its own colour, where the
    /// layer cannot go dark, the size of the map.
    pub image: String,
}

/// The reclaim of a [`MapAnalysis`].
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReclaimPicture {
    pub mass: f64,
    pub energy: f64,
    #[specta(type = u32)]
    pub props: usize,
    /// Props whose blueprint was found and so counted.
    #[specta(type = u32)]
    pub valued: usize,
    /// Where the mass is: brighter where there is more.
    pub image: String,
}

/// A map's clean picture and its markers, in map units.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
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

/// The pictures the installed game has, by the names the page asks for them
/// on the shell's `unit-icon` scheme.
#[derive(Debug, Clone, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnitIconNames {
    /// Upper-case blueprint ids.
    pub units: Vec<String>,
    /// Lower-case strategic icon names, `icon_land1_directfire`.
    pub strategic: Vec<String>,
}
