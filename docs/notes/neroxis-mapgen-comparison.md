# Neroxis mapgen: feature comparison, Rust vs Python vs Java vs the generator CLI

As of 2026-08-16 · Rust repo branch `feat/tutorials-guides`, base `582ab6f`

## What is being compared

| Source | Reference | Role |
|---|---|---|
| **Rust/Tauri** | this repo | the new client |
| **Python** | `D:\Projects\FAF\Forks\py-client` (= `FAForever/client`) | legacy client (PyQt6) |
| **Java** | `FAForever/downlords-faf-client` | official client |
| **Generator** | `FAForever/Neroxis-Map-Generator`, **verified empirically against `NeroxisGen_1.22.1.jar`** | the authoritative source |

The Python code lives in **two** places, which is easy to miss:

- `src/mapGenerator/` (328 lines): process handling and download only
- `src/games/mapgenoptions*.py` + `res/games/mapgen.ui` (~900 lines + 32 KB of UI): **the entire
  options dialog**

Read only `src/mapGenerator/` and you would take the Python client for reproduction-only. That is
wrong: it has the most extensive options dialog of the three clients.

## Method

Every claim here comes from source. On top of that the **shipped JAR was run directly**
(`natives/jre` = Temurin 25, because Neroxis 1.22.x needs class-file version 69). Everything
marked with a lightning bolt is empirically demonstrated rather than inferred from the code.

Status of the Rust client: OK = parity or better · GAP = incomplete · MISSING = absent ·
BUG = wrong.

---

## 1. Executive summary

| # | Finding | Severity |
|---|---|---|
| 1 | (verified) The density sliders send 0 to 127; the generator accepts 0 to 1 only. **Both** reference clients convert, we do not | BUG **P0** |
| 2 | (verified) Invalid spawn/team and symmetry/team combinations are not caught | MISSING **P0** |
| 3 | (verified) `--parse` exists: validation and name resolution **without** generating. **No client uses it** | opportunity |
| 4 | Raw arguments are split with `split_whitespace()`, so paths with spaces break (Python uses `shlex`) | BUG **P1** |
| 5 | The version list fetches 30 of 130 releases (no pagination) | GAP **P1** |
| 6 | Option lists are refetched from the JAR every time the dialog opens; Python caches them per version as JSON | GAP **P1** |
| 7 | `numTeams = 0` (asymmetric) and 9 to 16 are unreachable | MISSING **P1** |
| 8 | No generator log: both reference clients write one | MISSING **P1** |
| 9 | (verified) Map styles carry size, spawn and team constraints. **No client filters on them** | opportunity |
| 10 | (verified) `--preview-path` writes preview images into a folder of their own. **No client uses it** | opportunity |

---

## 2. The three clients at a glance

### Python: the most extensive dialog, the weakest validation

How it is put together:

| File | Job |
|---|---|
| `mapgenManager.py` | download, version management, JAR cache |
| `mapgenProcess.py` | QProcess, stdout scraping, progress dialog with **Cancel** |
| `mapgenoptionsdialog.py` | the dialog, including `OptionsExtractor` |
| `mapgenoptions.py` | options abstraction (combo box / spin box / range to CLI argument) |
| `mapgenoptionsvalues.py` | hardcoded fallback enums for older versions |

What the Python client does **better than Java and better than us**:

- **An options cache per generator version.** `OptionsExtractor` calls the JAR once per option list
  and writes the result to `mapgen_options.json`, **keyed by version**. Nothing is started the next
  time it opens. We start six JVMs every time the dialog opens.
- **The complete release list.** `?per_page=100` plus reading GitHub's `Link` header for further
  pages (a `GITHUB_NEXT_PAGE` regex). The result is cached in `release_tags`.
- **`shlex.split`** for raw arguments: correct shell quoting.
- **A `--folder-path` switch**: one checkbox automatically prepends
  `--folder-path <user maps folder>`.
- **A "Run Help" button**: shows the generator's `--help` output in the dialog.
- **Switching version at runtime** with a "Switch" button, plus a prompt when a new version
  appears.
- **A minimum version for option extraction**: below 1.12.0 it does not even try.
- **A `RANDOM` sentinel** in every combo; choosing `RANDOM` for prop or resource disables the
  matching density fields.

What it does **worse**: essentially no input validation. Spawns and teams go from 1 to 1000, map
size from 2.5 to 80 km. The client relies on the generator complaining, and shows its stdout in a
dialog.

**Worth noting:** Python already uses `--visibility` (the current flag), not the legacy aliases.

