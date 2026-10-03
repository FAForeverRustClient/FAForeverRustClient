import { describe, expect, it } from "vitest";
import type { Game, VaultMap, VaultMod } from "../ipc/bindings";
import {
  isCoopGame,
  isCustomGameRanked,
  isFreeForAll,
  isMultiTeam,
  showsUnrankedTag,
  simModsKeepGameRanked,
} from "./gameRules";

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
    ratingType: "global",
    passwordProtected: false,
    visibility: "public",
    gameType: "custom",
    launchedAt: null,
    hostedAt: null,
    ratingMin: null,
    ratingMax: null,
    enforceRatingRange: false,
    teams: {},
    simMods: {},
    ...overrides,
  };
}

const rankedMap = { folderName: "scmp_009", displayName: "Seton's Clutch", ranked: true } as VaultMap;
const unrankedMap = { folderName: "scmp_009", displayName: "Seton's Clutch", ranked: false } as VaultMap;
const noMods: VaultMod[] = [];

describe("a free-for-all", () => {
  it("is three or more players with one of them on no team, as the server rules", () => {
    const ffa = game({ teams: { "1": ["A", "B", "C"] } });
    expect(isFreeForAll(ffa)).toBe(true);
    expect(showsUnrankedTag(ffa, [rankedMap], noMods)).toBe(true);
    // One player left on no team among teams still makes it one.
    expect(isFreeForAll(game({ teams: { "1": ["A"], "2": ["B"], "3": ["C"] } }))).toBe(true);
  });

  it("is not a 1v1, a game in teams, or a lobby of observers", () => {
    expect(isFreeForAll(game({ teams: { "1": ["A", "B"] } }))).toBe(false);
    expect(isFreeForAll(game({ teams: { "2": ["A", "B"], "3": ["C", "D"] } }))).toBe(false);
    expect(isFreeForAll(game({ teams: { "1": ["A"], "-1": ["B", "C"] } }))).toBe(false);
  });
});

describe("a game of more than two teams", () => {
  it("is unranked whether or not somebody is still on no team (#368)", () => {
    const fourTeams = game({ map: "scmp_009", teams: { "2": ["A"], "3": ["B"], "4": ["C"], "5": ["D"] } });
    expect(isMultiTeam(fourTeams)).toBe(true);
    expect(showsUnrankedTag(fourTeams, [rankedMap], noMods)).toBe(true);
    const oneUnassigned = game({ map: "scmp_009", teams: { "1": ["A"], "3": ["B"], "4": ["C"], "5": ["D"] } });
    expect(showsUnrankedTag(oneUnassigned, [rankedMap], noMods)).toBe(true);
  });

  it("is not two teams, observers, or a team nobody is on", () => {
    expect(isMultiTeam(game({ teams: { "2": ["A", "B"], "3": ["C", "D"] } }))).toBe(false);
    expect(isMultiTeam(game({ teams: { "2": ["A"], "3": ["B"], "-1": ["C"] } }))).toBe(false);
    expect(isMultiTeam(game({ teams: { "2": ["A"], "3": ["B"], "4": [] } }))).toBe(false);
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

describe("the sim mod tag's colour", () => {
  // Only two of the eighteen fields matter to the function under test, and
  // spelling out the other sixteen would say nothing about the behaviour.
  const rankedMod = { uid: "AAA", ranked: true } as unknown as VaultMod;
  const unrankedMod = { uid: "BBB", ranked: false } as unknown as VaultMod;

  it("is the ranked colour when every sim mod is ranked", () => {
    const modded = game({ simMods: { AAA: "Ranked mod" } });
    expect(simModsKeepGameRanked(modded, [rankedMod, unrankedMod])).toBe(true);
  });

  it("matches uids case-insensitively, the way the lobby sends them", () => {
    const modded = game({ simMods: { aaa: "Ranked mod" } });
    expect(simModsKeepGameRanked(modded, [rankedMod])).toBe(true);
  });

  it("is the warning colour as soon as one sim mod is not ranked", () => {
    const modded = game({ simMods: { AAA: "Ranked mod", BBB: "Slop" } });
    expect(simModsKeepGameRanked(modded, [rankedMod, unrankedMod])).toBe(false);
  });

  it("treats a mod the vault has never heard of as unranked", () => {
    const modded = game({ simMods: { ZZZ: "Who knows" } });
    expect(simModsKeepGameRanked(modded, [rankedMod])).toBe(false);
  });

  it("says false for a game with no sim mods, which never draws the tag", () => {
    expect(simModsKeepGameRanked(game(), [rankedMod])).toBe(false);
  });

  it("is independent of what the map or the game type do to the rating", () => {
    // A co-op mission is unrated whatever it loads, and an unranked map takes
    // the rating on its own. Neither is the mods' doing, so neither changes
    // what this tag says.
    const coopWithRankedMods = game({ modName: "coop", map: "scmp_009", simMods: { AAA: "Ranked mod" } });
    expect(showsUnrankedTag(coopWithRankedMods, [unrankedMap], [rankedMod])).toBe(false);
    expect(simModsKeepGameRanked(coopWithRankedMods, [rankedMod])).toBe(true);
  });
});

// The live replay list asks the same question of a running game (issue 357):
// three things a client can see, and lobby settings are not among them.
describe("whether a running game will rate anybody", () => {
  const rankedMod = { uid: "AAA", ranked: true } as unknown as VaultMod;
  const unrankedMod = { uid: "BBB", ranked: false } as unknown as VaultMod;

  it("says yes for a game in teams, on a ranked map, with ranked mods", () => {
    const playing = game({ map: "scmp_009", teams: { "2": ["A", "B"], "3": ["C", "D"] }, simMods: { AAA: "Ranked mod" } });
    expect(isCustomGameRanked(playing, [rankedMap], [rankedMod])).toBe(true);
  });

  it("says no to an unranked map, an unranked sim mod, a free-for-all and co-op", () => {
    const teams = { "2": ["A", "B"], "3": ["C", "D"] };
    expect(isCustomGameRanked(game({ map: "scmp_009", teams }), [unrankedMap], [])).toBe(false);
    expect(isCustomGameRanked(game({ map: "scmp_009", teams, simMods: { BBB: "Slop" } }), [rankedMap], [unrankedMod])).toBe(false);
    expect(isCustomGameRanked(game({ map: "scmp_009", teams: { "1": ["A", "B", "C"] } }), [rankedMap], [])).toBe(false);
    expect(isCustomGameRanked(game({ map: "scmp_009", modName: "coop", teams }), [rankedMap], [])).toBe(false);
  });

  it("says yes for a map the vault has not loaded yet, rather than hiding it", () => {
    // The catalogues arrive after the first live snapshot does. An empty
    // vault meaning "unranked" would empty the list for a second and then
    // fill it, which reads as a flicker rather than as a filter.
    const playing = game({ map: "scmp_009", teams: { "2": ["A", "B"], "3": ["C", "D"] } });
    expect(isCustomGameRanked(playing, [], [])).toBe(true);
  });
});
