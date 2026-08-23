#!/usr/bin/env python3
"""Read terrain themes and water coverage out of Supreme Commander map files.

This is a one-off migration tool, not part of the client. It exists to fill the
API once: after the values are on `map_version`, the client only ever asks the
API and this script is obsolete. That is exactly why it is a standalone script
with no dependencies and no build step, and why it lives outside the Rust
workspace: nothing here should ever end up compiled into the client.

Usage
-----
    python map_terrain.py [--out FILE] [--sql FILE] [--jobs N] <path>...

Each path may be a map zip, an extracted map folder, a loose `.scmap`, or a
directory holding any of those at any depth. Terrain files fetched on their own
are usually named for the map rather than for the version; pass `--names` with
the JSON list of version names to put the two back together. A directory carrying a map's
scenario is a map folder and is taken whole; one that just contains terrain
files is a dump and each file is taken separately.

Output is JSON Lines, one object per map, written as the run goes so a crash
part-way through costs only what had not been written yet.

Format versions
---------------
Four are in the wild and they disagree in four places, none of which the file
announces. Measured, not guessed:

===========  =========  ==========  ==================  =============
minor        padding    cubemaps    stratum preamble    mask textures
===========  =========  ==========  ==================  =============
53           no         one         (tileset + count)   one, counted
54           yes        one         none                two
56           yes        counted     24 bytes            two
60           yes        counted     28 bytes            two
===========  =========  ==========  ==================  =============

Requires Python 3.8+ and nothing else.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import struct
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor

try:
    import numpy
except ImportError:
    # Optional, and only ever a speed difference: the pure-Python path below
    # produces identical numbers, it just walks a quarter of a million pixels an
    # element at a time. Roughly 5 minutes versus 30 seconds for a 430-map
    # folder, so install it before a vault-sized run if you can.
    numpy = None

# --------------------------------------------------------------------------
# Biome classification
# --------------------------------------------------------------------------

# The `/env/<folder>/` a terrain texture comes from is the classification: the
# game ships its textures in themed libraries, so the value set is fixed by the
# game and not by taste. Folder names are matched lower-cased because real maps
# spell them every way (`Evergreen2`, `Red Barrens`, `Seraphim II`), often
# several ways inside one file.
BIOMES = {
    "evergreen": "EVERGREEN",
    "evergreen2": "EVERGREEN",
    "evergreen3": "EVERGREEN",
    "desert": "DESERT",
    "tundra": "TUNDRA",
    "red barrens": "RED_BARRENS",
    "redbarrens": "RED_BARRENS",
    "tropical": "TROPICAL",
    "lava": "LAVA",
    "paradise": "PARADISE",
    "crystalline": "CRYSTALLINE",
    "geothermal": "GEOTHERMAL",
    "swamp": "SWAMP",
    "ancient-earth": "ANCIENT_EARTH",
    "ancientearth": "ANCIENT_EARTH",
    "newrealms": "NEW_REALMS",
    "seraphim ii": "SERAPHIM",
    "seraphimii": "SERAPHIM",
    "seraphim": "SERAPHIM",
    "wasteland": "WASTELAND",
}

# Shared between every theme, so ground painted with them is evidence for none
# of them. Distinct from "a folder nobody has classified yet", which is a gap in
# the table and gets reported at the end of a run.
SHARED_FOLDERS = {"common", "utility"}

# A map is stored as one biome: the one covering most of its ground. Every share
# still goes into the JSON Lines output, so the choice can be revisited from
# that file rather than by reading the maps again; only what the database keeps
# is narrowed to the leading one.
#
# Coverage at or above which a share is worth reporting at all. Below this it is
# a mapper blending an edge, not a theme the map has.
MINIMUM_BIOME_PERCENT = 1

# Below this a texture is a mapper blending an edge, not evidence of anything.
MINIMUM_TEXTURE_PERCENT = 1


def texture_folder(path):
    """The `/env/<folder>/` a texture path names, if it names one."""
    parts = path.strip().lower().replace("\\", "/").lstrip("/").split("/")
    if len(parts) < 2:
        return None
    return parts[1] if parts[0] == "env" else None


def biome_of(path):
    """The biome value a texture path belongs to, or None when it says nothing.

    A map's own textures live under `/maps/<map>/env/layers/` and cannot be
    classified by name, so they are CUSTOM rather than a guess.

    An `/env/` folder the table does not know is CUSTOM for the same reason.
    The libraries are fixed by what the game and FAF ship, and both were
    enumerated to build the table above: every folder in either that contains a
    `layers/` directory is mapped. So a folder that is neither in the table nor
    shared did not come from the game at all, which leaves the mapper, who put
    their own textures under `/env/` instead of under their map. That is the
    same thing `/maps/` means, and it gets the same answer.

    It is still counted as a gap and reported at the end of a run: if a future
    FAF patch ships a new library, it must be visible and not quietly absorbed.
    """
    cleaned = path.strip().lower().replace("\\", "/").lstrip("/")
    if not cleaned:
        return None
    parts = cleaned.split("/")
    if len(parts) < 2:
        return None
    if parts[0] == "maps":
        return "CUSTOM"
    if parts[0] == "env":
        folder = parts[1]
        if folder in SHARED_FOLDERS:
            return None
        return BIOMES.get(folder, "CUSTOM")
    return None


# Three maps are played so much that every variant of them is its own thing: a
# player looking for Setons wants all sixty-odd Setons, not "the evergreen naval
# maps". They are recognised by name and not by terrain, because that is what
# distinguishes them: `astro_seton` and `Setons - 64 FFA` are painted alike and
# are different maps to anybody choosing one.
#
# Matched against the name with every separator and capital stripped, so
# `Dual Gap`, `dual_gap`, `DualGap` and `adaptive_dualgap_survival` all land in
# one place. Deliberately narrow: `dualgap` and not `gap`, so `adaptive_quad_gap`,
# `antigap` and `artem_gap` stay out.
# `scmp009` is there because the stock Setons Clutch ships under a numbered
# folder name and would otherwise be the one Setons map the rule misses.
MAP_FAMILIES = (
    ("ASTRO_CRATER", ("astro",)),
    ("DUAL_GAP", ("dualgap",)),
    ("SETONS", ("seton", "scmp009")),
)


def map_families(name):
    """Every family a map's name matches, in the order the tokens appear in it.

    A handful of maps are hybrids (`astro_seton`, `astrocrater_dualgap_players`)
    and match two. Returning all of them keeps that visible; the first is the
    one to use, and going by where the token appears rather than by a fixed
    priority means the name itself decides.
    """
    cleaned = re.sub(r"[^a-z0-9]", "", name.lower())
    found = []
    for family, tokens in MAP_FAMILIES:
        at = [cleaned.index(token) for token in tokens if token in cleaned]
        if at:
            found.append((min(at), family))
    found.sort()
    return [family for _, family in found]


def map_family(name):
    """The family a map belongs to, or None."""
    families = map_families(name)
    return families[0] if families else None


# --------------------------------------------------------------------------
# .scmap decoding
# --------------------------------------------------------------------------

MAGIC = b"Map\x1a"
DDS_HEADER_LEN = 128
MAX_DIMENSION = 8192
MAX_STRATA = 10

# `A8R8G8B8` is `B, G, R, A` in memory, and the four strata a mask texture
# carries are its `R, G, B, A` in that order. So stratum 0 is byte 2.
CHANNEL_ORDER = (2, 1, 0, 3)

# `Terrain<family><range><variant>`, the FAF composite family. The middle digit
# is the one that matters here: 5 means the masks were painted for the half
# range, 0 for the full one. `Terrain251` is the half-range twin of
# `Terrain201`, and so on through the family.
FAF_TECHNIQUE = re.compile(r"^Terrain(\d)(\d)(\d)", re.IGNORECASE)


def uses_half_range(shader):
    """Whether this map's shader sharpens the stratum masks before blending.

    The legacy shaders read the *same* mask texture at two different ranges:
    albedo through `saturate(mask * 2 - 1)`, so only 0.5-1.0 is live, and
    normals through plain `saturate(mask)`. Only the albedo matters here, since
    the question is what the ground looks like.

    That inconsistency is why the FAF family splits in two, and the split is
    written into the technique names:

    * `TTerrain`, `TTerrainXP`, `TTerrainGlow`, `TTerrainXPExt` - half range.
    * `Terrain<f>5<v>` (`Terrain050`, `Terrain151`, `Terrain251`, ...) - half.
    * `Terrain<f>0<v>` (`Terrain000`, `Terrain200`, `Terrain301`, ...) - full.

    Getting this wrong is not cosmetic: reading a half-range map at full range
    counts every faint sweep of a texture as real ground, and reading a
    full-range map at half range throws away everything painted below half
    strength. A census of 429 maps found `Terrain200`, which is full range, on
    17 of them and growing, so assuming half range everywhere is not safe.

    Unknown names fall back to half range, the legacy convention that 94% of
    maps use.
    """
    name = str(shader or "").strip()
    if name.upper().startswith("TTERRAIN"):
        return True
    match = FAF_TECHNIQUE.match(name)
    if match:
        return match.group(2) == "5"
    return True


class ScmapError(Exception):
    pass


class Reader:
    """A bounds-checked sequential reader.

    Every length in the format comes out of the file itself, so a walk that
    loses its place reads a texture path as a count. Checking each read is what
    turns that into an error instead of a hang.
    """

    __slots__ = ("data", "offset")

    def __init__(self, data):
        self.data = data
        self.offset = 0

    def take(self, length):
        end = self.offset + length
        if length < 0 or end > len(self.data):
            raise ScmapError("the .scmap file ends mid-field")
        chunk = self.data[self.offset:end]
        self.offset = end
        return chunk

    def skip(self, length):
        self.take(length)

    def u8(self):
        return self.take(1)[0]

    def i32(self):
        return struct.unpack("<i", self.take(4))[0]

    def u32(self):
        return struct.unpack("<I", self.take(4))[0]

    def f32(self):
        return struct.unpack("<f", self.take(4))[0]

    def string(self):
        end = self.data.find(b"\0", self.offset)
        if end < 0:
            raise ScmapError("the .scmap file ends mid-field")
        text = self.data[self.offset:end].decode("latin-1")
        self.offset = end + 1
        return text

    def count(self, field, maximum):
        value = self.i32()
        if value < 0 or value > maximum:
            raise ScmapError("implausible %s in the .scmap file" % field)
        return value

    def dimension(self, field):
        value = self.i32()
        if value <= 0 or value > MAX_DIMENSION:
            raise ScmapError("implausible %s in the .scmap file" % field)
        return value


def read_mask(dds):
    """One mask texture out of its DDS wrapper.

    Only uncompressed 32-bit is accepted. Every mask across a 427-map corpus is
    stored that way; a compressed one would decode to something plausible under
    the wrong assumption, and a wrong biome is worse than none.
    """
    if len(dds) < DDS_HEADER_LEN or dds[0:4] != b"DDS ":
        raise ScmapError("the terrain masks are in an unsupported texture format")
    height, width = struct.unpack_from("<II", dds, 12)
    four_cc, bit_count = struct.unpack_from("<II", dds, 84)
    if four_cc != 0 or bit_count != 32:
        raise ScmapError("the terrain masks are in an unsupported texture format")
    if not (0 < width <= MAX_DIMENSION) or not (0 < height <= MAX_DIMENSION):
        raise ScmapError("implausible mask size in the .scmap file")
    needed = width * height * 4
    body = dds[DDS_HEADER_LEN:DDS_HEADER_LEN + needed]
    if len(body) < needed:
        raise ScmapError("the terrain masks are in an unsupported texture format")
    return width, height, body


# How many opaque bytes sit between the wave generators and the stratum list.
# It grew over the versions, and there is nothing in the file that announces it.
# Measured: 54 has none, 56 has 24, and 60 has four more in front of those.
STRATUM_PREAMBLE = ((60, 28), (56, 24), (54, 0))


def read_strata(r, minor):
    """The stratum list, which is where the format versions differ most."""
    if minor < 54:
        # The original layout: a named tileset, a count, and each stratum's
        # albedo and normal together.
        r.string()
        count = r.count("stratum count", MAX_STRATA)
        strata = []
        for _ in range(count):
            albedo = r.string()
            r.string()          # normal
            r.skip(4 + 4)       # the two texture scales
            strata.append(albedo)
        return strata

    # From minor 54 the count is fixed at ten albedo strata and nine normals,
    # and an opaque run of a version-dependent length sits in front of the list.
    r.skip(next(size for since, size in STRATUM_PREAMBLE if minor >= since))
    strata = []
    for _ in range(MAX_STRATA):
        strata.append(r.string())
        r.skip(4)               # scale
    # Nine, not ten: the macrotexture is laid over the finished ground and has
    # no normal of its own.
    for _ in range(MAX_STRATA - 1):
        r.string()
        r.skip(4)
    return strata


def skip_decals(r):
    """Walk past the decals and decal groups.

    Decals carry `/env/<theme>/decals/` paths and deliberately do not count: a
    decal is scattered detail with no area, there are thousands per map, and
    what is under them is what the map looks like.
    """
    r.skip(4 + 4)               # two values that vary per map and mean nothing here
    for _ in range(r.count("decal count", 1 << 20)):
        r.skip(4 + 4)           # id, type
        for _ in range(r.count("decal texture count", 8)):
            # Length-prefixed here, unlike every other string in the format.
            r.skip(r.u32())
        r.skip(12 * 3 + 4 + 4 + 4)
    for _ in range(r.count("decal group count", 1 << 16)):
        r.skip(4)
        r.string()
        r.skip(r.count("decal group size", 1 << 20) * 4)


def read_terrain(data):
    """Decode a `.scmap` far enough to describe its terrain.

    Only the parts that answer "what does this map look like": the heightmap and
    water surface, the stratum texture paths, and the masks that place them.
    Everything between is walked past, because the layout is sequential and
    there is no index to seek with.
    """
    if len(data) < len(MAGIC) or data[:len(MAGIC)] != MAGIC:
        raise ScmapError("not a .scmap file")
    r = Reader(data)
    r.skip(len(MAGIC))
    r.skip(4 + 4 + 4)           # major version and two constants nothing varies
    r.skip(4 + 4)               # width and height again, as floats
    r.skip(4 + 2)               # two more header fields, zero in every map measured
    r.skip(r.u32())             # the preview image

    minor = r.i32()
    width = r.dimension("map width")
    height = r.dimension("map height")
    height_scale = r.f32()
    # A sample at every corner, so one wider and one taller than the terrain.
    heightmap = r.take((width + 1) * (height + 1) * 2)

    if minor >= 54:
        # Padding, empty in every map measured. It arrives one version before
        # the named cubemaps below do: minor 54 has this and not those, which is
        # the only thing that makes it its own layout rather than 53's or 56's.
        r.string()
    shader = r.string()         # terrain shader, `TTerrain` and friends
    r.string()                  # background texture
    r.string()                  # sky cubemap
    if minor < 56:
        r.string()              # the one environment cubemap, unnamed
    else:
        for _ in range(r.count("cubemap count", 64)):
            r.string()          # the name the shader looks it up by
            r.string()

    # Lighting: multiplier, four colour vectors, specular, bloom, fog.
    r.skip(4 + 4 * 12 + 16 + 4 + 12 + 4 + 4)

    has_water = r.u8() != 0
    water_elevation = r.f32()
    r.skip(4 + 4)               # deep and abyss elevations: colour only
    r.skip(12 + 8)              # surface colour, colour lerp
    r.skip(4 * 7)               # refraction, fresnel, reflections, sun shininess/strength
    r.skip(12 + 12)             # sun direction and colour
    r.skip(4 + 4)               # sun reflection and glow
    r.string()                  # water cubemap
    r.string()                  # water ramp
    r.skip(4 * 4)               # the four normal-map repeats
    for _ in range(4):
        r.skip(8)               # movement
        r.string()

    # Wave generators: long lists (Seton's has nearly seven thousand) of a
    # fixed-size record, none of which is needed here.
    for _ in range(r.count("wave generator count", 1 << 20)):
        r.string()
        r.string()
        r.skip(12 + 4 + 12 + 10 * 4)

    strata = read_strata(r, minor)
    skip_decals(r)

    r.skip(4 + 4)               # the terrain size once more
    for _ in range(r.count("normal map count", 16)):
        r.skip(r.u32())

    # One counted mask texture before minor 54; from there on two, and the
    # count went away with the change.
    mask_count = r.count("mask texture count", 4) if minor < 54 else 2
    masks = [read_mask(r.take(r.u32())) for _ in range(mask_count)]

    return {
        "shader": shader,
        "minor": minor,
        "width": width,
        "height": height,
        "height_scale": height_scale,
        "heightmap": heightmap,
        "has_water": has_water,
        "water_elevation": water_elevation,
        "strata": strata,
        "masks": masks,
    }


# --------------------------------------------------------------------------
# Weighing
# --------------------------------------------------------------------------

def water_share(terrain):
    """Fraction of the terrain grid below the water surface.

    The plain flooded area, with no attempt to discount shallows or impassable
    ground: what counts as "real" water depends on what it is being asked for,
    and a number that quietly answers a different question is worse than a blunt
    one.
    """
    if not terrain["has_water"] or terrain["height_scale"] <= 0:
        return 0.0
    heightmap = terrain["heightmap"]
    samples = len(heightmap) // 2
    if samples == 0:
        return 0.0
    surface = terrain["water_elevation"] / terrain["height_scale"]
    values = struct.unpack("<%dH" % samples, heightmap[:samples * 2])
    return sum(1 for value in values if value < surface) / samples


def stratum_coverage(terrain, half_range=None, land_only=True):
    """How much of the visible ground each stratum covers, aligned with `strata`.

    This is the blend the game performs, not a count of which mask is largest at
    each pixel. Layers are painted over one another with their mask as opacity,
    so the ground you see at a pixel is the *last* layer with a strong mask
    there, not the strongest. Compositing top-down gives every layer its visible
    area and leaves the base stratum whatever nothing else covered.

    The masks are sharpened first, through `saturate(2m - 1)`, because that is
    what the terrain shader does before it blends: anything painted below half
    strength draws nothing at all. Skipping that step makes a texture laid
    thinly across a wide area look like real coverage when none of it is
    visible. See `uses_half_range`.

    Only the ground above the water surface is weighed, because that is the only
    ground anybody sees. See `dry_pixels`.

    Cross-checked against ForgeMapToolkit's `terrainTypeLogic.js`, which derives
    the same weights from FA's `FaTerrainShader.shader` for its TerrainType
    auto-paint. It assumes the sharpening for every map; this reads the shader
    the map names and follows that instead, because the FAF techniques come in
    both conventions.
    """
    strata = terrain["strata"]
    coverage = [0.0] * len(strata)
    if not strata:
        return coverage

    masks = terrain["masks"]
    pixels = masks[0][0] * masks[0][1] if masks else 0
    usable = 0
    for width, height, _ in masks:
        if width * height != pixels:
            break
        usable += 1

    # The painted layers sit between the base and the macrotexture, and are
    # capped by how many mask channels the file actually carries. An unpainted
    # stratum draws nothing, so it takes no coverage from the layers under it
    # either: Seton's is the case that proves it, because its exporter wrote the
    # same mask twice and its four empty strata hold the first four's data.
    layers = []
    for index in range(1, min(len(strata) - 1, usable * 4 + 1)):
        if not strata[index].strip():
            continue
        layers.append((index, (index - 1) // 4, CHANNEL_ORDER[(index - 1) % 4]))

    base_painted = bool(strata[0].strip())
    if pixels > 0:
        if half_range is None:
            half_range = uses_half_range(terrain.get("shader"))
        keep = dry_pixels(terrain, masks[0][0], masks[0][1]) if land_only else None
        # A map that is entirely flooded has no visible ground to weigh, so
        # there the sea floor is all there is to go on.
        if keep is not None and len(keep) == 0:
            keep = None
        bodies = [body for _, _, body in masks]
        composite = _composite_numpy if numpy is not None else _composite_python
        covered, base_covered = composite(layers, bodies, pixels, half_range, keep)
    elif base_painted:
        # No masks to read, but the base stratum still says what the ground is.
        covered, base_covered = {}, 1.0
    else:
        covered, base_covered = {}, 0.0

    total = base_covered + sum(covered.values())
    if total <= 0.0:
        return coverage
    if base_painted:
        coverage[0] = base_covered / total
    for index, amount in covered.items():
        coverage[index] = amount / total
    return coverage


def dry_pixels(terrain, mask_width, mask_height):
    """The mask pixels that sit above the water surface, or None for all of them.

    Ground under water is not ground anybody sees, and sea floors are routinely
    painted with a sand texture that says nothing about how the map reads: a
    green island map with a sandy seabed would otherwise come out as desert.

    The masks are usually half the terrain resolution while the heightmap is one
    sample wider and taller than the terrain, so each mask pixel is resolved to
    its nearest heightmap sample rather than assuming the two grids line up.

    Returns a list of pixel indices, or None when the map has no water and every
    pixel counts.
    """
    if not terrain["has_water"] or terrain["height_scale"] <= 0:
        return None
    width, height = terrain["width"], terrain["height"]
    stride = width + 1
    heightmap = terrain["heightmap"]
    if len(heightmap) < stride * (height + 1) * 2:
        return None
    surface = terrain["water_elevation"] / terrain["height_scale"]

    if numpy is not None:
        samples = numpy.frombuffer(heightmap, dtype="<u2",
                                   count=stride * (height + 1)).reshape(height + 1, stride)
        # The centre of the terrain each mask pixel covers, not its edge: at
        # half resolution a mask pixel spans two cells, and sampling the corner
        # between them answers for the neighbour as often as for itself.
        rows = ((numpy.arange(mask_height) + 0.5) * height / mask_height).astype(int)
        cols = ((numpy.arange(mask_width) + 0.5) * width / mask_width).astype(int)
        dry = samples[numpy.ix_(rows, cols)] >= surface
        return numpy.flatnonzero(dry.reshape(-1))

    keep = []
    for y in range(mask_height):
        row = int((y + 0.5) * height / mask_height) * stride
        for x in range(mask_width):
            offset = (row + int((x + 0.5) * width / mask_width)) * 2
            if (heightmap[offset] | (heightmap[offset + 1] << 8)) >= surface:
                keep.append(y * mask_width + x)
    return keep


def _composite_python(layers, bodies, pixels, half_range, keep=None):
    """Composite the layers one pixel at a time. Exact, and slow."""
    covered = collections.defaultdict(float)
    base_covered = 0.0
    for pixel in (range(pixels) if keep is None else keep):
        remaining = 1.0
        base = pixel * 4
        for index, texture, channel in reversed(layers):
            mask = bodies[texture][base + channel] / 255.0
            if half_range:
                mask = min(1.0, max(0.0, 2.0 * mask - 1.0))
            if mask <= 0.0:
                continue
            share = mask * remaining
            covered[index] += share
            remaining -= share
            if remaining <= 0.0:
                break
        if remaining > 0.0:
            base_covered += remaining
    return covered, base_covered


def _composite_numpy(layers, bodies, pixels, half_range, keep=None):
    """The same composite, whole channels at a time.

    Identical arithmetic to `_composite_python`, expressed over arrays: a
    layer's visible area is its own mask times what every layer above it left
    uncovered, so walking top-down and carrying a `remaining` array is the same
    recurrence without the per-pixel loop.
    """
    covered = {}
    remaining = numpy.ones(pixels if keep is None else len(keep), dtype=numpy.float32)
    for index, texture, channel in reversed(layers):
        mask = numpy.frombuffer(bodies[texture], dtype=numpy.uint8, count=pixels * 4)
        mask = mask[channel::4]
        if keep is not None:
            mask = mask[keep]
        mask = mask.astype(numpy.float32) / numpy.float32(255.0)
        if half_range:
            mask = numpy.clip(mask * numpy.float32(2.0) - numpy.float32(1.0), 0.0, 1.0)
        share = mask * remaining
        total = float(share.sum())
        # A layer the sharpening wiped out is left out of the result entirely,
        # the way the per-pixel path skips it: same numbers, same keys.
        if total > 0.0:
            covered[index] = total
        remaining -= share
    return covered, float(remaining.sum())


def percent(share):
    return max(0, min(100, int(round(share * 100))))


def classify_strata(strata, coverage):
    """Sum one map's stratum coverage by texture path and by biome.

    Returns `(by_path, by_biome, unclassified)`. Separate from `describe` so it
    can be exercised on its own: it holds every judgement about what a texture
    means, while `describe` only shapes the record around it.
    """
    # Several strata can name the same texture, so coverage is summed per path:
    # "this map is 40% evgrass005" is the useful fact.
    by_path = collections.OrderedDict()
    by_biome = collections.OrderedDict()
    unclassified = []
    for albedo, share in zip(strata, coverage):
        if not albedo.strip():
            continue
        by_path[albedo] = by_path.get(albedo, 0.0) + share
        biome = biome_of(albedo)
        # Reported even though it now classifies as CUSTOM: a library the table
        # does not know is either a mapper's own textures or one FAF has newly
        # shipped, and only the tally tells the two apart.
        folder = texture_folder(albedo)
        if folder is not None and folder not in SHARED_FOLDERS and folder not in BIOMES:
            unclassified.append(folder)
        if biome is None:
            # Ground painted from a shared library belongs to no theme and is
            # deliberately not redistributed either.
            continue
        by_biome[biome] = by_biome.get(biome, 0.0) + share
    return by_path, by_biome, unclassified


def describe(name, source, data):
    """One map's record, or a failure record if it cannot be read."""
    terrain = read_terrain(data)
    coverage = stratum_coverage(terrain)
    by_path, by_biome, unclassified = classify_strata(terrain["strata"], coverage)

    biomes = [
        {"biome": biome, "percent": percent(share)}
        for biome, share in by_biome.items()
        if percent(share) >= MINIMUM_BIOME_PERCENT
    ]
    biomes.sort(key=lambda entry: (-entry["percent"], entry["biome"]))
    textures = [
        {"path": path, "percent": percent(share)}
        for path, share in by_path.items()
        if percent(share) >= MINIMUM_TEXTURE_PERCENT
    ]
    textures.sort(key=lambda entry: (-entry["percent"], entry["path"]))

    families = map_families(name)
    record = {
        "name": name,
        "source": source,
        "family": families[0] if families else None,
        "scmapVersion": terrain["minor"],
        "shader": terrain["shader"],
        "width": terrain["width"],
        "height": terrain["height"],
        "waterPercent": percent(water_share(terrain)),
        "biomes": biomes,
        "textures": textures,
    }
    if len(families) > 1:
        record["families"] = families
    return record, unclassified