### Java: the strictest validation

`GenerateMapController` makes invalid input *structurally impossible*: `selectableSpawnCounts` is a
`FilteredList` with the predicate `value % numTeams == 0`, refiltered whenever the team count
changes. You simply *cannot* set 5 spawns with 2 teams there.

Against that: no version selection, no options cache, no pagination, and
`commandLineArgs.split(" ")`.

### Rust: in between, with strengths of its own

Version selection in the UI, a download size limit, clean process reaping, preview cards, a
four-stage progress display, user-driven cleanup with favourite protection. But: no validation, and
the density bug.

---

## 3. CLI flag matrix

| Flag | Generator | Python | Java | **Rust** |
|---|---|---|---|---|
| `--map-name` | yes | yes | yes | OK |
| `--map-size` | oGrids **or** `10km` | yes (km, 1.25 steps) | yes (km spinner) | GAP: oGrids only, fixed list |
| `--spawn-count` | 0 to 16 | yes, 1 to 1000 | yes, filtered | GAP: 2 to 16, unfiltered |
| `--num-teams` | 0 to 16 (**0 = asymmetric**) | yes, 1 to 1000 | yes, 0 and 2 to 16 | MISSING: 2 to 8 |
| `--num-to-generate` | yes | yes | yes, 1 to 50 | GAP: 1 to 10 |
| `--seed` | `Long` | yes | yes | GAP: unvalidated string |
| `--terrain-symmetry` | 22 values | yes | yes | OK |
| `--style` | 21 presets | yes | yes | OK |
| `--terrain-style` | 24 | yes | yes | OK |
| `--texture-style` / `--biome` | 13 | yes | yes | OK |
| `--resource-style` | 6 | yes | yes | OK |
| `--prop-style` | 10 | yes | yes | OK |
| `--reclaim-density` | **0.0 to 1.0** | yes (`/100`) | yes (`/127`) | BUG: **raw 0 to 127** |
| `--resource-density` | **0.0 to 1.0** | yes (`/100`) | yes (`/127`) | BUG: **raw 0 to 127** |
| `--visibility` | the current flag | yes | no | no |
| `--tournament-style` / `--blind` / `--unexplored` | `hidden` (legacy) | no | yes | OK |
| `--visualize` | negatable | raw only | raw only | OK (timeout exemption correct) |
| `--debug` | negatable | raw only | raw only | GAP: raw only |
| `--out-path` / `--folder-path` | yes | yes, **checkbox** | no | no |
| `--preview-path` | yes | no | no | no |
| `--parse` | yes | no | no | no |
| `--help` / `--version` | yes | yes, button | no | no |
| Option-list subcommands | 6 of them | yes, **cached** | yes | OK, uncached |

---

## 4. The gaps in detail

### 4.1 BUG P0: density units (verified)

The shipped JAR's help says it in as many words: *"Reclaim density for the generated map. **Min: 0
Max: 1**"*. Verified directly:

```
$ java -jar NeroxisGen_1.22.1.jar --parse ... --reclaim-density 64
Invalid value for option '--reclaim-density': Must be between 0 and 1 but was `64,000000`
```

The 127 is `GeneratedMapNameEncoder.NUM_BINS`, the resolution of the internal discretisation, not
the scale. Both reference clients convert:

- Java: slider 0 to 127 (the bin scale) then `reclaimLowValue / 127f`
- Python: spin box 0 to 100 (percent) then `random.randrange(min, max+1) / 100`

We are missing the division. Sliders up to 127 in
[GenerateMapModal.tsx:412](ui/src/features/maps/GenerateMapModal.tsx:412) and `:423`, passed
through raw in
[protocol/map_generator.rs:554-571](crates/faf-domain/src/protocol/map_generator.rs:554). The
comment on `:302` states the opposite outright and needs correcting.

**Effect:** an untouched slider stays `None` and emits no flag, so it works. Move it once and the
run aborts. A custom style with a density is unusable.

**Fix:** divide by 127.0 on the way out, keep the UI unit. A domain test asserting the emitted
value lands in `0.0..=1.0`.

### 4.2 MISSING P0: invalid combinations (verified)

```
$ java -jar NeroxisGen_1.22.1.jar --parse --spawn-count 5 --num-teams 2
Spawn Count `5` not a multiple of Num Teams `2`

$ java -jar NeroxisGen_1.22.1.jar --parse --num-teams 2 --terrain-symmetry POINT3
Terrain symmetry `POINT3` not compatible with Num Teams `2`
```

The rules, from `MapGeneratorCommand.checkParameters` and the record constructors:

