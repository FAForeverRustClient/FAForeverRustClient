import { describe, expect, it } from "vitest";
import type {
  DecodedMapName,
  GeneratorOptions,
  GeneratorStatus,
  ValidationIssue,
} from "../../ipc/bindings";
import { translateIn } from "../../i18n";
import {
  MAP_SIZES,
  MAP_SIZE_STEP,
  TEAM_COUNTS,
  canGenerate,
  densityPercent,
  describeIssue,
  formatMapSize,
  isFatal,
  nearestLegalSpawnCount,
  outcomeOfRun,
  sizeInKm,
  spawnCountsFor,
  summariseDecodedName,
  titleCase,
} from "./generatorPresentation";

const decoded = (overrides: Partial<DecodedMapName> = {}): DecodedMapName => ({
  version: "1.22.1",
  seed: "12345",
  spawnCount: 6,
  mapSize: 512,
  numTeams: 2,
  symmetry: null,
  style: null,
  visibility: null,
  generatedAt: null,
  ...overrides,
});

const options = (overrides: Partial<GeneratorOptions> = {}): GeneratorOptions =>
  ({ commandLineArgs: "", ...overrides }) as GeneratorOptions;

// The real English catalogue, so a missing or misnamed key fails the test
// rather than silently rendering a placeholder.
const t: Parameters<typeof describeIssue>[1] = (key, values) => translateIn("en", key, values);

describe("map sizes", () => {
  it("offers every size on the generator's 64-unit grid", () => {
    // The grid is not cosmetic: the generator stores size as a byte of 64-unit
    // steps and refuses anything else.
    for (const size of MAP_SIZES) {
      expect(size % MAP_SIZE_STEP).toBe(0);
    }
  });

  it("covers the whole 5-20 km range the Java client offers", () => {
    // Five of these thirteen used to be missing.
    const expected = [256, 320, 384, 448, 512, 576, 640, 704, 768, 832, 896, 960, 1024];
    expect(MAP_SIZES).toEqual(expect.arrayContaining(expected));
  });

  it("stays inside the generator's own ceiling", () => {
    expect(Math.max(...MAP_SIZES)).toBeLessThanOrEqual(2048);
  });

  it("converts units to kilometres the way the generator does", () => {
    expect(sizeInKm(512)).toBeCloseTo(10);
    expect(sizeInKm(1024)).toBeCloseTo(20);
    expect(sizeInKm(256)).toBeCloseTo(5);
  });

  it("labels sizes with both units", () => {
    expect(formatMapSize(512)).toBe("10 km (512×512)");
    expect(formatMapSize(320)).toBe("6.25 km (320×320)");
  });
});

describe("team and spawn counts", () => {
  it("offers asymmetric maps and every team count up to the generator's limit", () => {
    // 0 is a real option ("no teams asymmetric"), 1 is meaningless.
    expect(TEAM_COUNTS).toContain(0);
    expect(TEAM_COUNTS).not.toContain(1);
    expect(Math.max(...TEAM_COUNTS)).toBe(16);
  });

  it("only offers spawn counts that divide evenly among the teams", () => {
    // Anything else is a guaranteed refusal from the generator.
    expect(spawnCountsFor(2)).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(spawnCountsFor(3)).toEqual([3, 6, 9, 12, 15]);
    expect(spawnCountsFor(4)).toEqual([4, 8, 12, 16]);
  });

  it("offers every spawn count for an asymmetric map", () => {
    // With no teams the divisibility rule does not apply at all.
    expect(spawnCountsFor(0)).toHaveLength(15);
    expect(spawnCountsFor(0)).toContain(5);
  });

  it("moves an illegal spawn count to the nearest legal one", () => {
    // Changing the team count must not silently leave an invalid pairing.
    expect(nearestLegalSpawnCount(5, 2)).toBe(4);
    expect(nearestLegalSpawnCount(7, 2)).toBe(6);
    expect(nearestLegalSpawnCount(6, 4)).toBe(4);
    expect(nearestLegalSpawnCount(6, 2)).toBe(6);
    expect(nearestLegalSpawnCount(5, 0)).toBe(5);
  });
});