# --------------------------------------------------------------------------
# Input
# --------------------------------------------------------------------------

MAX_DEPTH = 8
MAX_SCMAP_BYTES = 256 * 1024 * 1024


def scmaps_in_folder(folder):
    """Every `.scmap` directly inside `folder`, sorted."""
    found = []
    try:
        for entry in os.scandir(folder):
            if entry.is_file() and entry.name.lower().endswith(".scmap"):
                found.append(entry.path)
    except OSError:
        pass
    found.sort()
    return found


def looks_like_map_folder(folder):
    """Does this directory hold an installed map, rather than a pile of files?

    A map folder always carries the scenario the game loads it through. That is
    the marker, and not the terrain-file count: three folders in a stock install
    hold two `.scmap` files, an `_old` leftover or a second variant beside the
    real one, and counting would split one map version into two rows.

    A directory with terrain but no scenario is still taken as a map folder when
    it holds exactly one `.scmap` and no archives, since there is nothing else
    it could be.
    """
    try:
        entries = list(os.scandir(folder))
    except OSError:
        return False
    names = [entry.name.lower() for entry in entries if entry.is_file()]
    if not any(name.endswith(".scmap") for name in names):
        return False
    if any(name.endswith("_scenario.lua") for name in names):
        return True
    terrain = [name for name in names if name.endswith(".scmap")]
    return len(terrain) == 1 and not any(name.endswith(".zip") for name in names)


