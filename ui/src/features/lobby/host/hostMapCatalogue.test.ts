import { describe, expect, it } from "vitest";

import type { InstalledMap, VaultMap } from "../../../ipc/bindings";
import {
  activeFilterCount,
  buildHostCatalogue,
  buildVaultIndex,
  filterHostMaps,
  NO_PICKER_FILTERS,
  NO_RANGE,
  resolveChosenMap,
  withinRange,
  withUncataloguedMaps,
  type HostMap,
} from "./hostMapCatalogue";

function vaultMap(fields: Partial<VaultMap> & { folderName: string; displayName: string }): VaultMap {
  return {
    mapId: 1,
    versionId: 1,
    author: "Author",
    authorId: null,
    version: "3",
    description: "From the vault",
    mapType: "skirmish",
    maxPlayers: 6,
    width: 512,
    height: 512,
    gamesPlayed: 0,
    versionGamesPlayed: 0,
    ranked: true,
    hidden: false,
    recommended: false,
    ratingTenths: 0,
    reviews: 0,
    createdAt: "",
    downloadUrl: "",
    thumbnailUrl: "",
    thumbnailUrlLarge: "",
    ...fields,
  };
}

function hostMap(fields: Partial<HostMap> & { folderName: string }): HostMap {
  return {
    displayName: fields.folderName,
    maxPlayers: 8,
    width: 1024,
    height: 1024,
    ranked: true,
    ...fields,
  };
}

describe("withinRange", () => {
  it("lets an unknown value through any range", () => {
    expect(withinRange(0, { low: 5, high: 10 })).toBe(true);
  });

  it("checks both open and closed ends", () => {
    expect(withinRange(4, { low: 5, high: null })).toBe(false);
    expect(withinRange(11, { low: null, high: 10 })).toBe(false);
    expect(withinRange(7, { low: 5, high: 10 })).toBe(true);
    expect(withinRange(7, NO_RANGE)).toBe(true);
  });
});

describe("buildHostCatalogue", () => {
  it("lists every base-game map as ranked with the given description", () => {
    const catalogue = buildHostCatalogue([], buildVaultIndex([]), "official");
    const burial = catalogue.get("scmp_001");
    expect(burial).toMatchObject({ displayName: "Burial Mounds", ranked: true, description: "official" });
  });

  it("fills an installed map's gaps from an older vault version by base name", () => {
    const vault = [vaultMap({ folderName: "canis.v0004", displayName: "Canis River" })];
    const installed: InstalledMap[] = [{ folderName: "canis.v0002", displayName: "canis" }];
    const entry = buildHostCatalogue(installed, buildVaultIndex(vault), "official").get("canis.v0002");
    expect(entry).toMatchObject({
      displayName: "Canis River",
      folderName: "canis.v0002",
      maxPlayers: 6,
      width: 512,
      author: "Author",
      ranked: true,
    });
  });

  it("prefers the installed map's own size and rates an unknown non-base map as unranked", () => {
    const installed: InstalledMap[] = [
      { folderName: "homebrew", displayName: "Homebrew", maxPlayers: 2, width: 256, height: 256 },
    ];
    const entry = buildHostCatalogue(installed, buildVaultIndex([]), "official").get("homebrew");
    expect(entry).toMatchObject({ maxPlayers: 2, width: 256, height: 256, ranked: false });
  });
});

describe("withUncataloguedMaps", () => {
  const catalogue = new Map([["known", hostMap({ folderName: "known" })]]);

  it("appends a selected map the catalogue does not hold", () => {
    const all = withUncataloguedMaps(catalogue, "neroxis_map_generator_1.0.0_abc", [], "generated");
    expect(all.map((map) => map.folderName)).toEqual(["known", "neroxis_map_generator_1.0.0_abc"]);
    expect(all[1]).toMatchObject({ ranked: false, description: "generated" });
  });

  it("lists starred generated maps once, and skips starred ordinary maps", () => {
    const generated = "neroxis_map_generator_1.0.0_xyz";
    const all = withUncataloguedMaps(catalogue, generated, [generated, "some_vault_map", "known"], "generated");
    expect(all.map((map) => map.folderName)).toEqual(["known", generated]);
  });
});

describe("filterHostMaps", () => {
  const maps = [
    hostMap({ folderName: "b", displayName: "Bravo", ranked: false }),
    hostMap({ folderName: "a", displayName: "Alpha", maxPlayers: 2 }),
    hostMap({ folderName: "c", displayName: "Charlie", width: 4096, height: 4096 }),
  ];

  it("sorts by display name when nothing filters", () => {
    expect(filterHostMaps(maps, NO_PICKER_FILTERS).map((map) => map.displayName)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
  });

  it("matches the search against name or folder, ignoring case", () => {
    const result = filterHostMaps(maps, { ...NO_PICKER_FILTERS, mapSearch: "  CHAR " });
    expect(result.map((map) => map.folderName)).toEqual(["c"]);
  });

  it("applies the ranked, player and size filters", () => {
    expect(filterHostMaps(maps, { ...NO_PICKER_FILTERS, rankedFilter: "unranked" }).map((m) => m.folderName))
      .toEqual(["b"]);
    expect(filterHostMaps(maps, { ...NO_PICKER_FILTERS, playerCount: { low: 4, high: null } }).map((m) => m.folderName))
      .toEqual(["b", "c"]);
    expect(filterHostMaps(maps, { ...NO_PICKER_FILTERS, widthKm: { low: 40, high: null } }).map((m) => m.folderName))
      .toEqual(["c"]);
  });
});

describe("resolveChosenMap", () => {
  const all = [hostMap({ folderName: "Alpha" }), hostMap({ folderName: "Bravo" })];

  it("finds the selection case-insensitively among every map, not only the visible ones", () => {
    expect(resolveChosenMap(all, [all[1]], "alpha")?.folderName).toBe("Alpha");
  });

  it("falls back to the first visible map, then the first map", () => {
    expect(resolveChosenMap(all, [all[1]], "missing")?.folderName).toBe("Bravo");
    expect(resolveChosenMap(all, [], "missing")?.folderName).toBe("Alpha");
    expect(resolveChosenMap([], [], "missing")).toBeUndefined();
  });
});

describe("activeFilterCount", () => {
  it("counts each bounded range and a narrowed ranked filter", () => {
    expect(activeFilterCount(NO_PICKER_FILTERS)).toBe(0);
    expect(
      activeFilterCount({
        ...NO_PICKER_FILTERS,
        widthKm: { low: 5, high: null },
        playerCount: { low: null, high: 8 },
        rankedFilter: "ranked",
      }),
    ).toBe(3);
  });
});
