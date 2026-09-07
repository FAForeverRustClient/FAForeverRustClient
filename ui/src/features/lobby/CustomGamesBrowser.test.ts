import { describe, expect, it } from "vitest";
import type { Game, VaultMap, VaultMod } from "../../ipc/bindings";
import {
  hideGlobalLineup,
  isCoopGame,
  setGlobalLineup,
  getActiveLineupSnapshot,
  showsUnrankedTag,
} from "./CustomGamesBrowser";

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: 1,
    title: "Fear No Evil",
    host: "Commander",
    players: 2,
    maxPlayers: 4,
    map: "scca_coop_r03.v0021",
    modName: "faf",
    averageRating: 1200,
    passwordProtected: false,
    visibility: "public",
    gameType: "custom",
    launchedAt: null,
    hostedAt: null,
    ratingMin: null,
    ratingMax: null,
    teams: {},
    simMods: {},
    ...overrides,
  };
}

const rankedMap = { folderName: "scmp_009", displayName: "Seton's Clutch", ranked: true } as VaultMap;
const unrankedMap = { folderName: "scmp_009", displayName: "Seton's Clutch", ranked: false } as VaultMap;
const noMods: VaultMod[] = [];

describe("CustomGamesBrowser global lineup tooltip state", () => {
  it("sets active lineup position for a specific game", () => {
    setGlobalLineup(1001, { left: 100, top: 200 });
    expect(getActiveLineupSnapshot()).toEqual({
      gameId: 1001,
      position: { left: 100, top: 200 },
    });
  });

  it("enforces mutual exclusion: opening game 2 closes game 1", () => {
    setGlobalLineup(1001, { left: 100, top: 200 });
    expect(getActiveLineupSnapshot()?.gameId).toBe(1001);

    setGlobalLineup(1002, { left: 150, top: 250 });
    expect(getActiveLineupSnapshot()?.gameId).toBe(1002);
  });

  it("hides global lineup completely", () => {
    setGlobalLineup(1003, { left: 50, top: 50 });
    expect(getActiveLineupSnapshot()?.gameId).toBe(1003);

    hideGlobalLineup();
    expect(getActiveLineupSnapshot()).toBeNull();
  });
});

describe("the unranked tag", () => {
  it("is not drawn on a co-op mission, however the lobby spelled it", () => {
    // Both spellings, because older servers fill only one of the two.
    for (const coop of [game({ modName: "coop" }), game({ gameType: "coop" })]) {
      expect(isCoopGame(coop)).toBe(true);
      expect(showsUnrankedTag(coop, [unrankedMap], noMods)).toBe(false);
    }
  });

  it("still marks a custom game on an unranked map", () => {
    const custom = game({ map: "scmp_009" });
    expect(isCoopGame(custom)).toBe(false);
    expect(showsUnrankedTag(custom, [unrankedMap], noMods)).toBe(true);
    expect(showsUnrankedTag(custom, [rankedMap], noMods)).toBe(false);
  });
});