def scmap_in_folder(folder):
    """The `.scmap` a map folder is about.

    Where there are several, the one named after the folder wins: that is the
    live map, and the others are leftovers (`..._old.scmap`). Falling back to
    the first by name keeps it deterministic when nothing matches, which beats
    depending on the order the filesystem happens to list.
    """
    found = scmaps_in_folder(folder)
    if not found:
        return None
    base = os.path.basename(folder.rstrip("/" + chr(92))).lower()
    # `scmp_009.v0001` on disk holds `SCMP_009.scmap`, so compare without the
    # version suffix as well.
    stems = {base, base.rsplit(".v", 1)[0] if ".v" in base else base}
    for path in found:
        stem = os.path.basename(path)[:-len(".scmap")].lower()
        if stem in stems:
            return path
    return found[0]


def collect(path, depth, found):
    """Every map under `path`, by the rules in the module docstring."""
    if os.path.isfile(path):
        # A loose `.scmap` counts as well as a zip. Whoever is feeding this may
        # have pulled the terrain files alone rather than the archives, and
        # finding nothing would be a confusing way to say so.
        if path.lower().endswith(".zip") or path.lower().endswith(".scmap"):
            found.append(path)
        return
    if not os.path.isdir(path) or depth > MAX_DEPTH:
        return
    # A map folder is taken whole and not descended into: it carries an `env/`
    # of its own, and its name is the map version, which a terrain file inside
    # it does not reliably repeat. Anything else is a container: take the loose
    # terrain files and archives in it, and look inside its subdirectories.
    if looks_like_map_folder(path):
        found.append(path)
        return
    found.extend(scmaps_in_folder(path))
    try:
        for entry in sorted(os.scandir(path), key=lambda e: e.name):
            if entry.is_dir():
                collect(entry.path, depth + 1, found)
            elif entry.name.lower().endswith(".zip"):
                found.append(entry.path)
    except OSError:
        pass


