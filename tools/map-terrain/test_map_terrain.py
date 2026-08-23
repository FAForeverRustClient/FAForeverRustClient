#!/usr/bin/env python3
"""Self-tests for map_terrain.py. Run with `python test_map_terrain.py`.

No test framework on purpose: this is a one-off migration tool, and needing to
install pytest to check it would defeat the point of a standalone script.

The decoder itself is proved against real map files, not here: point
`FAF_MAP_CORPUS` at a maps folder and the last test walks it.
"""

import io
import json
import os
import struct
import sys
import tempfile
import zipfile

import map_terrain as mt


failures = []


def check(name, condition, detail=""):
    if condition:
        print("  ok   %s" % name)
    else:
        print("  FAIL %s %s" % (name, detail))
        failures.append(name)


def check_eq(name, actual, expected):
    check(name, actual == expected, "\n       got %r\n       want %r" % (actual, expected))


# ---------------------------------------------------------------- classification

def test_classification():
    print("classification")
    check_eq("theme folder off the path",
             mt.biome_of("/env/desert/layers/des_sandlight_albedo.dds"), "DESERT")
    # The game splits one look across three folders.
    for folder in ("evergreen", "evergreen2", "evergreen3"):
        check_eq("%s is evergreen" % folder,
                 mt.biome_of("/env/%s/layers/x_albedo.dds" % folder), "EVERGREEN")
    # Real maps spell folders every way; a case-sensitive lookup would classify
    # a large share of the vault as nothing at all.
    check_eq("mixed case", mt.biome_of("/env/Evergreen2/layers/X_albedo.dds"), "EVERGREEN")
    check_eq("space in the name", mt.biome_of("/env/Red Barrens/layers/rb.dds"), "RED_BARRENS")
    check_eq("numeral in the name", mt.biome_of("/env/Seraphim II/layers/x.dds"), "SERAPHIM")
    # A map's own textures cannot be classified by name, so they are not guessed.
    check_eq("map-local textures are custom",
             mt.biome_of("/maps/adaptive_x.v0007/env/layers/stratum2.dds"), "CUSTOM")
    # Shared libraries are evidence for no theme.
    check_eq("common is no theme", mt.biome_of("/env/common/decals/fractal.dds"), None)
    check_eq("empty path", mt.biome_of(""), None)
    # ... but they are not a gap in the table either, which is a different thing.
    check("common is not reported as a gap", "common" in mt.SHARED_FOLDERS)
    check_eq("folder of an unknown theme",
             mt.texture_folder("/env/some_new_theme/layers/x.dds"), "some_new_theme")

    # Both the game and FAF were enumerated to build BIOMES: every /env/ folder
    # either ships with one of them and is in the table, or is shared, or was
    # put there by a mapper. The third case is what /maps/ already means, so it
    # gets the same answer instead of no answer at all. Six real maps depend on
    # this: `Yerrot Mountains` paints all of its ground from /env/mars/, which
    # exists in neither install.
    check_eq("an unknown library is the mapper's own",
             mt.biome_of("/env/mars/layers/rough.dds"), "CUSTOM")
    check_eq("and so is /env/ice/",
             mt.biome_of("/env/ice/layers/ice.dds"), "CUSTOM")
    # The distinction that keeps this honest: shared is not unknown.
    check_eq("a shared library stays no theme",
             mt.biome_of("/env/utility/layers/x.dds"), None)
    # And a folder absorbed into CUSTOM must still be visible, or a library FAF
    # ships in a future patch would silently classify as a mapper's own work.
    _, by_biome, gaps = mt.classify_strata(["/env/mars/layers/rough.dds"], [1.0])
    check("an unknown library is still reported as a gap", "mars" in gaps)
    check_eq("even though it classified", list(by_biome), ["CUSTOM"])
    _, _, gaps = mt.classify_strata(["/env/tundra/layers/snow.dds"], [1.0])
    check("a known library is not a gap", "tundra" not in gaps)
    # Shared libraries are the case the tally must not fire on, or every map in
    # the vault would report one.
    _, by_biome, gaps = mt.classify_strata(["/env/common/layers/x.dds"], [1.0])
    check("a shared library is neither a gap", not gaps)
    check("nor a biome", not by_biome)


