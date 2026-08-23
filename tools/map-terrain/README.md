# map-terrain

A one-off migration tool. It reads terrain themes and water coverage out of
Supreme Commander map files so the values can be put on `map_version` in the FAF
API, once. After that the client only ever asks the API, and this becomes dead
weight.

**This is not part of the client.** It is deliberately outside the Rust
workspace, is not a workspace member, and nothing in `crates/` or `ui/` depends
on it or knows it exists. `cargo build`, `cargo test --workspace` and the client
bundle never touch it. A parser for a format the client will not read at runtime
has no business being compiled into the client.

## Run it

```bash
python map_terrain.py --out terrain.jsonl --sql backfill.sql /path/to/map/zips
```

Python 3.8 or newer, no packages required. `numpy` is used if it happens to be
installed and only changes the speed: about 45 seconds for 430 maps with it,
about 5 minutes without, for byte-identical output. Install it before a
vault-sized run if you can.

Inputs may be map zips, extracted map folders, loose `.scmap` files, or a
directory holding any of those at any depth. A directory carrying a map's
`*_scenario.lua` is a map folder and is taken whole, because it has an `env/` of
its own and its *folder* name is the map version. The scenario is the marker
rather than the terrain-file count: three folders in a stock install hold two
`.scmap` files, an `_old` leftover beside the live one, and counting would split
one map version into two rows. Where there are several, the one named after the
folder wins.

| Flag | Meaning |
|---|---|
| `--out FILE` | write JSON Lines here instead of stdout |
| `--sql FILE` | also write one `UPDATE` per map, for the back-fill |
| `--sql-key TEMPLATE` | how a map name becomes the matched `filename` (default `maps/{name}.zip`) |
| `--names FILE` | JSON holding the map version names, when the terrain files are not named for the version |
| `--skip-known FILE` | skip maps already recorded in that JSON Lines file |
| `--jobs N` | worker threads (default: the core count, capped at 8) |

### `--names`, when the terrain files carry no version

The back-fill matches rows by map *version* (`setons clutch.v0004`), and a
terrain file fetched on its own is usually named for the map alone
(`setons clutch.scmap`). `--names` puts the two back together:

```bash
python map_terrain.py --names versions.json --out terrain.jsonl --sql backfill.sql ./scmaps
```

The file is any JSON containing the version names; every string in it is taken,
wherever it sits, so a bare array and an object holding one both work. Names are
joined to files by the name with the version suffix removed, and where two
versions of one map are listed the highest wins. The run reports how many inputs
matched and names some that did not, because an unmatched file keeps its own
name and would key the wrong row or none at all.

Not every version *has* a suffix, and that is not a problem:
`12 fields of isis v13` is a map called that, and it matches a file of the same
name. Only a trailing dot-plus-digits counts as a version.

One thing to keep in mind if the names came from an API: they may be lower case
while the stored `filename` is not. MySQL's usual collations compare case
insensitively, so the `UPDATE` still matches, but it is worth a glance at one row
before running eleven thousand.

### `--skip-known`, for a fetch still in progress

Point it at the output of the previous run and only what has arrived since is
read. Matching is by map name, so re-fetching the same map to a different path
changes nothing.

## What comes out

One JSON object per line:

```json
{
  "name": "scmp_009.v0001",
  "source": ".../scmp_009.v0001.zip",
  "scmapVersion": 60,
  "width": 1024,
  "height": 1024,
  "waterPercent": 59,
  "biomes": [{ "biome": "EVERGREEN", "percent": 100 }],
  "textures": [
    { "path": "/env/evergreen2/layers/eg_gravel005_albedo.dds", "percent": 56 },
    { "path": "/env/evergreen2/layers/eg_dirt003_albedo.dds", "percent": 21 }
  ]
}
```

A map that cannot be read produces `{"name", "source", "error"}` rather than
being dropped, so a bad upload is visible instead of silently missing. Its row
is left alone by the back-fill.

`textures` is there as well as `biomes` on purpose: the biome names are a
*classification* of the texture paths, and classifications get revised. Keeping
the paths and their coverage means a revision is a pass over `terrain.jsonl`
instead of another read of every map file. Keep that file.

The run also reports, on stderr, any `/env/` folder no biome is mapped to. That
is the one moment the gaps in the table are visible. Across the whole vault
there are three - `ice`, `metal` and `mars`, six maps between them - and none of
the three exists in either game install, so they are a mapper's own textures in
the wrong directory and classify as `CUSTOM`. The report is kept anyway: a
library FAF ships in a future patch has to be visible rather than absorbed.

## The values, the schema, the migration

See [API.md](API.md): the fifteen allowed values and where they come from, the
six proposed `map_version` columns, how the upload path should compute them, and
how the back-fill is produced. The columns store the two leading biomes with
their shares, because a fifth of all maps genuinely are two things; every
further share stays in `terrain.jsonl`.

## Checking it

```bash
python test_map_terrain.py
```

That covers the classification, the weighing, the SQL escaping and the input
walking on hand-built data. The decoder itself is only really proved against
real map files, so point it at a maps folder as well:

```bash
FAF_MAP_CORPUS="$USERPROFILE/Documents/My Games/Gas Powered Games/Supreme Commander Forged Alliance/Maps" \
  python test_map_terrain.py
```

Measured baseline on a 430-folder install: **427 decode**. The three that do not
are two placeholder text files shipped under a `.scmap` name and one map whose
header claims a size its file is too small to hold. If a change makes that
number drop, a format version has been lost.

## How it works

`.scmap` is a sequential binary format with no index, so reaching the terrain
textures means walking past the preview, lighting, water, wave generators,
decals and normal maps. Four minor versions are in the wild and they disagree in
four places, none of which the file announces:

| minor | padding | cubemaps | stratum preamble | mask textures |
|---|---|---|---|---|
| 53 | no | one | (tileset + count) | one, counted |
| 54 | yes | one | none | two |
| 56 | yes | counted | 24 bytes | two |
| 60 | yes | counted | 28 bytes | two |

Every row was measured against real files. 54 is rare (one map in 2389) and is
the awkward one: it takes one change from 56 and one from 53, so treating it as
either loses it.

The weighing is the blend the game performs, not "whichever mask is largest":
layers are painted over one another with their mask as opacity, so the visible
ground at a pixel is the last strong layer, not the strongest. Compositing
top-down is what makes Seton's Clutch come out as evergreen.

**The masks are sharpened first, and which way depends on the shader.** The
legacy shaders run each stratum mask through `saturate(2m - 1)` on the albedo
path, so anything painted below half strength draws nothing at all. The FAF
techniques come in both conventions and say which in their own name:

| shader | mask range |
|---|---|
| `TTerrain`, `TTerrainXP`, `TTerrainXPExt`, `TTerrainGlow` | half |
| `Terrain<f>5<v>` (`Terrain050`, `Terrain151`, `Terrain251`, ...) | half |
| `Terrain<f>0<v>` (`Terrain000`, `Terrain200`, `Terrain301`, ...) | full |

Getting this wrong is not cosmetic. Reading a half-range map at full range
counts every faint sweep of a texture as real ground: adding the sharpening
changed the leading biome of **10.8% of a 427-map corpus**. Assuming half range
everywhere is not safe either, because `Terrain200` is full range and appears on
27 of those maps.

Each map's shader is recorded in the output, so a run can be audited by it.

Averaging the preview image and filtering on hue was the other candidate and was
abandoned on measurement: Seton's land averages to a dirty yellow, and nobody
looking for a green map asks for yellow.