def map_name(path):
    """The map version's folder name.

    A zip's or a loose terrain file's stem, or the folder's own name. For a
    loose `.scmap` that is only as good as whatever named the file: inside an
    archive the terrain is often `SCMP_009.scmap` while the version is
    `scmp_009.v0001`, so prefer feeding zips or folders where the name matters.
    """
    base = os.path.basename(path.rstrip("/\\"))
    for suffix in (".zip", ".scmap"):
        if base.lower().endswith(suffix):
            return base[:-len(suffix)]
    return base


def read_scmap(path):
    if path.lower().endswith(".scmap"):
        if os.path.getsize(path) > MAX_SCMAP_BYTES:
            raise ScmapError("the .scmap is too large to be a map")
        with open(path, "rb") as handle:
            return handle.read()
    if path.lower().endswith(".zip"):
        with zipfile.ZipFile(path) as archive:
            # By entry rather than by a name built from the zip's own name: the
            # two do not reliably agree, and case does not either.
            for info in archive.infolist():
                if info.filename.lower().endswith(".scmap"):
                    if info.file_size > MAX_SCMAP_BYTES:
                        raise ScmapError("the .scmap is %d bytes, which is not a map" % info.file_size)
                    return archive.read(info)
        raise ScmapError("the zip holds no .scmap")
    terrain = scmap_in_folder(path)
    if terrain is None:
        raise ScmapError("the folder holds no .scmap")
    if os.path.getsize(terrain) > MAX_SCMAP_BYTES:
        raise ScmapError("the .scmap is too large to be a map")
    with open(terrain, "rb") as handle:
        return handle.read()


