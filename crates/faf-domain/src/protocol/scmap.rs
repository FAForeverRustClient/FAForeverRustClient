//! The parts of a `.scmap` that say where units can go and what there is to
//! reclaim: the heightmap, the water level, the terrain type of every ogrid,
//! and the props standing on the map.
//!
//! Everything else in the file (textures, lighting, decals, the normal and
//! stratum masks, the sky) is stepped over field by field, because the props
//! come last and a field skipped at the wrong width would put them anywhere.
//! The layout is faf-workshop's `ScmapParser.cs` (Garanas/faf-workshop, MIT),
//! which reads versions 53, 56 and 60 the way the engine does
//! (`CScmapLoader` in Draiget/faf-re).

/// The versions read. 53 is the original game's; 56 and 60 are what the
/// editors write today.
pub const SUPPORTED_VERSIONS: [i32; 3] = [53, 56, 60];

/// The widest map the game knows is 81 km, 4096 ogrids. A header asking for
/// more is damage, not a map, and is refused before anything is allocated.
const MAX_SIDE: i32 = 4096;

const MAGIC: i32 = 0x1a70_614d; // "Map\x1a"
const PREVIEW_MAGIC: u32 = 0xbeef_feed;

/// The heightmap, the water and the ground, as the engine reads them.
#[derive(Debug, Clone, PartialEq)]
pub struct ScmapTerrain {
    pub version: i32,
    /// In ogrids: the map's size in game units.
    pub width: u32,
    pub height: u32,
    /// What one heightmap step is in game units.
    pub height_scale: f32,
    /// `(width + 1) * (height + 1)` samples, row by row: the corners of the
    /// ogrids.
    pub heights: Vec<u16>,
    /// The water surface's height, where the map has water.
    pub water_elevation: Option<f32>,
    /// `width * height` terrain type codes (`lua/TerrainTypes.lua`).
    pub terrain_types: Vec<u8>,
    pub props: Vec<ScmapProp>,
}

/// A prop on the map: a tree, a rock, a wreck.
#[derive(Debug, Clone, PartialEq)]
pub struct ScmapProp {
    /// The prop's blueprint, as the file spells it:
    /// `/env/evergreen/props/trees/pine06_s1_prop.bp`.
    pub blueprint: String,
    /// Where it stands, in game units.
    pub x: f32,
    pub z: f32,
}

impl ScmapTerrain {
    /// The height at a heightmap corner, in game units.
    pub fn height_at(&self, x: u32, z: u32) -> f32 {
        f32::from(self.heights[(z * (self.width + 1) + x) as usize]) * self.height_scale
    }
}