describe("validation messages", () => {
  it("explains a spawn/team mismatch in the generator's own terms", () => {
    const issue: ValidationIssue = {
      kind: "spawnsNotDivisibleByTeams",
      payload: { spawnCount: 5, numTeams: 2 },
    };
    expect(describeIssue(issue, t)).toContain("5 spawns");
    expect(describeIssue(issue, t)).toContain("2 teams");
    expect(isFatal(issue)).toBe(true);
  });

  it("explains an incompatible symmetry", () => {
    const issue: ValidationIssue = {
      kind: "symmetryIncompatible",
      payload: { symmetries: ["POINT3"], numTeams: 2 },
    };
    expect(describeIssue(issue, t)).toBe("POINT3 cannot produce 2 teams.");
  });

  it("treats a style outside its range as advice, not a blocker", () => {
    const issue: ValidationIssue = {
      kind: "styleOutsideItsRange",
      payload: {
        style: "BIG_ISLANDS",
        constraints: {
          minMapSize: 768,
          maxMapSize: 1024,
          minSpawnCount: 0,
          maxSpawnCount: 16,
          minNumTeams: 0,
          maxNumTeams: 16,
        },
      },
    };
    expect(isFatal(issue)).toBe(false);
    expect(describeIssue(issue, t)).toContain("15 km");
    expect(describeIssue(issue, t)).toContain("still generate");
  });

  it("blocks generation on fatal issues only", () => {
    const fatal: ValidationIssue = {
      kind: "mapSizeNotAMultiple",
      payload: { mapSize: 500 },
    };
    const advisory: ValidationIssue = {
      kind: "styleOutsideItsRange",
      payload: {
        style: "BIG_ISLANDS",
        constraints: {
          minMapSize: 768,
          maxMapSize: 1024,
          minSpawnCount: 0,
          maxSpawnCount: 16,
          minNumTeams: 0,
          maxNumTeams: 16,
        },
      },
    };
    expect(canGenerate(options(), [fatal])).toBe(false);
    expect(canGenerate(options(), [advisory])).toBe(true);
    expect(canGenerate(options(), [])).toBe(true);
  });

  it("lets raw arguments through regardless", () => {
    // The escape hatch has to actually escape.
    const fatal: ValidationIssue = {
      kind: "mapSizeNotAMultiple",
      payload: { mapSize: 500 },
    };
    expect(canGenerate(options({ commandLineArgs: "--map-size 500" }), [fatal])).toBe(true);
  });
});

describe("decoded map names", () => {
  it("summarises a predefined-style map", () => {
    const parts = summariseDecodedName(
      decoded({ symmetry: "POINT2", style: { kind: "predefined", style: "MOUNTAIN_RANGE" } }),
    );
    expect(parts).toEqual(["10 km (512×512)", "6 spawns", "2 teams", "POINT2", "Mountain range"]);
  });

  it("summarises a custom-style map with its terrain and texture", () => {
    const parts = summariseDecodedName(
      decoded({
        mapSize: 1024,
        spawnCount: 8,
        numTeams: 4,
        style: {
          kind: "custom",
          terrainStyle: "FLOODED",
          textureStyle: "SYRTIS",
          resourceStyle: "LOW_MEX",
          propStyle: "ROCK_FIELD",
          reclaimDensity: 0.75,
          resourceDensity: 0.25,
        },
      }),
    );
    expect(parts).toContain("20 km (1024×1024)");
    expect(parts).toContain("4 teams");
    expect(parts).toContain("Flooded");
    expect(parts).toContain("Syrtis");
  });

  it("calls a zero-team map asymmetric rather than '0 teams'", () => {
    expect(summariseDecodedName(decoded({ numTeams: 0 }))).toContain("asymmetric");
  });

  it("shows the visibility instead of a style for tournament maps", () => {
    // Those maps deliberately reveal nothing about their terrain.
    const parts = summariseDecodedName(decoded({ visibility: "TOURNAMENT" }));
    expect(parts).toContain("Tournament");
  });

  it("omits what it cannot name rather than guessing", () => {
    // A style ordinal from a newer generator decodes to null; inventing a name
    // would be worse than saying nothing.
    const parts = summariseDecodedName(decoded({ style: { kind: "predefined", style: null } }));
    expect(parts).toEqual(["10 km (512×512)", "6 spawns", "2 teams"]);
  });
});