def strip_version(name):
    """A map version's folder name without its `.vNNNN`, lower-cased.

    Not every version has one: `12 fields of isis v13` is a map called that, and
    strips to itself. Only a dot followed by digits at the end is a version.
    """
    lowered = name.strip().lower()
    head, sep, tail = lowered.rpartition(".v")
    if sep and head and tail.isdigit():
        return head
    return lowered


def load_version_names(path):
    """Map version names, keyed by the name without their version suffix.

    Terrain files fetched on their own are usually named for the map and not for
    the version (`setons clutch.scmap`, while the version is
    `setons clutch.v0004`), and the version is what the vault keys a row by. This
    is what puts the two back together. Where two versions of one map are listed,
    the highest wins, which is the one an API query for current maps returns.

    A dump of the API carries the name under `folderName`, and that is used when
    it is there: taking every string in the file as well would drag in display
    names, ids and urls, any of which could collide with a real folder name. A
    file that is just a list of names still works, because then there is no
    `folderName` to prefer and every string is all there is.
    """
    with open(path, encoding="utf-8") as handle:
        document = json.load(handle)

    folder_names = []
    strings = []

    def walk(node):
        if isinstance(node, str):
            strings.append(node)
        elif isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, dict):
            for key, item in node.items():
                if key == "folderName" and isinstance(item, str):
                    folder_names.append(item)
                else:
                    walk(item)

    walk(document)
    found = folder_names or strings

    def version_of(name):
        head, sep, tail = name.strip().lower().rpartition(".v")
        return int(tail) if sep and head and tail.isdigit() else -1

    best = {}
    for name in found:
        if not name.strip():
            continue
        key = strip_version(name)
        if key not in best or version_of(name) > version_of(best[key]):
            best[key] = name.strip()
    return best