def test_value_set():
    print("value set")
    values = set(mt.BIOMES.values()) | {"CUSTOM"}
    check_eq("fifteen values", len(values), 15)
    # The stored form is a comma-joined set filtered with a substring glob. One
    # value being a substring of another would make "find the X maps" quietly
    # return the Y maps too.
    for value in values:
        others = [other for other in values if other != value and value in other]
        check("%s is not inside another value" % value, not others, str(others))


# ---------------------------------------------------------------- weighing

def mask_dds(channels, width=1, height=1):
    """A one-pixel mask whose four channels are given in stratum order.

    The file stores B, G, R, A; the strata a texture carries are its R, G, B, A,
    so this writes them back to front. Doing it here keeps the tests reading in
    the order a mapper thinks in.
    """
    dds = bytearray(mt.DDS_HEADER_LEN + width * height * 4)
    dds[0:4] = b"DDS "
    struct.pack_into("<II", dds, 12, height, width)
    struct.pack_into("<I", dds, 88, 32)
    for pixel in range(width * height):
        base = mt.DDS_HEADER_LEN + pixel * 4
        dds[base + 0] = channels[2]
        dds[base + 1] = channels[1]
        dds[base + 2] = channels[0]
        dds[base + 3] = channels[3]
    return bytes(dds)


def terrain(strata, channels, water=None, heightmap=b""):
    return {
        "minor": 60, "width": 2, "height": 2, "height_scale": 1.0,
        "heightmap": heightmap,
        "has_water": water is not None,
        "water_elevation": water or 0.0,
        "strata": strata,
        "masks": [mt.read_mask(mask_dds(channels))],
    }


def shares(strata, channels):
    """Biome shares as a dict, through the same call `describe` makes."""
    coverage = mt.stratum_coverage(terrain(strata, channels))
    _, by_biome, _ = mt.classify_strata(strata, coverage)
    return {k: mt.percent(v) for k, v in by_biome.items() if mt.percent(v) >= 1}


BASE = "/env/desert/layers/base.dds"
MACRO = "/env/desert/layers/macro.dds"

# The shader sharpens masks through saturate(2m - 1) before blending, so a byte
# has to be well above half strength to mean "half opacity" in the result.
# 191/255 sharpens to 0.498. A literal 128 draws nothing at all, which is the
# whole point of the remap and is checked separately below.
HALF = 191


def test_weighing():
    print("weighing")
    # Nothing painted over it: the base is the whole map.
    check_eq("unmasked map is its base",
             shares([BASE, "", "", "", "", MACRO], [0, 0, 0, 0]), {"DESERT": 100})

    # A layer at full opacity covers the base completely.
    check_eq("a solid layer takes the map",
             shares([BASE, "/env/tundra/layers/snow.dds", "", "", "", MACRO], [255, 0, 0, 0]),
             {"TUNDRA": 100})

    # Stratum 1 is solid and stratum 2 covers half of it. The game draws 2 over
    # 1, so it is half and half; "whichever mask is largest" would have called
    # the whole map stratum 1.
    check_eq("layers blend top-down, not by largest mask",
             shares([BASE, "/env/tundra/layers/snow.dds", "/env/lava/layers/lava.dds",
                     "", "", MACRO], [255, HALF, 0, 0]),
             {"TUNDRA": 50, "LAVA": 50})

    # The Seton's case: the mask channel of an *empty* stratum holds a
    # neighbouring layer's data, and read literally it blanks out half the map.
    check_eq("an unpainted stratum draws nothing",
             shares(["/env/evergreen2/layers/base.dds", "", "", "", "",
                     "/env/evergreen/layers/macro.dds"], [0, 255, 0, 0]),
             {"EVERGREEN": 100})

    # Half painted from a shared library: the rest is desert and says so,
    # rather than being scaled up to a hundred.
    check_eq("shared-library ground is not redistributed",
             shares([BASE, "/env/common/layers/shared.dds", "", "", "", ""], [HALF, 0, 0, 0]),
             {"DESERT": 50})