| Rule | Do we check it? |
|---|---|
| `numTeams != 0 && spawnCount % numTeams != 0` | no |
| `numTeams != 0 && terrainSymmetry.numSymPoints % numTeams != 0` | no |
| `mapSize % 64 != 0` | implicitly (the list conforms; raw arguments bypass it) |
| `spawnCount in 0..16`, `mapSize in 0..2048`, `numTeams in 0..16` | partly |

The symmetry rule is the subtlest: `POINT3` has 3 symmetry points, `XZ`/`X`/`Z`/`ZX` have 2 each,
`QUAD`/`DIAG` 4 each. We treat symmetries as opaque strings.

**Fix:** see section 5.1. `--parse` does this without us rebuilding a single rule.

### 4.3 BUG P1: raw arguments break on spaces

```rust
options.command_line_args.split_whitespace()
```
[protocol/map_generator.rs:466](crates/faf-domain/src/protocol/map_generator.rs:466)

`--folder-path "C:\Users\Max Mustermann\maps"` becomes four arguments. The Java client has the same
bug (`split(" ")`); the Python client does not, because it uses `shlex.split`. Since the goal is to
be the better client, Python is the reference here.

### 4.4 GAP P1: the version list is incomplete (verified)

We call `/releases` without `per_page` and without pagination. GitHub returns **30 of 130**
releases, and the list stops at 1.8.4. Python fetches all 130 (`per_page=100` plus the `Link`
header) and caches them in `release_tags`.

### 4.5 GAP P1: option lists are not cached

`load_options` starts six JVM processes every time the dialog opens
([services/map_generator.rs:180-189](crates/faf-app/src/services/map_generator.rs:180)). Python
extracts once per generator version and puts the result in `mapgen_options.json`.

A cache makes all the more sense because within a version the lists cannot change by definition.

### 4.6 MISSING P1: valid values that cannot be reached

| Setting | Generator | Python | Java | Rust |
|---|---|---|---|---|
| `numTeams` | 0 to 16 | 1 to 1000 | 0, 2 to 16 | **2 to 8** |
| `numToGenerate` | any | 1 or more | 1 to 50 | **1 to 10** |
| `mapSize` | 0 to 2048, `%64` | 2.5 to 80 km | 5 to 20 km (13 values) | **9 values** |

`--num-teams 0` is documented explicitly as *"0 is no teams asymmetric"* and switches off all team
validation. A map type of its own that we do not offer.

On sizes we are missing 576, 704, 832, 896 and 960 against Java's grid; we do have 2048.

### 4.7 MISSING P1: no generator log

Python writes `map_generator.log`; Java logs through `faf-map-generator`. We deliberately log only
*that* a line arrived ([infra/map_generator.rs:354](crates/faf-app/src/infra/map_generator.rs:354)).
On a failure the user sees the first stderr line and nothing else.

### 4.8 MISSING P2: no confirmation prompt on join

Python asks before generating a lobby map (Yes / Yes to all / No), because the operation pins a CPU
for minutes. Our `GenerateNamed` starts immediately. Java does not ask either.

---

## 5. What the generator can do that **no** client offers

The second half of the question. Everything here is verified against the shipped 1.22.1 JAR.

### 5.1 `--parse`: dry run, validator and name resolver in one (verified)

> "Only parse the options and return the parameters in json"

The generator can **resolve, validate and compute the resulting map name without generating a
map**. It runs in under a second instead of minutes.

**Direction A, options to name and parameters:**

```
$ java -jar NeroxisGen_1.22.1.jar --parse --map-size 10km --spawn-count 6 \
      --num-teams 2 --style MOUNTAIN_RANGE --terrain-symmetry POINT2 --seed 12345
{"parameters":{"seed":12345,"spawnCount":6,"mapSize":512,"numTeams":2,
 "mode":{"terrainSymmetry":"POINT2","mapStyle":"MOUNTAIN_RANGE"}},
 "mapName":"neroxis_map_generator_1.22.1_aaaaaaaaaayds_ayeaeaaj"}
```

**Direction B, name to parameters:**

```
$ java -jar NeroxisGen_1.22.1.jar --map-name neroxis_map_generator_1.22.1_mmyctirfxqlx6_baeaj7yja4aqoxza --parse
{"parameters":{"seed":7147258385031501695,"spawnCount":8,"mapSize":512,"numTeams":4,
 "mode":{"terrainSymmetry":null,"mapStyle":{"terrainStyle":"FLOODED","biomeName":"SYRTIS",
 "propStyle":"ROCK_FIELD","resourceStyle":"LOW_MEX",
 "reclaimDensity":0.7480315,"resourceDensity":0.2519685}}}, "mapName":"..."}
```