def check_names(inputs):
    """Warn about names that cannot key a map version. Returns a warning count.

    Only one thing is worth warning about, and it is not a missing `.vNNNN`:
    plenty of map versions genuinely have no version suffix in their folder name
    (`12 fields of isis v13` is a map called that, not a versionless one), and
    treating those as broken would bury the real problem in false alarms.

    The real problem is two inputs producing one name. Each name becomes exactly
    one `UPDATE ... WHERE filename = ...`, so a collision means two statements
    fighting over one row and whichever ran last silently winning.
    """
    names = [map_name(path) for path in inputs]
    seen = collections.Counter(name.lower() for name in names)
    clashes = sorted(name for name, count in seen.items() if count > 1)
    if not clashes:
        return 0
    print("warning: %d name(s) occur more than once, for example: %s"
          % (len(clashes), ", ".join(clashes[:3])), file=sys.stderr)
    print("         each name keys one row, so duplicates overwrite each other.",
          file=sys.stderr)
    return 1

def analyse(path, names=None):
    """(record, unclassified) for one input. Never raises."""
    name = map_name(path)
    unkeyed = False
    if names is not None:
        resolved = names.get(strip_version(name))
        # An input that is not in the version list cannot key a row. It is still
        # read and reported, because knowing what it is stays useful, but it
        # gets no `UPDATE`: guessing at a key is how a back-fill writes to the
        # wrong map. Archives carry dead `..._old.scmap` leftovers beside the
        # live terrain, and those land here exactly as they should.
        unkeyed = resolved is None
        name = resolved or name

    try:
        record, unclassified = describe(name, path, read_scmap(path))
    except ScmapError as error:
        record, unclassified = {"name": name, "source": path, "error": str(error)}, []
    except Exception as error:                       # noqa: BLE001 - see below
        # At vault scale a few inputs are always junk: a truncated upload, a zip
        # that is not one. Each has to end up as a line in the output, because a
        # run that dies on one file wastes the whole pass.
        record, unclassified = {
            "name": name, "source": path,
            "error": "%s: %s" % (type(error).__name__, error),
        }, []
    if unkeyed:
        record["unkeyed"] = True
    return record, unclassified


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------