/// Read a whole `.scmap`. Every byte must belong to it.
pub fn parse_scmap(bytes: &[u8]) -> Result<ScmapTerrain, String> {
    let mut r = Reader { bytes, at: 0 };

    if r.i32()? != MAGIC {
        return Err("not a map file".into());
    }
    let major = r.i32()?;
    if major != 2 {
        return Err(format!("unknown major version {major}"));
    }
    // The preview's header: its magic and version, the terrain's size as two
    // floats (the heightmap repeats it), a name in UTF-16 up to a zero, and
    // (tag, value) pairs.
    if r.u32()? != PREVIEW_MAGIC {
        return Err("the preview's header is missing".into());
    }
    let preview_version = r.i32()?;
    if preview_version != 2 {
        return Err(format!("unknown preview version {preview_version}"));
    }
    r.skip(8)?;
    while r.u16()? != 0 {}
    let pairs = r.count()?;
    r.skip_items(pairs, 8)?;
    let preview = r.count()?;
    r.skip(preview)?;

    let version = r.i32()?;
    if !SUPPORTED_VERSIONS.contains(&version) {
        return Err(format!("map version {version} is not one this reads"));
    }
    let width = r.i32()?;
    let height = r.i32()?;
    if !(1..=MAX_SIDE).contains(&width) || !(1..=MAX_SIDE).contains(&height) {
        return Err(format!("a map of {width} by {height} ogrids"));
    }
    let (width, height) = (width as u32, height as u32);
    let height_scale = r.f32()?;
    let samples = ((width + 1) * (height + 1)) as usize;
    let raw = r.take(samples * 2)?;
    let heights = raw
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect();

    if version >= 54 {
        r.skip(1)?; // whether the terrain shader is composite
    }
    r.string()?; // terrain shader
    r.string()?; // background
    r.string()?; // sky cubemap
    if version >= 55 {
        let cubemaps = r.count()?;
        for _ in 0..cubemaps {
            r.string()?;
            r.string()?;
        }
    } else {
        r.string()?;
    }
    // Lighting: multiplier, sun direction, ambience, colour, shadow fill
    // (four vectors of three), specular (four), bloom, fog colour (three),
    // fog start and end.
    r.skip(4 * (1 + 3 * 4 + 4 + 1 + 3 + 2))?;

    let water_elevation = read_water(&mut r)?;

    let wave_generators = r.count()?;
    for _ in 0..wave_generators {
        r.string()?; // texture
        r.string()?; // ramp
                     // position (3), rotation, velocity (3), then the two lifetimes,
                     // periods and scales, the frame count, two frame rates and the
                     // strip count
        r.skip(4 * (3 + 1 + 3 + 10))?;
    }

    if version >= 56 {
        // contour interval and five colours, and from 57 on an elevation offset
        r.skip(4 * 6 + if version >= 57 { 4 } else { 0 })?;
    }

    if version >= 54 {
        // ten albedo textures with their scale, then nine normal maps: the top
        // layer has none
        for _ in 0..10 {
            r.string()?;
            r.skip(4)?;
        }
        for _ in 0..9 {
            r.string()?;
            r.skip(4)?;
        }
    } else {
        r.string()?; // tileset
        r.skip(4)?; // a layer count the engine discards: it always reads six
        for _ in 0..6 {
            r.string()?;
            r.string()?;
            r.skip(8)?;
        }
    }

    r.skip(8)?; // the next decal id and the next decal group id
    let decals = r.count()?;
    for _ in 0..decals {
        r.skip(8)?; // id, type
        let textures = r.count()?;
        for _ in 0..textures {
            let length = r.count()?;
            r.skip(length)?;
        }
        // scale, position, rotation (three each), two cut-off distances, owner
        r.skip(4 * (9 + 2 + 1))?;
    }
    let groups = r.count()?;
    for _ in 0..groups {
        r.skip(4)?;
        r.string()?;
        let members = r.count()?;
        r.skip_items(members, 4)?;
    }

    // The normal map's tile size, then its tiles: the engine makes its own
    // from the heightmap.
    r.skip(8)?;
    let normal_maps = r.count()?;
    for _ in 0..normal_maps {
        let length = r.count()?;
        r.skip(length)?;
    }
    let stratum_masks = if version >= 54 { 2 } else { r.count()? };
    for _ in 0..stratum_masks {
        let length = r.count()?;
        r.skip(length)?;
    }
    // A count of water maps, of which the engine uses the first.
    let water_maps = r.count()?;
    if water_maps == 0 {
        return Err("the map has no water map".into());
    }
    for _ in 0..water_maps {
        let length = r.count()?;
        r.skip(length)?;
    }

    // Foam, flatness and depth bias at half the heightmap's size, then the
    // terrain types at its full size.
    let half = ((width / 2) * (height / 2)) as usize;
    r.skip(half * 3)?;
    let terrain_types = r.take((width * height) as usize)?.to_vec();

    if version >= 58 {
        skip_skybox(&mut r)?;
    }
    if version >= 59 {
        let batches = r.count()?;
        for _ in 0..batches {
            if version >= 60 {
                r.string()?; // technique
            }
            r.string()?; // texture
            let decals = r.count()?;
            r.skip_items(decals, 9 * 4)?;
        }
    }

    let count = r.count()?;
    let mut props = Vec::with_capacity(count.min(r.remaining() / 40));
    for _ in 0..count {
        let blueprint = r.string()?;
        let x = r.f32()?;
        r.skip(4)?; // height
        let z = r.f32()?;
        // three rotation vectors and the scale
        r.skip(4 * 12)?;
        props.push(ScmapProp { blueprint, x, z });
    }
    if r.remaining() != 0 {
        return Err(format!("{} bytes after the props", r.remaining()));
    }

    Ok(ScmapTerrain {
        version,
        width,
        height,
        height_scale,
        heights,
        water_elevation,
        terrain_types,
        props,
    })
}