def test_half_range_remap():
    print("mask sharpening")
    # FA's terrain shaders run each mask through saturate(2m - 1) before the
    # blend, so anything painted below half strength draws nothing. Reading the
    # mask straight through makes a texture laid thinly over a wide area look
    # like real coverage when the game shows none of it.
    # The legacy names, which 94% of maps use.
    for name in ("TTerrain", "TTerrainXP", "TTerrainXPExt", "TTerrainGlow"):
        check("%s sharpens" % name, mt.uses_half_range(name))
    # The FAF family says which convention it was painted for in its own name:
    # the middle digit, 5 for half and 0 for full.
    for name in ("Terrain050", "Terrain151", "Terrain250", "Terrain251B"):
        check("%s sharpens" % name, mt.uses_half_range(name))
    for name in ("Terrain000", "Terrain200", "Terrain201B", "Terrain301"):
        check("%s does not" % name, not mt.uses_half_range(name))
    # Unknown names take the legacy convention rather than guessing the rarer one.
    check("an unknown name falls back to sharpening", mt.uses_half_range(""))
    check("and so does a name in another shape", mt.uses_half_range("SomethingElse"))

    faint = shares([BASE, "/env/tundra/layers/snow.dds", "", "", "", MACRO], [100, 0, 0, 0])
    check_eq("a faint mask draws nothing", faint, {"DESERT": 100})

    # Without the sharpening the same map would read as more than a third tundra,
    # which is the error this exists to prevent.
    coverage = mt.stratum_coverage(
        terrain([BASE, "/env/tundra/layers/snow.dds", "", "", "", MACRO], [100, 0, 0, 0]),
        half_range=False)
    check("unsharpened, it would have counted", mt.percent(coverage[1]) > 30,
          str(mt.percent(coverage[1])))


def test_only_dry_ground_is_weighed():
    print("land only")
    # A 4x4 terrain whose left half is above water and right half below. The
    # seabed is painted desert, the land tundra. What anybody sees is tundra.
    import struct as _struct
    # The heightmap has a sample at every corner, so it is 5x5 for a 4x4 map.
    rows = [[9, 9, 9, 1, 1] for _ in range(5)]
    heightmap = b"".join(_struct.pack("<H", v) for row in rows for v in row)

    # A 2x2 mask, half the terrain resolution as usual: stratum 1 (tundra) solid
    # on the left, absent on the right.
    dds = bytearray(mt.DDS_HEADER_LEN + 4 * 4)
    dds[0:4] = b"DDS "
    _struct.pack_into("<II", dds, 12, 2, 2)
    _struct.pack_into("<I", dds, 88, 32)
    for pixel, strength in enumerate((255, 0, 255, 0)):
        dds[mt.DDS_HEADER_LEN + pixel * 4 + 2] = strength   # channel 0 -> stratum 1
    mask = mt.read_mask(bytes(dds))

    map_ = {
        "shader": "TTerrain", "minor": 60, "width": 4, "height": 4,
        "height_scale": 1.0, "heightmap": heightmap,
        "has_water": True, "water_elevation": 5.0,
        "strata": ["/env/desert/layers/seabed.dds",
                   "/env/tundra/layers/snow.dds", "", "", "", ""],
        "masks": [mask],
    }

    check_eq("only the dry half is looked at",
             [int(i) for i in mt.dry_pixels(map_, 2, 2)], [0, 2])

    dry = mt.stratum_coverage(map_)
    check_eq("so the map reads as its land", mt.percent(dry[1]), 100)
    check_eq("and the seabed does not count", mt.percent(dry[0]), 0)

    # Counting the seabed would call this half a desert map, which is the error
    # this exists to prevent.
    wet = mt.stratum_coverage(map_, land_only=False)
    check_eq("counting it would halve that", mt.percent(wet[1]), 50)
    check_eq("and invent a desert half", mt.percent(wet[0]), 50)

    # A map with no water at all is unaffected.
    check("no water plane means every pixel counts",
          mt.dry_pixels({**map_, "has_water": False}, 2, 2) is None)


def test_water():
    print("water")
    heightmap = struct.pack("<4H", 1, 1, 3, 3)
    check_eq("half the samples are under the surface",
             mt.water_share(terrain([BASE], [0, 0, 0, 0], water=2.0, heightmap=heightmap)), 0.5)
    check_eq("no water plane, no water",
             mt.water_share(terrain([BASE], [0, 0, 0, 0], heightmap=heightmap)), 0.0)


