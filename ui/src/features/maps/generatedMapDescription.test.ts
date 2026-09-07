import { describe, expect, it } from "vitest";

import { translateIn } from "../../i18n";
import {
  generatedMapDescriptionRows,
  isGeneratedMapDescription,
  mergeGeneratorRows,
} from "./generatedMapDescription";

// The real English catalogue, so a missing or misnamed key fails the test
// rather than silently rendering a placeholder.
const t: Parameters<typeof generatedMapDescriptionRows>[1] = (key, values) =>
  translateIn("en", key, values);

/**
 * A real description, copied verbatim out of a generated map's `_scenario.lua`
 * as the client receives it: one line, escapes unexpanded, the seed twice, the
 * style once as `null` and once for real.
 */
const REAL =
  "Seed: -2207507018540207222\\r\\nSeed: -2207507018540207222\\r\\nSpawns: 12\\r\\n" +
  "Map Size: 1024\\r\\nNum Teams: 2\\r\\nTerrain Symmetry: null\\r\\nStyle: null\\r\\n" +
  "Style: FRACTAL_LAND\\r\\n" +
  "Symmetry Settings: SymmetrySettings[terrainSymmetry=ZX, teamSymmetry=ZX, spawnSymmetry=ZX]\\r\\n" +
  "Biome: CRYSTALLINE\\r\\nTerrainStyle: FRACTAL_LAND\\r\\nResourceStyle: BASIC\\r\\n" +
  "PropStyle: NEUTRAL_CIV\\r\\n";

const rows = (description: string) =>
  generatedMapDescriptionRows(description, t).map((row) => [row.label, row.value]);

describe("a real generator description", () => {
  it("reads every setting the generator recorded", () => {
    expect(rows(REAL)).toEqual([
      ["Map size", "20 km (1024×1024)"],
      ["Spawns", "12"],
      ["Teams", "2"],
      ["Style of game", "Fractal land"],
      ["Terrain", "Fractal land"],
      ["Biome", "Crystalline"],
      ["Resources", "Basic"],
      ["Props", "Neutral civ"],
      ["Terrain symmetry", "ZX"],
      ["Team symmetry", "ZX"],
      ["Spawn symmetry", "ZX"],
      ["Seed", "-2207507018540207222"],
    ]);
  });

  it("says each thing once, however often the generator wrote it", () => {
    const labels = generatedMapDescriptionRows(REAL, t).map((row) => row.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("drops the settings the generator had nothing to say about", () => {
    // `Terrain Symmetry: null` is in there, and is superseded by the populated
    // one inside `SymmetrySettings` rather than shown as an empty row.
    expect(rows(REAL)).not.toContainEqual(["Terrain symmetry", "null"]);
    expect(rows(REAL).every(([, value]) => value !== "null")).toBe(true);
  });
});

describe("tolerance", () => {
  it("leaves an ordinary map's prose alone", () => {
    expect(isGeneratedMapDescription("A balanced battleground for 4 players.")).toBe(false);
    expect(generatedMapDescriptionRows("A classic team map.", t)).toEqual([]);
  });

  it("ignores an empty or absent description", () => {
    expect(generatedMapDescriptionRows("", t)).toEqual([]);
    expect(generatedMapDescriptionRows(null, t)).toEqual([]);
    expect(generatedMapDescriptionRows(undefined, t)).toEqual([]);
  });

  it("does not treat one stray colon as a generator description", () => {
    expect(isGeneratedMapDescription("Style: aggressive, for veterans only")).toBe(false);
  });

  it("shows a setting from a newer generator under a humanised label", () => {
    const withUnknown = `${REAL}\\r\\nHydroCount: 4\\r\\nnew_thing: whatever`;
    expect(rows(withUnknown)).toContainEqual(["Hydro count", "4"]);
    expect(rows(withUnknown)).toContainEqual(["New thing", "whatever"]);
  });

  it("keeps a record value whole when its insides do not parse", () => {
    const odd = "Spawns: 8\\r\\nMap Size: 512\\r\\nSymmetry Settings: Something[opaque]";
    expect(rows(odd)).toContainEqual(["Symmetry settings", "Something[opaque]"]);
  });

  it("reads real newlines as well as the escaped ones", () => {
    const unescaped = REAL.replace(/\\r\\n/g, "\r\n");
    expect(rows(unescaped)).toEqual(rows(REAL));
  });

  it("shows a map size it cannot make sense of verbatim", () => {
    expect(rows("Spawns: 8\\r\\nMap Size: enormous")).toContainEqual(["Map size", "enormous"]);
  });

  it("names a team-less map asymmetric, as the generate dialog does", () => {
    expect(rows("Spawns: 8\\r\\nMap Size: 512\\r\\nNum Teams: 0")).toContainEqual([
      "Teams",
      "Asymmetric (no teams)",
    ]);
  });
});

describe("merging with what the folder name decodes to", () => {
  const nameRows = [
    { key: "size", label: "Map size", value: "20 km (1024×1024)" },
    { key: "reclaimDensity", label: "Reclaim density", value: "75%" },
    { key: "version", label: "Generator version", value: "1.22.1" },
    { key: "seed", label: "Seed", value: "-2207507018540207222" },
  ];

  it("keeps what only the name knows and never repeats a label", () => {
    const merged = mergeGeneratorRows(generatedMapDescriptionRows(REAL, t), nameRows);
    const labels = merged.map((row) => row.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain("Reclaim density");
    expect(labels).toContain("Generator version");
  });

  it("keeps the description's value where both sources have one", () => {
    const conflicting = [{ key: "size", label: "Map size", value: "nonsense" }];
    const merged = mergeGeneratorRows(generatedMapDescriptionRows(REAL, t), conflicting);
    expect(merged.find((row) => row.label === "Map size")?.value).toBe("20 km (1024×1024)");
  });

  it("leaves the seed last, where both sources put it", () => {
    const merged = mergeGeneratorRows(generatedMapDescriptionRows(REAL, t), nameRows);
    expect(merged[merged.length - 1]?.label).toBe("Seed");
  });

  it("is the name alone when the map is not installed and has no description", () => {
    expect(mergeGeneratorRows([], nameRows)).toEqual(nameRows);
  });
});
