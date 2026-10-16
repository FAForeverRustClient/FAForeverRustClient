import { describe, expect, it } from "vitest";
import type { TourneyMap, VaultMap } from "../../ipc/bindings";
import { needsSizeLookup, specSizeOf, tourneyMapSize, withKnownSize } from "./mapSizePresentation";

const vaultMap = (displayName: string, width: number, height: number): VaultMap =>
  ({ displayName, folderName: `${displayName.toLowerCase().replace(/\W+/g, "_")}.v0001`, width, height }) as VaultMap;

const tourneyMap = (name: string, overrides: Partial<TourneyMap> = {}): TourneyMap =>
  ({
    id: "m1",
    name,
    imageUrl: "",
    description: "",
    published: true,
    spec: null,
    secret: false,
    masked: false,
    ...overrides,
  });

const vault = [vaultMap("Test Plateau", 512, 512), vaultMap("Long Strip", 512, 1024), vaultMap("Odd One", 768, 768)];

describe("specSizeOf", () => {
  it("names the website's square sizes and nothing else", () => {
    expect(specSizeOf(256, 256)).toBe("5x5");
    expect(specSizeOf(4096, 4096)).toBe("81x81");
    expect(specSizeOf(768, 768)).toBe("");
    expect(specSizeOf(512, 1024)).toBe("");
  });
});

describe("tourneyMapSize", () => {
  it("keeps the organiser's size over anything the client knows", () => {
    const spec = { team1Spawns: [], team2Spawns: [], closedSpawns: [], closedMexSpawns: [], size: "20x20" };
    expect(tourneyMapSize(tourneyMap("Test Plateau", { spec }), vault)).toBe("20x20");
  });

  it("fills an empty size from the vault, matched the way the pool matches", () => {
    expect(tourneyMapSize(tourneyMap("test plateau"), vault)).toBe("10x10");
    expect(tourneyMapSize(tourneyMap("Long Strip"), vault)).toBe("10x20");
    expect(tourneyMapSize(tourneyMap("Odd One"), vault)).toBe("15x15");
  });

  it("takes a base-game map's size from the game's own list", () => {
    expect(tourneyMapSize(tourneyMap("Seton's Clutch"), [])).toBe("20x20");
  });

  it("trusts the game's own list over a vault record under the same name", () => {
    // Ambush Pass is a 5 km base-game map; a vault record claiming 10 km loses.
    expect(tourneyMapSize(tourneyMap("Ambush Pass"), [vaultMap("Ambush Pass", 512, 512)])).toBe("5x5");
  });

  it("says nothing for a secret map or one nobody knows", () => {
    expect(tourneyMapSize(tourneyMap("Test Plateau", { masked: true }), vault)).toBe("");
    expect(tourneyMapSize(tourneyMap("Nowhere"), vault)).toBe("");
  });
});

describe("needsSizeLookup", () => {
  it("asks only for an unsized, unmasked map the client cannot place", () => {
    expect(needsSizeLookup(tourneyMap("Nowhere"), vault)).toBe(true);
    expect(needsSizeLookup(tourneyMap("Test Plateau"), vault)).toBe(false);
    expect(needsSizeLookup(tourneyMap("Hidden Map 1", { masked: true }), vault)).toBe(false);
    // The vault holds no generated map, so it is never asked for one.
    expect(needsSizeLookup(tourneyMap("neroxis_map_generator_1.22.2_yzlqo3opnhdoi_ayfqeaa"), vault)).toBe(false);
  });
});

describe("withKnownSize", () => {
  it("fills an empty size and keeps the spawns", () => {
    const spec = { team1Spawns: [1], team2Spawns: [2], closedSpawns: [], closedMexSpawns: [], size: "" };
    expect(withKnownSize(spec, "Test Plateau", vault)).toEqual({ ...spec, size: "10x10" });
    expect(withKnownSize(null, "Test Plateau", vault)?.size).toBe("10x10");
  });

  it("leaves a chosen size, and a size the editor has no option for, alone", () => {
    const chosen = { team1Spawns: [], team2Spawns: [], closedSpawns: [], closedMexSpawns: [], size: "5x5" };
    expect(withKnownSize(chosen, "Test Plateau", vault)).toBe(chosen);
    expect(withKnownSize(null, "Odd One", vault)).toBeNull();
  });
});