def test_composite_paths_agree():
    print("composite paths")
    if mt.numpy is None:
        print("  skip numpy path (not installed)")
        return
    # The fast path must be arithmetic, not approximation: a vault-wide run uses
    # it, and the pure path is what everything else here checks.
    dds = mask_dds([200, 90, 17, 240], width=8, height=8)
    masks = [mt.read_mask(dds)]
    layers = [(1, 0, mt.CHANNEL_ORDER[0]), (2, 0, mt.CHANNEL_ORDER[1]),
              (3, 0, mt.CHANNEL_ORDER[2]), (4, 0, mt.CHANNEL_ORDER[3])]
    bodies = [masks[0][2]]
    # Both conventions: a vault-wide run uses the fast path, and the slow one is
    # what every other check here goes through.
    for half_range in (False, True):
        slow, slow_base = mt._composite_python(layers, bodies, 64, half_range)
        fast, fast_base = mt._composite_numpy(layers, bodies, 64, half_range)
        check_eq("same layers (sharpened=%s)" % half_range, sorted(slow), sorted(fast))
        for index in slow:
            check("layer %d agrees (sharpened=%s)" % (index, half_range),
                  abs(slow[index] - fast[index]) < 1e-3,
                  "%r vs %r" % (slow[index], fast[index]))
        check("base agrees (sharpened=%s)" % half_range,
              abs(slow_base - fast_base) < 1e-3, "%r vs %r" % (slow_base, fast_base))


# ---------------------------------------------------------------- input / output

def test_naming_and_walking():
    print("input")
    # The vault ships `scmp_009.v0001.zip` and the API keys that version by
    # `scmp_009.v0001`.
    check_eq("zip stem is the name", mt.map_name("/vault/scmp_009.v0001.zip"), "scmp_009.v0001")
    check_eq("folder is already named that", mt.map_name("/maps/scmp_009.v0001"), "scmp_009.v0001")
    check_eq("a loose terrain file is named by its own stem",
             mt.map_name("/dump/scmp_009.v0001.scmap"), "scmp_009.v0001")

    with tempfile.TemporaryDirectory() as root:
        # Map folders carry an `env/` of their own; descending into one would
        # walk a map's private textures looking for maps.
        map_dir = os.path.join(root, "a_map.v0001")
        os.makedirs(os.path.join(map_dir, "env", "layers"))
        open(os.path.join(map_dir, "a_map.scmap"), "wb").write(b"not a real map")
        open(os.path.join(root, "another.v0002.zip"), "wb").write(b"not a real zip")
        # Whoever feeds this may have pulled the terrain files alone.
        open(os.path.join(root, "loose.v0003.scmap"), "wb").write(b"not a real map")
        open(os.path.join(root, "readme.txt"), "w").write("x")
        os.makedirs(os.path.join(root, "empty"))

        found = []
        mt.collect(root, 0, found)
        check_eq("maps only, in every shape they arrive in",
                 sorted(os.path.basename(p) for p in found),
                 ["a_map.v0001", "another.v0002.zip", "loose.v0003.scmap"])


def test_failures_are_records():
    print("failures")
    with tempfile.TemporaryDirectory() as root:
        # Two folders in a stock FAF install hold a placeholder text file under
        # a `.scmap` name. At vault scale a run must not die on one of those.
        map_dir = os.path.join(root, "placeholder.v0001")
        os.makedirs(map_dir)
        open(os.path.join(map_dir, "placeholder.scmap"), "wb").write(b"test fake map file")
        record, _ = mt.analyse(map_dir)
        check("not a map is reported", record.get("error") == "not a .scmap file", str(record))
        check_eq("and keeps its name", record["name"], "placeholder.v0001")
        check("no statement for an unreadable map",
              mt.update_statement(record, mt.DEFAULT_SQL_KEY) is None)

        zip_path = os.path.join(root, "empty.v0001.zip")
        with zipfile.ZipFile(zip_path, "w") as archive:
            archive.writestr("empty.v0001/readme.txt", "no terrain here")
        record, _ = mt.analyse(zip_path)
        check("a zip without a map is reported", "no .scmap" in record.get("error", ""), str(record))