describe("recognising our own run's outcome", () => {
  // The generator status is sticky: it keeps reporting the last run's maps
  // until something replaces it. These cases pin the reported bug shut.
  const generated = (maps: string[]): GeneratorStatus => ({
    type: "generated",
    payload: { maps },
  });

  it("ignores the status that was already showing when the run was asked for", () => {
    // The bug: clicking Generate a second time used to report the previous
    // run's maps immediately, before the new run had produced anything.
    const previous = generated(["map_a", "map_b"]);
    expect(outcomeOfRun(previous, previous)).toEqual({ kind: "waiting" });
  });

  it("reports the new result once it actually arrives", () => {
    const previous = generated(["map_a", "map_b"]);
    const fresh = generated(["map_c"]);
    expect(outcomeOfRun(fresh, previous)).toEqual({ kind: "generated", maps: ["map_c"] });
  });

  it("keeps waiting through every intermediate stage", () => {
    const previous = generated(["map_a"]);
    const stages: GeneratorStatus[] = [
      { type: "preparing" },
      { type: "resolvingVersion" },
      { type: "downloading", payload: { version: "1.22.1", downloadedBytes: 1, totalBytes: 2 } },
      { type: "generating", payload: { version: "1.22.1", detail: "…" } },
    ];
    for (const stage of stages) {
      expect(outcomeOfRun(stage, previous)).toEqual({ kind: "waiting" });
    }
  });

  it("ends the wait on a failure or a cancellation without reporting maps", () => {
    const previous = generated(["map_a"]);
    expect(outcomeOfRun({ type: "failed", payload: { reason: "nope" } }, previous)).toEqual({
      kind: "stopped",
    });
    expect(outcomeOfRun({ type: "cancelled" }, previous)).toEqual({ kind: "stopped" });
  });

  it("does nothing at all when no run of ours is outstanding", () => {
    // Another part of the client generating a map must not open our overview.
    expect(outcomeOfRun(generated(["map_a"]), null)).toEqual({ kind: "waiting" });
  });

  it("reports a single-map run just like a multi-map one", () => {
    // The other half of the bug: one map used to skip the overview entirely.
    const previous: GeneratorStatus = { type: "idle" };
    expect(outcomeOfRun(generated(["only_one"]), previous)).toEqual({
      kind: "generated",
      maps: ["only_one"],
    });
  });

  it("reports an empty result as generated rather than as still waiting", () => {
    // A run that reports success with no folders is a backend problem, but the
    // dialog must stop spinning either way.
    const previous: GeneratorStatus = { type: "idle" };
    expect(outcomeOfRun(generated([]), previous)).toEqual({ kind: "generated", maps: [] });
  });
});

describe("densities", () => {
  it("shows the bin scale as the percentage it really is", () => {
    // The sliders speak the generator's 127 bins; users think in percent.
    expect(densityPercent(0)).toBe(0);
    expect(densityPercent(127)).toBe(100);
    expect(densityPercent(64)).toBe(50);
  });
});

describe("labels", () => {
  it("makes screaming snake case readable", () => {
    expect(titleCase("MOUNTAIN_RANGE")).toBe("Mountain range");
    expect(titleCase("BASIC")).toBe("Basic");
  });
});
