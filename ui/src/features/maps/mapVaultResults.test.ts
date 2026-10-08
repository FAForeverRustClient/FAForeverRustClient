import { describe, expect, it } from "vitest";
import type { MapVaultQuery, VaultMap } from "../../ipc/bindings";
import { EMPTY_MAP_QUERY } from "../../shared/vaultQuery";
import { mapsByDownload, mapsMatchingQuery, visibleVaultMaps } from "./mapVaultResults";

function map(folderName: string, extra: Partial<VaultMap> = {}): VaultMap {
  return {
    mapId: 1,
    versionId: 1,
    displayName: folderName,
    author: "Nuggets",
    authorId: 4711,
    folderName,
    version: "15",
    description: "",
    mapType: "skirmish",
    maxPlayers: 12,
    width: 256,
    height: 256,
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
    ...extra,
  };
}

const NONE = new Set<string>();
const DEFAULTS = { showHidden: false, ownMaps: false, installFilter: "all" as const, installedFolders: NONE };

describe("visibleVaultMaps", () => {
  it("drops a withdrawn map the API returned anyway", () => {
    // The reported bug. Every search but "my maps" sends
    // `latestVersion.hidden=='false'`, and a withdrawn map came back through
    // it regardless, so the tab cannot take the query's word for it.
    const page = [map("visible"), map("withdrawn", { hidden: true })];

    expect(visibleVaultMaps(page, DEFAULTS).map((m) => m.folderName)).toEqual(["visible"]);
  });

  it("keeps withdrawn maps once they are asked for", () => {
    const page = [map("visible"), map("withdrawn", { hidden: true })];

    expect(visibleVaultMaps(page, { ...DEFAULTS, showHidden: true })).toHaveLength(2);
  });

  it("keeps withdrawn maps in my maps without being asked", () => {
    // An author is the one person who still needs to see what they withdrew,
    // and the control is not offered on that preset.
    const page = [map("withdrawn", { hidden: true })];

    expect(visibleVaultMaps(page, { ...DEFAULTS, ownMaps: true })).toHaveLength(1);
  });

  it("applies the install filter after the visibility rule, not instead of it", () => {
    // A withdrawn map the user already has installed is the exact case in the
    // report: it must not come back through the "installed" filter.
    const page = [map("withdrawn", { hidden: true }), map("kept")];
    const installedFolders = new Set(["withdrawn", "kept"]);

    const shown = visibleVaultMaps(page, { ...DEFAULTS, installFilter: "installed", installedFolders });

    expect(shown.map((m) => m.folderName)).toEqual(["kept"]);
  });
});

describe("mapsMatchingQuery", () => {
  // The favourites preset: the search, filters and sort it shows have to do
  // to the starred maps what the server query would have done to the vault.
  const starred = [
    map("seton", { displayName: "Seton's Clutch", author: "GPG", ratingTenths: 45, reviews: 300, maxPlayers: 8, width: 1024, height: 1024, createdAt: "2014-03-01T10:00:00Z", gamesPlayed: 9000 }),
    map("dual", { displayName: "Dual Gap", author: "Nuggets", ratingTenths: 38, reviews: 40, maxPlayers: 8, width: 512, height: 512, createdAt: "2021-07-15T10:00:00Z", gamesPlayed: 50, ranked: false }),
    map("astro", { displayName: "Astro Crater", author: null, ratingTenths: 0, reviews: 0, maxPlayers: 4, width: 256, height: 256, createdAt: "2023-01-02T10:00:00Z", gamesPlayed: 400 }),
  ];
  const names = (maps: VaultMap[]) => maps.map((m) => m.folderName);

  it("matches the search against the display name, ignoring case", () => {
    expect(names(mapsMatchingQuery(starred, { ...EMPTY_MAP_QUERY, search: " CLUTCH " }))).toEqual(["seton"]);
  });

  it("matches the author login, and never a map without one", () => {
    expect(names(mapsMatchingQuery(starred, { ...EMPTY_MAP_QUERY, author: "nug" }))).toEqual(["dual"]);
  });

  it("applies ranked, slots and size", () => {
    const query = { ...EMPTY_MAP_QUERY, ranked: true, minPlayers: 6, width: 1024 };
    expect(names(mapsMatchingQuery(starred, query))).toEqual(["seton"]);
  });

  it("drops unreviewed maps once a rating bound is set, as the server does", () => {
    const query = { ...EMPTY_MAP_QUERY, minRatingTenths: 0, maxRatingTenths: 40 };
    expect(names(mapsMatchingQuery(starred, query))).toEqual(["dual"]);
  });

  it("bounds the upload date inclusively", () => {
    const query = { ...EMPTY_MAP_QUERY, after: "2021-07-15", before: "2023-01-02" };
    expect(names(mapsMatchingQuery(starred, { ...query, sortBy: "name" as const, sortDescending: false })))
      .toEqual(["astro", "dual"]);
  });

  it("drops withdrawn versions unless they are asked for", () => {
    const withdrawn = [...starred, map("gone", { hidden: true })];
    expect(mapsMatchingQuery(withdrawn, EMPTY_MAP_QUERY)).toHaveLength(3);
    expect(mapsMatchingQuery(withdrawn, { ...EMPTY_MAP_QUERY, includeHidden: true })).toHaveLength(4);
  });

  it("sorts the way the query asks", () => {
    const sorted = (sortBy: MapVaultQuery["sortBy"], sortDescending = true) =>
      names(mapsMatchingQuery(starred, { ...EMPTY_MAP_QUERY, sortBy, sortDescending }));
    expect(sorted("rating")).toEqual(["seton", "dual", "astro"]);
    expect(sorted("newest")).toEqual(["astro", "dual", "seton"]);
    expect(sorted("played")).toEqual(["seton", "astro", "dual"]);
    expect(sorted("size")).toEqual(["seton", "dual", "astro"]);
    expect(sorted("name", false)).toEqual(["astro", "dual", "seton"]);
  });
});

describe("mapsByDownload (#453)", () => {
  const vault = [
    map("seton_clutch.v0003", { displayName: "Seton's Clutch", recommended: true }),
    map("dual_gap.v0004", { displayName: "Dual Gap" }),
    map("theta_passage.v0002", { displayName: "Theta Passage" }),
    map("never_downloaded.v0001", { displayName: "Never downloaded" }),
  ];
  const installed = [
    { folderName: "seton_clutch.v0003", installedAt: "2026-10-01T10:00:00Z" },
    // An older version than the catalogue's stands for its map.
    { folderName: "dual_gap.v0002", installedAt: "2026-10-07T10:00:00Z" },
    { folderName: "theta_passage.v0002", installedAt: null },
    // On disk, but not in the vault: nothing to show it as.
    { folderName: "my_own_map", installedAt: "2026-10-08T10:00:00Z" },
  ];

  it("lists the downloaded maps, the one downloaded last first", () => {
    const query: MapVaultQuery = { ...EMPTY_MAP_QUERY, recommended: true };
    expect(mapsByDownload(vault, installed, query).map((m) => m.displayName))
      .toEqual(["Dual Gap", "Seton's Clutch", "Theta Passage"]);
  });

  it("still applies the search", () => {
    const query: MapVaultQuery = { ...EMPTY_MAP_QUERY, search: "seton*" };
    expect(mapsByDownload(vault, installed, query).map((m) => m.displayName)).toEqual(["Seton's Clutch"]);
  });
});
