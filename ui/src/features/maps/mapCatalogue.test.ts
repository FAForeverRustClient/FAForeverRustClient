import { describe, expect, it } from "vitest";
import type { MapSummary, VaultMap } from "../../ipc/bindings";
import { mapDownloadUrl, mapThumbnailUrl } from "../../shared/mapCatalogue";
import { findVaultMap, mapPresentation, mapThumbnailCandidates } from "../../shared/mapPresentation";
import { buildHostCatalogue, buildVaultIndex } from "../lobby/host/hostMapCatalogue";
import { EMPTY_MAP_QUERY } from "../../shared/vaultQuery";
import { mapsMatchingQuery } from "./mapVaultResults";

const compact: MapSummary = {
  mapId: 1, versionId: 2, displayName: "A map", author: "Uploader", authorId: 3,
  folderName: "map (one), [two] & café.v0002", version: "2", description: "Searchable description",
  mapType: "skirmish", maxPlayers: 8, width: 512, height: 1024, gamesPlayed: 100,
  versionGamesPlayed: 12, ranked: true, hidden: false, recommended: true, ratingTenths: 45,
  reviews: 10, createdAt: "2026-01-02T00:00:00Z",
};

describe("compact map catalogue", () => {
  it("reconstructs the API's exact raw-folder URLs without encoding or normalizing them", () => {
    expect(mapDownloadUrl(compact)).toBe(`https://content.faforever.com/maps/${compact.folderName}.zip`);
    expect(mapThumbnailUrl(compact)).toBe(`https://content.faforever.com/maps/previews/small/${compact.folderName}.png`);
    expect(mapThumbnailUrl(compact, true)).toBe(`https://content.faforever.com/maps/previews/large/${compact.folderName}.png`);
  });

  it("preserves empty and nonstandard URLs and keeps full search results working", () => {
    const exceptional: MapSummary = { ...compact, urls: { thumbnailUrl: "", thumbnailUrlLarge: "https://other.invalid/art", downloadUrl: "https://other.invalid/archive" } };
    expect(mapThumbnailUrl(exceptional)).toBe("");
    expect(mapThumbnailUrl(exceptional, true)).toBe("https://other.invalid/art");
    expect(mapDownloadUrl(exceptional)).toBe("https://other.invalid/archive");
    const full: VaultMap = { ...compact, thumbnailUrl: "small", thumbnailUrlLarge: "large", downloadUrl: "download" };
    expect(mapThumbnailUrl(full)).toBe("small");
    expect(mapThumbnailUrl(full, true)).toBe("large");
    expect(mapDownloadUrl(full)).toBe("download");
    expect(mapThumbnailUrl({ folderName: "installed" })).toBe("");
  });

  it("keeps shared lobby, replay, notification and enlarged preview lookup behavior", () => {
    const vault = [compact];
    expect(findVaultMap(vault, compact.folderName)).toBe(compact);
    expect(mapPresentation(vault, compact.folderName).displayName).toBe("A map");
    expect(mapPresentation(vault, compact.folderName).thumbnailUrl).toBe(mapThumbnailUrl(compact));
    expect(mapThumbnailCandidates(vault, compact.folderName, true)[0]).toBe(mapThumbnailUrl(compact, true));
  });

  it("keeps host metadata and descriptions available without a detail request", () => {
    const catalogue = buildHostCatalogue([{ folderName: compact.folderName, displayName: "Fallback", maxPlayers: 0, width: 0, height: 0, version: null, description: null, installedAt: null, mapType: null }], buildVaultIndex([compact]), "Official");
    const map = catalogue.get(compact.folderName.toLowerCase());
    expect(map?.description).toBe(compact.description);
    expect(map?.displayName).toBe(compact.displayName);
    expect(map?.ranked).toBe(true);
    expect(map?.width).toBe(512);
  });

  it("retains dates and ratings needed by local favourite filters", () => {
    const query = { ...EMPTY_MAP_QUERY, search: "A map", author: "Uploader", authorId: 3, ranked: true, recommended: true, includeHidden: false, minRatingTenths: 40, maxRatingTenths: 50, minPlayers: 8, maxPlayers: 8, width: 512, height: 1024, after: "2026-01-01", before: "2026-01-03", sortBy: "newest" as const, sortDescending: true, page: 1, pageSize: 20 };
    expect(mapsMatchingQuery([compact], query)).toEqual([compact]);
  });
});