DEFAULT_SQL_KEY = "maps/{name}.zip"

SQL_HEADER = """\
-- Map terrain back-fill, generated by tools/map-terrain/map_terrain.py.
-- Sets, on map_version:
--   water_percent  0-100, the share below the water surface
--   biome          the theme covering most of the map's dry ground
--   biome_percent  how much of it, 0-100
--   biome2         the next theme down, empty when there is only one
--   biome2_percent how much of that, 0 when there is no second
--   family         ASTRO_CRATER, DUAL_GAP, SETONS, or empty
--
-- Biome and family are independent: a Setons variant is both a Setons map and
-- an evergreen one. An empty string means "analysed, and it is none of these",
-- which stays distinct from NULL for "never analysed".
--
-- biome2 on its own is NOT a filter. A map can be 99% evergreen and 1% desert;
-- pair it with biome2_percent (>= 25 is what the client uses) or the search
-- returns maps that merely have a smear of the thing asked for.
-- Rows are matched on map_version.filename; adjust --sql-key if that is not the form.
-- Maps that could not be read are commented out and left untouched.
"""


def sql_quote(value):
    """Escape a value for a single-quoted SQL literal.

    Doubling the quote is the portable form; the backslash is escaped too
    because MySQL treats it as an escape character inside string literals by
    default.
    """
    return value.replace("\\", "\\\\").replace("'", "''")