/// The water block: whether there is water and its elevation, then the
/// rendering values this has no use for.
fn read_water(r: &mut Reader) -> Result<Option<f32>, String> {
    // Any byte other than 0 means water to the engine.
    let has_water = r.u8()? != 0;
    let elevation = r.f32()?;
    // deep and abyss elevations, surface colour (3), colour lerp (2),
    // refraction, fresnel bias and power, unit and sky reflection, sun
    // shininess and strength, sun direction (3) and colour (3), sun
    // reflection and glow
    r.skip(4 * (2 + 3 + 2 + 1 + 2 + 2 + 2 + 3 + 3 + 2))?;
    r.string()?; // cubemap
    r.string()?; // water ramp
    r.skip(4 * 4)?; // the four layers' repeats
    for _ in 0..4 {
        r.skip(8)?; // movement
        r.string()?; // texture
    }
    Ok(has_water.then_some(elevation))
}

fn skip_skybox(r: &mut Reader) -> Result<(), String> {
    // position (3), horizon height, scale, subtract height, two subdivision
    // counts, zenith height, horizon and zenith colour (3 each), decal glow
    r.skip(4 * (3 + 3 + 2 + 1 + 6 + 1))?;
    r.string()?; // albedo
    r.string()?; // glow
    let planets = r.count()?;
    r.skip_items(planets, 4 * (3 + 1 + 2 + 4))?;
    r.string()?; // cumulus light ramp
    r.string()?; // cumulus dispersion ramp
    r.string()?; // cumulus texture
    r.skip(4 * (1 + 3))?; // cirrus multiplier and colour
    r.string()?; // cirrus texture
                 // A count the engine ignores, then always four layers of five numbers.
    r.skip(4 + 4 * 4 * 5)?;
    Ok(())
}