def test_skip_known():
    print("resume")
    # A vault-sized fetch arrives slowly, so processing it in batches is the
    # normal case. Matching is by map name, because the same map may be
    # re-fetched to a different path.
    with tempfile.TemporaryDirectory() as root:
        done = os.path.join(root, "done.jsonl")
        with open(done, "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"name": "already.v0001", "waterPercent": 0}) + "\n")
            handle.write("\n")                       # blank lines are tolerated
            handle.write("{not json}\n")             # and so is a half-written tail
            handle.write(json.dumps({"name": "also_done.v0002"}) + "\n")

        for name in ("already.v0001", "also_done.v0002", "fresh.v0003"):
            open(os.path.join(root, name + ".scmap"), "wb").write(b"not a real map")

        out = os.path.join(root, "out.jsonl")
        code = mt.main([root, "--out", out, "--skip-known", done])
        check_eq("run succeeded", code, 0)
        names = [json.loads(line)["name"] for line in open(out, encoding="utf-8")]
        check_eq("only the unrecorded map was read", names, ["fresh.v0003"])


def test_name_checks():
    print("name checks")
    # Plenty of real map versions have no `.vNNNN` in their folder name, so
    # that is not a warning: `12 fields of isis v13` is a map called that.
    check_eq("distinct names, versioned or not", mt.check_names(
        ["/dump/scmp_009.v0001.scmap", "/dump/12 fields of isis v13.scmap"]), 0)
    # A collision is the one that matters: each name keys exactly one row.
    check("a duplicate name is reported",
          mt.check_names(["/a/x.v0001.scmap", "/b/X.v0001.scmap"]) > 0)


def test_version_names():
    print("version names")
    with tempfile.TemporaryDirectory() as root:
        # What an API dump looks like. Only `folderName` may be taken: a display
        # name or a url could collide with another map's folder name.
        dump = os.path.join(root, "dump.json")
        with open(dump, "w", encoding="utf-8") as handle:
            json.dump([
                {"id": "1", "displayName": "DualGap Adaptive",
                 "folderName": "dualgap_adaptive.v0014",
                 "downloadUrl": "https://x/maps/dualgap_adaptive.v0014.zip"},
                # An older version of the same map: the highest has to win.
                {"id": "2", "displayName": "DualGap Adaptive",
                 "folderName": "dualgap_adaptive.v0002"},
                # A map version with no suffix at all is a normal thing.
                {"id": "3", "displayName": "12 Fields of Isis",
                 "folderName": "12 fields of isis v13"},
            ], handle)
        names = mt.load_version_names(dump)
        check_eq("keyed without the version suffix", sorted(names),
                 ["12 fields of isis v13", "dualgap_adaptive"])
        check_eq("newest version wins", names["dualgap_adaptive"], "dualgap_adaptive.v0014")
        check("nothing but folder names was taken",
              not any("displayName" in n or "http" in n for n in names.values()))

        # A plain list of names has no `folderName` to prefer, and still works.
        plain = os.path.join(root, "plain.json")
        with open(plain, "w", encoding="utf-8") as handle:
            json.dump(["setons clutch.v0004", "12 fields of isis v13"], handle)
        names = mt.load_version_names(plain)
        check_eq("a bare list still works", names["setons clutch"], "setons clutch.v0004")

    # And the join itself: a file named for the map picks up its version.
    check_eq("version suffix stripped for the join",
             mt.strip_version("Setons Clutch.v0004"), "setons clutch")
    check_eq("a name that just ends in a letter-v is left alone",
             mt.strip_version("12 Fields of Isis V13"), "12 fields of isis v13")


def test_unkeyed_inputs_get_no_statement():
    print("unkeyed inputs")
    with tempfile.TemporaryDirectory() as root:
        # Archives carry dead `..._old.scmap` leftovers beside the live terrain,
        # and a fetch that extracts every terrain file picks them up. They are
        # not map versions and must not be written to a guessed row.
        for name in ("volcanoduel.scmap", "volcanoduel_old.scmap"):
            open(os.path.join(root, name), "wb").write(b"not a real map")
        names = {"volcanoduel": "volcanoduel.v0001"}

        live, _ = mt.analyse(os.path.join(root, "volcanoduel.scmap"), names)
        check_eq("the live one takes its version", live["name"], "volcanoduel.v0001")
        check("and is keyed", not live.get("unkeyed"))

        dead, _ = mt.analyse(os.path.join(root, "volcanoduel_old.scmap"), names)
        check("the leftover is marked unkeyed", dead.get("unkeyed") is True)
        check_eq("and gets no statement",
                 mt.update_statement({"name": "volcanoduel_old", "unkeyed": True,
                                      "waterPercent": 0, "biomes": []},
                                     mt.DEFAULT_SQL_KEY), None)

    # Without a name list nothing is unkeyed: the file name is the name.
    record, _ = mt.analyse("/nowhere/x.v0001.scmap")
    check("no list means nothing is unkeyed", not record.get("unkeyed"))


def test_map_families():
    print("map families")
    # Every spelling of the same map lands in one place: separators and capitals
    # are stripped before matching.
    for name in ("Dual Gap  TehNO", "dual_gap_scenic_adaptive.v0010",
                 "DualGap Adaptive", "adaptive_dualgap_survival.v0004"):
        check_eq("%s is dual gap" % name, mt.map_family(name), "DUAL_GAP")
    for name in ("Setons - 64 FFA", "setons_clutch_-_faf_version.v0004",
                 "TKP_SETON_LOWTIDE"):
        check_eq("%s is setons" % name, mt.map_family(name), "SETONS")
    # The stock Setons ships under a numbered folder and would otherwise be the
    # one the rule misses.
    check_eq("the stock Setons too", mt.map_family("SCMP_009"), "SETONS")
    check_eq("and its AI variant", mt.map_family("scmp_009_ai.v0001"), "SETONS")
    check_eq("but not another stock map", mt.map_family("scmp_012"), None)

    for name in ("astro_crater_battles", "3v3_astro_crater_revamp.v0002"):
        check_eq("%s is astro" % name, mt.map_family(name), "ASTRO_CRATER")

    # Narrow on purpose: plenty of maps are a gap map without being Dual Gap.
    for name in ("adaptive_quad_gap.v0003", "antigap.v0001", "artem_gap.v0005",
                 "Lucky 7 Gap.v0001", "gap of rohan"):
        check_eq("%s is no family" % name, mt.map_family(name), None)

    # Hybrids match two. The one whose token comes first in the name wins, so
    # the name decides rather than a fixed priority.
    check_eq("a hybrid lists both", mt.map_families("astro_seton.v0019"),
             ["ASTRO_CRATER", "SETONS"])
    check_eq("and leads with the first named", mt.map_family("astro_seton.v0019"),
             "ASTRO_CRATER")


def test_sql():
    print("sql")
    record = {
        "name": "africa_4v4.v0001", "waterPercent": 20,
        # A genuinely mixed map. Only the leading biome is stored: this is a
        # desert map, and the rest of what it contains stays in the JSON Lines
        # output rather than in the column.
        "biomes": [{"biome": "DESERT", "percent": 66},
                   {"biome": "TROPICAL", "percent": 27},
                   {"biome": "SWAMP", "percent": 7}],
    }
    statement = mt.update_statement(record, mt.DEFAULT_SQL_KEY)
    check("the two leading biomes, with their shares",
          "biome = 'DESERT', biome_percent = 66" in statement
          and "biome2 = 'TROPICAL', biome2_percent = 27" in statement, statement)
    check("and the third is left out", "SWAMP" not in statement, statement)

    # Without the share the second biome is a trap: this map is 99% evergreen
    # and would be findable as a desert map.
    thin = {"name": "dualgap.v0014", "waterPercent": 17, "family": None,
            "biomes": [{"biome": "EVERGREEN", "percent": 99},
                       {"biome": "DESERT", "percent": 1}]}
    check("a 1% second biome is stored with its 1%",
          "biome2 = 'DESERT', biome2_percent = 1"
          in mt.update_statement(thin, mt.DEFAULT_SQL_KEY))

    # One biome, and there simply is no second.
    single = {"name": "x.v0001", "waterPercent": 0, "family": None,
              "biomes": [{"biome": "LAVA", "percent": 100}]}
    check("no second biome writes an empty one",
          "biome2 = '', biome2_percent = 0"
          in mt.update_statement(single, mt.DEFAULT_SQL_KEY))

    # The family is the other axis and travels with it, not instead of it: a
    # Setons variant is a Setons map and an evergreen map.
    setons = {"name": "setons_clutch.v0004", "waterPercent": 59,
              "biomes": [{"biome": "EVERGREEN", "percent": 100}],
              "family": "SETONS"}
    statement = mt.update_statement(setons, mt.DEFAULT_SQL_KEY)
    check("both axes are written", "biome = 'EVERGREEN'" in statement
          and "family = 'SETONS'" in statement, statement)

    # NULL has to keep meaning "never looked", so an analysed map with no
    # classifiable texture stores an empty value instead.
    empty = {"name": "odd.v0001", "waterPercent": 0, "biomes": []}
    check("no biome stores an empty value, not NULL",
          "biome = '', biome_percent = 0"
          in mt.update_statement(empty, mt.DEFAULT_SQL_KEY))

    check("the row key follows the template",
          "WHERE filename = '/vault/odd.v0001/archive.zip'"
          in mt.update_statement(empty, "/vault/{name}/archive.zip"))

    # Nothing in the vault is called this, and a back-fill that can be steered
    # by a file name is not one anybody should run.
    nasty = {"name": "o'brien'; DROP TABLE map_version;--", "waterPercent": 0, "biomes": []}
    statement = mt.update_statement(nasty, mt.DEFAULT_SQL_KEY)
    check("quotes are doubled", "''brien''" in statement, statement)
    check("so the literal is never closed early", "o'brien" not in statement, statement)
    check("and the statement ends where it should", statement.endswith("';"), statement)


# ---------------------------------------------------------------- real maps

def test_corpus():
    print("corpus")
    corpus = os.environ.get("FAF_MAP_CORPUS")
    if not corpus or not os.path.isdir(corpus):
        print("  skip (set FAF_MAP_CORPUS to a maps folder to run this)")
        return
    found = []
    mt.collect(corpus, 0, found)
    check("the corpus has maps in it", len(found) > 20, str(len(found)))

    decoded = broken = 0
    for path in found:
        record, _ = mt.analyse(path)
        if "error" in record:
            # A placeholder file or a truncated upload; a few are expected.
            broken += 1
            continue
        decoded += 1
        check_eq("%s percentages are whole and bounded" % record["name"],
                 [b for b in record["biomes"] if not 1 <= b["percent"] <= 100], [])
        check("%s water is a percentage" % record["name"],
              0 <= record["waterPercent"] <= 100)
    print("  decoded %d, unreadable %d" % (decoded, broken))
    # One percent is the budget: past that the decoder has lost a format
    # version, rather than the install being unusual.
    check("almost everything decodes", broken <= max(1, len(found) // 100),
          "%d of %d" % (broken, len(found)))

    # The map that decided the approach: averaging its preview colours calls its
    # land yellow, its textures say evergreen, and it is a naval map.
    setons = next((p for p in found if os.path.basename(p).lower() == "scmp_009"), None)
    if setons:
        record, _ = mt.analyse(setons)
        check_eq("Seton's Clutch is evergreen", record["biomes"][0]["biome"], "EVERGREEN")
        check("Seton's Clutch is naval", record["waterPercent"] > 40, str(record["waterPercent"]))


if __name__ == "__main__":
    test_classification()
    test_value_set()
    test_weighing()
    test_half_range_remap()
    test_only_dry_ground_is_weighed()
    test_water()
    test_composite_paths_agree()
    test_naming_and_walking()
    test_failures_are_records()
    test_skip_known()
    test_name_checks()
    test_version_names()
    test_map_families()
    test_unkeyed_inputs_get_no_statement()
    test_sql()
    test_corpus()
    print()
    if failures:
        print("%d check(s) failed: %s" % (len(failures), ", ".join(failures)))
        sys.exit(1)
    print("all checks passed")