def update_statement(record, key_template):
    """The back-fill statement for one map, or None when there is nothing to say.

    The two leading biomes are stored, each with the share of dry ground it
    covers. Two because a quarter of all maps genuinely are two things, and the
    share because without it the second one is a trap: a map that is 99%
    evergreen and 1% desert would otherwise be findable as a desert map. With
    the percentage there the threshold is a decision the query makes, not one
    baked into the data.

    The family is the other axis and does not compete with the biome: a Setons
    variant is a Setons map and an evergreen map, and both are worth asking for.

    A map that could not be read gets no statement: writing NULL would undo a
    good row from an earlier run. Neither does one whose name is not in the
    version list, because there is no row it can be said to belong to.
    """
    if "error" in record or record.get("unkeyed") or not record["name"]:
        return None

    # Already sorted with the biggest share first.
    biomes = record["biomes"]
    first = biomes[0] if biomes else None
    second = biomes[1] if len(biomes) > 1 else None
    key = key_template.replace("{name}", record["name"])

    return (
        "UPDATE map_version SET water_percent = %d,"
        " biome = '%s', biome_percent = %d,"
        " biome2 = '%s', biome2_percent = %d,"
        " family = '%s'"
        " WHERE filename = '%s';"
        % (
            record["waterPercent"],
            sql_quote(first["biome"]) if first else "", first["percent"] if first else 0,
            sql_quote(second["biome"]) if second else "", second["percent"] if second else 0,
            sql_quote(record.get("family") or ""),
            sql_quote(key),
        )
    )


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Extract terrain themes and water coverage from map files.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("paths", nargs="+", metavar="PATH",
                        help="a map zip, a map folder, or a directory of either")
    parser.add_argument("--out", metavar="FILE",
                        help="write JSON Lines here instead of stdout")
    parser.add_argument("--sql", metavar="FILE",
                        help="also write one UPDATE per map, for the back-fill")
    parser.add_argument("--sql-key", metavar="TEMPLATE", default=DEFAULT_SQL_KEY,
                        help="how a map name becomes the matched filename "
                             "(default: %(default)s)")
    parser.add_argument("--names", metavar="FILE",
                        help="JSON holding the map version names, used when the "
                             "terrain files are named for the map and not the version")
    parser.add_argument("--skip-known", metavar="FILE",
                        help="skip maps already recorded in this JSON Lines file, "
                             "so a long run can be done in batches")
    parser.add_argument("--jobs", type=int, default=min(8, (os.cpu_count() or 1)),
                        metavar="N",
                        help="worker threads (default: %(default)s)")
    args = parser.parse_args(argv)

    if "{name}" not in args.sql_key:
        parser.error("--sql-key must contain {name}")
    if args.jobs < 1:
        parser.error("--jobs must be at least 1")

    inputs = []
    for root in args.paths:
        collect(root, 0, inputs)
    inputs.sort()

    if args.skip_known:
        # Reading a whole vault takes long enough, and arrives slowly enough,
        # that doing it in batches is the normal case rather than the awkward
        # one. Names, not paths: the same map may be re-fetched somewhere else.
        known = set()
        try:
            with open(args.skip_known, encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        known.add(json.loads(line)["name"])
                    except (ValueError, KeyError):
                        continue
        except OSError as error:
            print("could not read %s: %s" % (args.skip_known, error), file=sys.stderr)
            return 1
        before = len(inputs)
        inputs = [path for path in inputs if map_name(path) not in known]
        print("skipping %d already recorded in %s"
              % (before - len(inputs), args.skip_known), file=sys.stderr)

    if not inputs:
        print("no map zips or map folders found under the given paths", file=sys.stderr)
        return 1
    names = None
    if args.names:
        try:
            names = load_version_names(args.names)
        except (OSError, ValueError) as error:
            print("could not read %s: %s" % (args.names, error), file=sys.stderr)
            return 1
        resolved = [path for path in inputs if strip_version(map_name(path)) in names]
        print("%d version names loaded from %s; %d of %d inputs matched"
              % (len(names), args.names, len(resolved), len(inputs)), file=sys.stderr)
        missing = [map_name(path) for path in inputs
                   if strip_version(map_name(path)) not in names]
        if missing:
            # Said out loud before the run rather than found in the database
            # after it. These are still read and reported; they just get no
            # `UPDATE`, since nothing says which row they belong to.
            print("warning: %d input(s) are not in that list and will get no UPDATE,"
                  " for example: %s"
                  % (len(missing), ", ".join(sorted(missing)[:3])), file=sys.stderr)

    print("reading %d maps with %d workers" % (len(inputs), args.jobs), file=sys.stderr)
    check_names(inputs)

    out = open(args.out, "w", encoding="utf-8", newline="\n") if args.out else sys.stdout
    sql = open(args.sql, "w", encoding="utf-8", newline="\n") if args.sql else None
    versions = collections.Counter()
    unclassified = collections.Counter()
    failed = 0
    done = 0
    step = max(1, len(inputs) // 20)

    try:
        if sql is not None:
            sql.write(SQL_HEADER)
        # Threads, not processes: the work is dominated by reading and
        # decompressing, and `zipfile` and file IO both release the GIL. A
        # process pool would pay pickling costs for the same wall clock.
        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            for record, folders in pool.map(lambda path: analyse(path, names), inputs):
                done += 1
                out.write(json.dumps(record, ensure_ascii=False) + "\n")
                if "error" in record:
                    failed += 1
                else:
                    versions[record["scmapVersion"]] += 1
                for folder in folders:
                    unclassified[folder] += 1
                if sql is not None:
                    statement = update_statement(record, args.sql_key)
                    if statement is not None:
                        sql.write(statement + "\n")
                    else:
                        why = "not in the version list" if record.get("unkeyed") else "unreadable"
                        sql.write("-- skipped (%s): %s\n"
                                  % (why, json.dumps(record, ensure_ascii=False)))
                if done % step == 0:
                    out.flush()
                    if sql is not None:
                        sql.flush()
                    print("  %d / %d" % (done, len(inputs)), file=sys.stderr)
    finally:
        out.flush()
        if args.out:
            out.close()
        if sql is not None:
            sql.close()

    print("read %d maps, %d failed" % (done - failed, failed), file=sys.stderr)
    print("scmap versions -> %s" % ", ".join(
        "%d: %d" % item for item in sorted(versions.items())), file=sys.stderr)
    if unclassified:
        # The point of running this over everything: whatever turns up here is a
        # theme folder the table does not know, and every map using it is
        # currently unclassified.
        print("texture folders no biome is mapped to (add them to BIOMES):", file=sys.stderr)
        for folder, count in sorted(unclassified.items(), key=lambda i: (-i[1], i[0])):
            print("  %-24s %d" % (folder, count), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