/// Little-endian reads that refuse to run past the end.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn remaining(&self) -> usize {
        self.bytes.len() - self.at
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], String> {
        if length > self.remaining() {
            return Err(format!(
                "the map file ends early (needed {length} bytes at {}, {} left)",
                self.at,
                self.remaining()
            ));
        }
        let slice = &self.bytes[self.at..self.at + length];
        self.at += length;
        Ok(slice)
    }

    fn skip(&mut self, length: usize) -> Result<(), String> {
        self.take(length).map(|_| ())
    }

    /// `count` items of `size` bytes, without multiplying past the file.
    fn skip_items(&mut self, count: usize, size: usize) -> Result<(), String> {
        let length = count
            .checked_mul(size)
            .ok_or_else(|| "a count larger than any file".to_string())?;
        self.skip(length)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, String> {
        let b = self.take(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Result<u32, String> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn i32(&mut self) -> Result<i32, String> {
        Ok(self.u32()? as i32)
    }

    fn f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_bits(self.u32()?))
    }

    /// A count or a length, which cannot be negative.
    fn count(&mut self) -> Result<usize, String> {
        let value = self.i32()?;
        usize::try_from(value).map_err(|_| format!("a negative count ({value})"))
    }

    /// A string that ends in a zero byte.
    fn string(&mut self) -> Result<String, String> {
        let rest = &self.bytes[self.at..];
        let end = rest
            .iter()
            .position(|byte| *byte == 0)
            .ok_or_else(|| "the map file ends inside a string".to_string())?;
        let text = String::from_utf8_lossy(&rest[..end]).into_owned();
        self.at += end + 1;
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal version 56 map of `width` by `height` ogrids with the given
    /// water, terrain types and props, every other block empty.
    fn tiny_map(
        width: u32,
        height: u32,
        heights: &[u16],
        water: Option<f32>,
        terrain: &[u8],
        props: &[(&str, f32, f32)],
    ) -> Vec<u8> {
        let mut out = Vec::new();
        let i32s = |out: &mut Vec<u8>, value: i32| out.extend_from_slice(&value.to_le_bytes());
        let f32s = |out: &mut Vec<u8>, value: f32| out.extend_from_slice(&value.to_le_bytes());
        let string = |out: &mut Vec<u8>, text: &str| {
            out.extend_from_slice(text.as_bytes());
            out.push(0);
        };
        i32s(&mut out, MAGIC);
        i32s(&mut out, 2);
        out.extend_from_slice(&PREVIEW_MAGIC.to_le_bytes());
        i32s(&mut out, 2);
        f32s(&mut out, width as f32);
        f32s(&mut out, height as f32);
        out.extend_from_slice(&[0, 0]); // empty name
        i32s(&mut out, 0); // no pairs
        i32s(&mut out, 3); // a preview of three bytes
        out.extend_from_slice(&[1, 2, 3]);
        i32s(&mut out, 56);
        i32s(&mut out, width as i32);
        i32s(&mut out, height as i32);
        f32s(&mut out, 1.0 / 128.0);
        for sample in heights {
            out.extend_from_slice(&sample.to_le_bytes());
        }
        out.push(0); // composite shader
        string(&mut out, "TTerrain");
        string(&mut out, "/textures/environment/defaultbackground.dds");
        string(&mut out, "/textures/environment/defaultskycube.dds");
        i32s(&mut out, 1);
        string(&mut out, "<default>");
        string(&mut out, "/textures/environment/defaultenvcube.dds");
        out.extend_from_slice(&[0; 4 * 23]); // lighting
        out.push(u8::from(water.is_some()));
        f32s(&mut out, water.unwrap_or(17.5));
        out.extend_from_slice(&[0; 4 * 22]);
        string(&mut out, "cube");
        string(&mut out, "ramp");
        out.extend_from_slice(&[0; 16]);
        for _ in 0..4 {
            out.extend_from_slice(&[0; 8]);
            string(&mut out, "wave");
        }
        i32s(&mut out, 0); // wave generators
        out.extend_from_slice(&[0; 4 * 6]); // minimap
        for _ in 0..19 {
            string(&mut out, "/stratum.dds");
            f32s(&mut out, 4.0);
        }
        i32s(&mut out, 0); // next decal id
        i32s(&mut out, 0); // next group id
        i32s(&mut out, 0); // decals
        i32s(&mut out, 0); // groups
        i32s(&mut out, 256);
        i32s(&mut out, 256);
        i32s(&mut out, 0); // normal maps
        i32s(&mut out, 2); // two stratum masks of two bytes
        out.extend_from_slice(&[0, 0]);
        i32s(&mut out, 2);
        out.extend_from_slice(&[0, 0]);
        i32s(&mut out, 1); // one water map
        i32s(&mut out, 1);
        out.push(0);
        let half = ((width / 2) * (height / 2)) as usize;
        out.extend(std::iter::repeat_n(0, half * 3));
        out.extend_from_slice(terrain);
        i32s(&mut out, props.len() as i32);
        for (blueprint, x, z) in props {
            string(&mut out, blueprint);
            f32s(&mut out, *x);
            f32s(&mut out, 0.0);
            f32s(&mut out, *z);
            out.extend_from_slice(&[0; 4 * 12]);
        }
        out
    }

    #[test]
    fn a_map_reads_to_its_heights_water_ground_and_props() {
        let heights: Vec<u16> = (0..9).collect();
        let bytes = tiny_map(
            2,
            2,
            &heights,
            Some(12.0),
            &[1, 9, 220, 230],
            &[("/env/evergreen/props/trees/pine06_s1_prop.bp", 1.5, 0.5)],
        );
        let terrain = parse_scmap(&bytes).expect("a valid map");
        assert_eq!((terrain.width, terrain.height), (2, 2));
        assert_eq!(terrain.heights, heights);
        assert_eq!(terrain.water_elevation, Some(12.0));
        assert_eq!(terrain.terrain_types, [1, 9, 220, 230]);
        assert_eq!(terrain.props.len(), 1);
        assert_eq!(terrain.props[0].x, 1.5);
        assert_eq!(terrain.props[0].z, 0.5);
        assert_eq!(terrain.height_at(2, 2), 8.0 / 128.0);
    }

    #[test]
    fn a_map_without_water_says_so() {
        let bytes = tiny_map(2, 2, &[0; 9], None, &[1; 4], &[]);
        assert_eq!(parse_scmap(&bytes).unwrap().water_elevation, None);
    }

    #[test]
    fn damage_is_refused() {
        let bytes = tiny_map(2, 2, &[0; 9], None, &[1; 4], &[]);
        assert!(parse_scmap(&bytes[..bytes.len() - 1]).is_err(), "cut short");
        let mut longer = bytes.clone();
        longer.push(0);
        assert!(parse_scmap(&longer).is_err(), "trailing bytes");
        assert!(parse_scmap(b"not a map").is_err());
    }
}
