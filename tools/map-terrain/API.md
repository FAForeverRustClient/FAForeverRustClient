# Map terrain in the API: values, schema, back-fill

Filtering the vault by what a map *looks like* ("show me the naval maps", "show
me the desert maps") cannot be answered from the map files by a client: eleven
thousand map versions at roughly ten megabytes each is not something to walk for
a search. The analysis is done once, offline, and stored on the map version.

This document is the contract for that: the allowed values, the columns, and how
the back-fill is produced. The extractor is `map_terrain.py`, next to this file:
a standalone script, deliberately not part of any client.

## 1. Allowed values

A map's terrain is painted from themed texture libraries that ship with the
game, under `/env/<theme>/layers/`. The theme folder is the classification, so
the value set is fixed by the game and not by taste. Fifteen values:

| Value | `/env/` folders it comes from |
|---|---|
| `EVERGREEN` | `evergreen`, `evergreen2`, `evergreen3` |
| `DESERT` | `desert` |
| `TUNDRA` | `tundra` |
| `RED_BARRENS` | `red barrens` (the folder name contains a space) |
| `TROPICAL` | `tropical` |
| `LAVA` | `lava` |
| `PARADISE` | `paradise` |
| `CRYSTALLINE` | `crystalline` |
| `GEOTHERMAL` | `geothermal` |
| `SWAMP` | `swamp` |
| `ANCIENT_EARTH` | `ancient-earth` |
| `NEW_REALMS` | `newrealms` |
| `SERAPHIM` | `seraphim ii` |
| `WASTELAND` | `wasteland` |
| `CUSTOM` | none: the map ships its own textures, under `/maps/<map>/env/layers/` or an `/env/` folder no install provides |

Upper snake case matches what the API already uses for enum values on the wire
(`latestVersion.type=="UI"`).

**Match the folder name case-insensitively.** Real maps spell it every way:
`Evergreen2` and `evergreen2`, `Red Barrens` and `red barrens`, `Seraphim II`,
`Ancient-Earth`. All of those occur in the corpus, often in the same map. A
case-sensitive lookup would silently classify a large share of the vault as
nothing at all, so this is the one implementation detail worth repeating on the
upload side.

Two `/env/` folders are deliberately **not** values: `common` and `utility` are
shared by every theme, so ground painted from them is evidence for none of them.
It is counted as neither, rather than being redistributed: a map that is half
`/env/common/` reads as half a theme, which is the honest answer.

`CUSTOM` is the known hole. Around one map in forty ships its own textures (226
of 8932 keyed), and no name can classify those. The intended fix is letting
the author correct the value on upload, with the computed one as the starting
point.

### The value set is closed, and here is the check

The list was not taken from what the game *should* contain: it is every folder
that appears in the stratum paths of the real vault, checked afterwards against
what the game actually ships. Both installs were enumerated for `/env/` folders
containing a `layers/` directory, which is where terrain strata live:

| source | folders with `layers/` | in the table |
|---|---:|---:|
| Forged Alliance (`gamedata/*.scd`) | 14 | 14 |
| FAF (`gamedata/*.nx2`) | 5 | 5 |

The base game contributes the twelve themes plus `common` and `utility`; FAF
adds `ancient-earth`, `newrealms`, `seraphim ii`, `wasteland`, and two more
`swamp` textures. Nothing is unaccounted for. The other eight `/env/` folders in
the base game (`aeon`, `cybran`, `uef`, `structures`, `wreckage`, `generic`,
`devtest`, `redrocks`) have no `layers/` directory at all - they hold props and
building textures - and no map in the vault references one as a stratum.

Three folders turn up in real maps that are in neither install: `ice`, `metal`
and `mars`, across six maps between them. They are **not** shared libraries.
`Yerrot Mountains` paints all of its ground from `/env/mars/layers/rough.dds`,
and a file by that name exists nowhere in either game archive. The single
generic filenames give it away too - the shipped libraries are named
`des_sandlight_albedo.dds` and `tund_snow_albedo.dds`, never `rough.dds`.

So they are mapper-supplied textures placed under `/env/` instead of under the
map's own folder, which is the same situation `/maps/<map>/env/layers/` already
describes. **The extractor classifies any unknown `/env/` folder as `CUSTOM`**
for that reason, and those six maps now carry a value instead of an empty one.

It still reports every unknown folder at the end of a run. That matters in one
direction: if a future FAF patch ships a genuinely new library, it must show up
as a gap to be added to the table rather than quietly landing in `CUSTOM`.

**12 maps still store an empty `biome`.** They are painted only from `common`
and `utility` - grids, tarmac, foam, farm splats - so they really have no theme.
`++ crazy ++.v0001` is one texture, `Grid_64_albedo.dds`, over the whole map.

## 2. Proposed columns

There are **two independent questions** here, and they should not compete for
one column. What a map is made of (`terrain`) and which map it is a version of
(`family`) are different things: a Setons variant is a Setons map *and* an
evergreen map, and being told only one of those is a loss for no gain.

```sql
ALTER TABLE map_version
  ADD COLUMN water_percent  TINYINT UNSIGNED NULL,
  ADD COLUMN biome          VARCHAR(16)      NULL,
  ADD COLUMN biome_percent  TINYINT UNSIGNED NULL,
  ADD COLUMN biome2         VARCHAR(16)      NULL,
  ADD COLUMN biome2_percent TINYINT UNSIGNED NULL,
  ADD COLUMN family         VARCHAR(16)      NULL;
```

### `water_percent`

The share of the map below the water surface, 0 to 100. It cannot be derived
from the biome and it is what makes "naval map" answerable, so it is its own
column. The plain flooded area, with no attempt to discount shallows or
unbuildable ground: what counts as "real" water depends on what it is being
asked for, and a number that quietly answers a different question is worse than
a blunt one.

### `biome`, `biome2` and their shares

The two themes covering most of the map's *dry* ground, biggest first, each with
the percentage of ground it covers. Fifteen values, listed above. `biome2` is
empty and `biome2_percent` zero when a map is only one thing, which is 41% of
them.

Two rather than one because a map genuinely can be two things: measured over
8932 map versions, **22.4% carry a second biome at 25% or more** of the ground.
`Africa 4v4` is 66% desert and 27% tropical, and storing only the leading value
would hide it from anybody looking for tropical maps.

**`biome2` on its own is not a filter.** `dualgap_adaptive.v0014` is 99%
evergreen and 1% desert; a query on `biome2 = 'DESERT'` alone would return it as
a desert map. That is why the shares are stored: the threshold is a decision the
query makes, not one baked into the data at write time.

```sql
-- maps that genuinely are desert maps
WHERE (biome = 'DESERT' AND biome_percent >= 25)
   OR (biome2 = 'DESERT' AND biome2_percent >= 25)
```

25 is what the client uses. Storing the numbers means changing it later is a
query change and not a re-import.

### `family`

`ASTRO_CRATER`, `DUAL_GAP`, `SETONS`, or `NULL`. Three maps are played so much
that every variant of them is its own thing: somebody looking for Setons wants
all sixty of them, not "the evergreen naval maps". Measured over 8932 keyed map
versions: 184 Astro Crater, 59 Dual Gap, 57 Setons.

Unlike the biome this comes from the *name*, not the terrain, because that is
what actually distinguishes them: `astro_seton` and `Setons - 64 FFA` are
painted alike and are different maps to anybody choosing one. Matching strips
every separator and capital first, so `Dual Gap`, `dual_gap`, `DualGap` and
`adaptive_dualgap_survival` land together, and it is deliberately narrow
(`dualgap`, not `gap`) so `adaptive_quad_gap` and `artem_gap` stay out. The
stock Setons ships as `scmp_009` and is matched by that as well.

The API could compute this itself from the name it already stores, so the column
is a convenience rather than a necessity. It earns its place because the
normalisation is not expressible as a single RSQL glob.

### `NULL` versus empty

`NULL` in any of them means "never analysed". A map that *was* analysed and has
no classifiable texture stores an empty `biome`, and one in no family stores an
empty `family`, so the two stay distinct.

### Why not a join table

A join table would be the textbook shape for a set:

```sql
CREATE TABLE map_version_biome (
  map_version_id INT NOT NULL, biome VARCHAR(16) NOT NULL,
  percent TINYINT UNSIGNED NOT NULL, PRIMARY KEY (map_version_id, biome)
);
```

Two columns on the row were chosen over it because two is where the data
actually stops being interesting: across 8932 map versions only 0.8% carry a
third biome at 25% or more (70 maps), so a table would exist to hold almost
nothing. If
that changes, the extractor's JSON Lines output already carries every share and
the table can be filled from that file without reading a single map again. Keep
`terrain.jsonl`.

### Filtering

```
latestVersion.biome=="DESERT"              # maps that lead with desert
latestVersion.biome2=="TROPICAL"           # ... and pair it with biome2Percent
latestVersion.family=="SETONS"             # every Setons variant
latestVersion.waterPercent=ge=50           # naval maps
latestVersion.waterPercent=le=15           # land maps
```

The two axes combine freely, which is the point of keeping them apart:
`biome=="TUNDRA";family=="ASTRO_CRATER"` is a question somebody will ask.

## 3. Computing it on upload

New uploads should get the same values at upload time, so the columns do not
start rotting the moment the back-fill finishes. The logic worth porting is two
functions in `map_terrain.py`: `read_terrain` (walk the file to the terrain
textures and masks) and `stratum_coverage` (weigh each texture by the ground it
covers). Everything else in the script is input handling and output format.

The weighing is the blend the game performs, not "whichever mask is largest":
layers are painted over one another with their mask as opacity, so the visible
ground at a pixel is the last strong layer, not the strongest. Compositing
top-down is what makes Seton's Clutch come out as evergreen. Averaging the
preview image instead was tried and abandoned: Seton's land averages to a dirty
yellow, and nobody looking for a green map asks for yellow.

**Only the ground above the water surface is weighed.** Sea floors are routinely
painted with a sand texture that says nothing about how a map reads, and
counting them turns green island maps into desert ones: `crashing_waves.v0009`
is 77% water and came out as 81% desert until its seabed was excluded, and now
reads as 78% evergreen. Adding this moved the leading biome of 8.2% of a
427-map corpus; the mask sharpening above moved another 7.6%. Each mask pixel is resolved to its nearest heightmap sample,
since the two grids differ in resolution.

One further detail is load-bearing and easy to miss: the stratum masks have to
be sharpened through `saturate(2m - 1)` before the blend, because that is what the
albedo path of the legacy shaders does, and the FAF techniques pick one
convention or the other by name (`Terrain251` half, `Terrain201` full). Reading
the mask straight through counts a texture laid thinly over a wide area as real
coverage. Adding it moved the leading biome of 7.6% of the maps it was measured
against, so it is not a rounding detail.

Which shader a map asks for is in the `.scmap` itself, right after the
heightmap. Across 9416 readable maps: `TTerrainXP` 5985, `TTerrain` 3339,
`Terrain200` 42, `TTerrainGlow` 37, and single-digit counts of `Terrain250`,
`Terrain100`, `Terrain202B`, `Terrain151`, `Terrain200B`, `TTerrainXPExt`,
`Terrain003`. The 47 maps on the `Terrain*0*` techniques use the **full** range,
so assuming the legacy convention everywhere is wrong for them.

## 4. Back-fill for existing maps

The extractor writes the `UPDATE` statements directly:

```bash
python map_terrain.py --out terrain.jsonl --sql backfill.sql /path/to/map/zips
```

It reads vault zips, extracted map folders or loose `.scmap` files at any depth.
`numpy` is used when present and only changes the speed, not the output. Timed
at 12 minutes for 2389 inputs read off a spinning disk; the whole vault of 9431
takes roughly an hour there, and several times less against an SSD.
Note `--skip-known`, which lets a long fetch be processed in batches instead of
one long run at the end.

`backfill.sql` holds one statement per map:

```sql
UPDATE map_version SET water_percent = 20,
  biome = 'DESERT', biome_percent = 66,
  biome2 = 'TROPICAL', biome2_percent = 27,
  family = ''
  WHERE filename = 'maps/africa_4v4.v0001.zip';
```

8932 of them, one per keyed map version; 5276 carry a second biome.

Rows are matched on `map_version.filename`, built from the map's folder name via
`maps/{name}.zip`. That is the one assumption the script makes about a schema it
does not own, so it is a flag: `--sql-key '<template>'` with `{name}` in it.

Where the terrain files were fetched on their own they are usually named for the
map rather than for the version, which is not enough to key a row. `--names`
takes the JSON list of version names alongside them and joins the two; see the
README.

Map names are escaped into their SQL literals (quotes doubled, backslashes
escaped), with a test for it. A map that cannot be read produces a `-- skipped`
comment instead of an `UPDATE`, so the row is left alone and nothing goes
missing silently.

Over 9431 inputs, 15 could not be read (0.16%). Thirteen of those store their
stratum masks **compressed** rather than as uncompressed 32-bit, which this
decoder does not handle: `losttemple.v0003`, `julia.v0003`, `beltway.v0002`,
`helenas.v0001`, `tucon.v0003`, `elephantgraveyard.v0005`, `forgotval.v0001`,
the three `mars_*` maps, and a few dead `_old` leftovers from inside archives.
That is a known gap, fixable with a BC3 decoder if 0.16% matters. The rest are a
truncated file and one whose header claims a size its file cannot hold.

Five `.scmap` minor versions occur in the wild (52, 53, 54, 56, 60) and they
disagree about four things; all five are handled. 54 is a single map and takes
one change from 53 and one from 56, so treating it as either loses it.

`terrain.jsonl` is the durable artefact and is worth keeping: it carries the
per-texture coverage as well, so the classification can be revised later (a new
theme folder, two that should merge) by re-reading that file instead of eleven
thousand maps.

## 5. Exposing it

Adding the two columns to `MapVersionEntity` is all that is needed. On the
client side the work is then reading two attributes off the map version:

```json
{
  "waterPercent": 59,
  "biomes": [{ "biome": "EVERGREEN", "percent": 100 }],
  "family": "SETONS"
}
```

`map_tags.json` next to the back-fill carries exactly this for all 8932 maps, if
an importer is easier than running the SQL.

## Measured distribution

From 8932 keyed map versions, the whole vault as of this run, for a sanity check
on cardinality after the import:

| `biome` | maps | | `biome` | maps |
|---|---:|---|---|---:|
| `EVERGREEN` | 3877 | | `CRYSTALLINE` | 180 |
| `DESERT` | 1695 | | `SWAMP` | 154 |
| `TROPICAL` | 650 | | `GEOTHERMAL` | 120 |
| `PARADISE` | 522 | | `ANCIENT_EARTH` | 69 |
| `TUNDRA` | 483 | | `SERAPHIM` | 59 |
| `LAVA` | 440 | | `NEW_REALMS` | 40 |
| `RED_BARRENS` | 403 | | `WASTELAND` | 2 |
| `CUSTOM` | 226 | | | |

12 maps store an empty `biome`.

### What the back-fill does not cover

Measured against the vault's own list of 9215 map versions:

| | versions |
|---|---:|
| in the back-fill | 8932 (96.9%) |
| not downloaded | 269 |
| downloaded but unreadable | 14 |

(15 files failed to decode; one of them is a dead `_old` file rather than a map
version, which is why the two figures differ by one.)

The 269 are the larger gap and they are **not** random. The download pass that
produced this extract named each file after the map rather than the map
*version*, so a map with several versions could only keep one of them on disk:
the vault lists both `gap of rohan.v0001` and `gap of rohan.v0003`, and only one
file exists. 63 of the 269 are superseded versions lost that way. The other 206
were simply never fetched, and they include maps that matter - `scmp_015.v0002`
has 101384 games played, `astro_crater_battles_4x4_rich_v2.v0001` has 89338.
Between them the missing versions carry 3.8% of all games ever played.

None of this blocks the migration: the back-fill sets only the rows it names, so
a later pass over the remaining 283 is another file of `UPDATE` statements and
not a re-import. It is stated here so the coverage is not mistaken for complete.

A further 484 inputs were read and left out because their name is not a known map
version at all: dead `_old` terrain files extracted from inside archives. They
address no row, so writing them would be guesswork.

`family`: 184 `ASTRO_CRATER`, 59 `DUAL_GAP`, 57 `SETONS`.

Water: 4487 maps at 15% or below, 2293 between, 2152 at 50% or above.

Every value in the table is used, so none of the fifteen is dead weight, though
`WASTELAND` is carried by two maps and `NEW_REALMS` by forty.
