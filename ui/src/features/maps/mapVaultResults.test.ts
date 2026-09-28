import { describe, expect, it } from "vitest";
import type { VaultMap } from "../../ipc/bindings";
import { visibleVaultMaps } from "./mapVaultResults";

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