That solves three problems at once:

1. **Validation without rebuilding it.** Instead of reimplementing `spawnCount % numTeams`,
   `mapSize % 64` and the symmetry rule in `faf-domain` and chasing every generator release: put
   `--parse` in front. Exit code 0, generate. Non-zero, show the generator's own message, which is
   already precise ("Spawn Count `5` not a multiple of Num Teams `2`"). The JAR is loaded in the
   host flow anyway.
2. **A name preview.** The user sees the map name before generating: shareable, and copyable into
   the lobby.
3. **Metadata for somebody else's maps.** On joining a lobby you could show "10 km · 8 spawns ·
   4 teams · FLOODED/SYRTIS" before starting a generation that takes minutes.

A limit on point 3: one JVM start per name is too slow for a lobby *list*. Local base32 decoding
suits that (byte layout in section 6), or a cache; `--parse` is the right choice on demand for a
single map.

### 5.2 `--preview-path`: preview images in a folder of their own (verified)

`--preview-path <folder>` writes the preview PNGs separately. We currently read the preview out of
the map folder and try nine filename variants to find it
([infra/map_generator.rs:474-531](crates/faf-app/src/infra/map_generator.rs:474)). Pointing
`--preview-path` at a temporary directory removes the guessing entirely.

Note: this only applies in casual mode (`allowDebug()`); tournament and blind maps have no preview
by definition.

### 5.3 Map styles carry parameter constraints (verified)

Every preset in `MapStyle.Predefined` carries a `ParameterConstraints` record:

| Style | Map size | Spawns | Teams |
|---|---|---|---|
| `BIG_ISLANDS`, `SMALL_ISLANDS`, `LAND_BRIDGE` | 768 to 1024 | any | LAND_BRIDGE: 2 to 4 |
| `CENTER_LAKE`, `FLOODED`, `ONE_ISLAND`, `VALLEY` | 384 to 1024 | any | any |
| `MOUNTAIN_RANGE` | 256 to 640 | any | any |
| `LOW_MEX` | 256 to 640 | 0 to 4 | exactly 2 |
| `SETONISH` | 512 to 1024 | any | exactly 2 |
| all others | any | any | any |

The generator uses these constraints **only when picking at random** (`RANDOM_MAP_STYLE_OPTIONS`,
weighted: `BASIC` and `LAND_BRIDGE` twice, `FORREST_SOMETHING` at 0.01). Choose a style explicitly
and it is taken unfiltered, even where it does not fit.

**No client shows this.** Pick `BIG_ISLANDS` at 5 km and you get nothing sensible, with no
explanation. Greying styles out in the dialog, or labelling them with their valid size range, would
be a real improvement. The table is version-dependent though and would need maintaining, or it
could be derived from a `--parse` comparison.

### 5.4 Further unused capabilities (verified)

| Capability | Detail | Who uses it |
|---|---|---|
| **km notation** | `--map-size 10km` becomes 512 internally (`x 51.2`) | nobody directly (everyone converts themselves) |
| **`--num-teams 0`** | asymmetric maps with no team structure | nobody |
| **Abbreviated options** | `setAbbreviatedOptionsAllowed(true)`, so `--map-si 512` works | nobody |
| **Unknown arguments tolerated** | `setUnmatchedArgumentsAllowed(true)`, so unknown flags do **not** abort the run | nobody (and it matters for forward compatibility) |
| **`--version`** | `-V` returns the generator version | nobody (everyone derives it from the filename) |
| **`--debug`** | writes `debug/pipelineMaskHashes.txt` and prints the parameters | only through raw arguments |
| **Subcommand aliases** | `styles` = `--styles`, `biomes` = `--texture-styles` = `--biomes` | everyone uses the `--` form only |

Not in the JAR: the **tool suite** (MapEvaluator, MapPopulator, MapResizer, PbrTextureGenerator,
import/export) is published as its own artefact, `neroxis-toolsuite-*`. `NeroxisGen_<version>.jar`
contains the generator alone. Using those tools would mean shipping a second package of about
55 MB, which is probably beyond what makes sense for a client.

---

## 6. Appendix: how the map name is built

```
neroxis_map_generator_<version>_<seed-b32>_<options-b32>[_<time-b32>]
```

Base32 (Commons-Codec, lowercase, no padding). The options bytes:

| Byte | Meaning |
|---|---|
| 0 | spawnCount |
| 1 | mapSize / 64 |
| 2 | numTeams |
| 3 | symmetry ordinal (-1 = none) |
| 4 (when the length is 5) | `MapStyle.Predefined` ordinal |
| 4 to 9 (when the length is 10) | biome, terrain, resource, prop, reclaim bin, resource bin |
| 3 plus segment 6 (when the length is 4) | visibility ordinal and generation time (tournament mode) |

Densities are stored as a bin index from 0 to 126; `0.75` comes back as `0.7480315` (= 95/127). The
enum ordinals are **version-dependent**: a local decoder has to stay quiet on anything it does not
recognise rather than guess.

---

## 7. State of implementation

The comparison above describes the state *before* the work. This section records what is in the
Rust client now. Sections 3 to 6 have deliberately been left unchanged: they document the starting
position and the evidence for it.

### Done

| # | Item | Where |
|---|---|---|
| 1 | Density is emitted as 0.0 to 1.0 (`format_density`); the sliders stay on the bin scale | `protocol/map_generator.rs` |
| 2 | `--parse` as a pre-flight check before every generation from options | `services/map_generator.rs`, `infra/map_generator.rs` |
| 3 | Raw arguments with shell quoting (`split_command_line`) | `protocol/map_generator.rs` |
| 4 | Release pagination, 130 versions instead of 30 | `infra/map_generator.rs` |
| 5 | Option lists cached on disk per version | `infra/map_generator.rs` |
| 6 | Teams 0 to 16 including "asymmetric", spawns filtered to multiples | `generatorPresentation.ts` |
| 7 | A generator log file with rotation | `infra/map_generator.rs` |
| 8 | All 13 sizes of the 64 grid plus 1280 and 2048 | `generatorPresentation.ts` |
| 9 | Up to 50 maps per run | `generatorPresentation.ts` |
| 10 | Name preview from `--parse` in the dialog | `GenerateMapModal.tsx` |
| 11 | `--preview-path` instead of nine guessed filenames | `infra/map_generator.rs` |
| 13 | Cancelling mid-run (`CancelSignal`) | `infra/map_generator.rs` |
| 14 | `--out-path` as a field | `GenerateMapModal.tsx` |
| 15 | Generator help in the dialog | `GenerateMapModal.tsx` |
| 16 | The seed is validated as an `i64` | `protocol/map_generator.rs` |
| 18 | `--debug` and `--visualize` as switches | `GenerateMapModal.tsx` |
| 20 | Map names are decoded locally and shown | `protocol/map_generator_name.rs` |
| 21 | Style constraints as a warning and as a selection criterion | `protocol/map_generator.rs` |

Plus two things that were not on the original list at all, because they only surfaced while
rebuilding:

- **Symmetry pre-filtering.** With several symmetries ticked, Python and Java pick uniformly from
  all of them. Put `POINT3` next to `POINT4` and ask for two teams, and roughly every second run
  fails for no visible reason. We filter to team-compatible symmetries before picking, and fall
  back to the raw selection only when not one of them fits.
- **Style pre-filtering.** The same logic for map styles against the chosen map size.

### Deliberately not done

**19. Switching to `--visibility`.** The original recommendation was wrong. Verified against the
shipped JAR: picocli runs with `setUnmatchedArgumentsAllowed(true)`, so unknown flags are **ignored
silently** rather than raising an error.

```
$ java -jar NeroxisGen_1.22.1.jar --parse --map-size 512 --spawn-count 6 --num-teams 2 --totally-bogus-flag
{"parameters":{...},"mapName":"neroxis_map_generator_1.22.1_ed577kmcvkh22_ayeae"}
```

A `--visibility BLIND` sent to an older generator would therefore do nothing, and the user would
get a casual map instead of a blind one without a word about it. The legacy flags
`--tournament-style`, `--blind` and `--unexplored` work across the whole supported version range;
in 1.22.1 they are `hidden`, not removed. Keeping them is the safer choice.

### Open

| # | Item | Why not yet |
|---|---|---|
| 12 | A confirmation prompt before generating on lobby join | Needs a new field in the settings schema and a change to the join path, both outside the mapgen module |
| 17 | "Delete generated maps on exit" | Also the settings schema plus a shutdown hook; the manual `CleanUp` command with favourite protection already exists |

### Verification

The map name decoding is tested against the generator's real output rather than against our reading
of its source: the expected values in `map_generator_name.rs` come from
`java -jar NeroxisGen_1.22.1.jar --parse ...` runs. So do the error messages the validation is
modelled on.
