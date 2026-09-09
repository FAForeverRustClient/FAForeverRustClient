import { describe, expect, it } from "vitest";
import type { Game } from "../../ipc/bindings";
import { friendsInGame } from "./friendPresence";

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: 1,
    title: "Come play",
    host: "Sheeo",
    players: 3,
    maxPlayers: 8,
    map: "Setons Clutch",
    modName: "faf",
    averageRating: 1200,
    passwordProtected: false,
    visibility: "public",
    gameType: "custom",
    launchedAt: null,
    hostedAt: null,
    ratingMin: null,
    ratingMax: null,
    teams: { "1": ["Sheeo", "Nuggets"], "2": ["wlsn", "Stranger"] },
    simMods: {},
    ...overrides,
  };
}

describe("friendsInGame", () => {
  it("finds a friend who joined somebody else's lobby", () => {
    expect(friendsInGame(game(), ["wlsn"])).toEqual(["wlsn"]);
  });

  it("puts the host first, whatever team order says", () => {
    expect(friendsInGame(game(), ["wlsn", "Sheeo"])).toEqual(["Sheeo", "wlsn"]);
  });

  it("matches a login whose case does not agree between the two lists", () => {
    expect(friendsInGame(game(), ["NUGGETS"])).toEqual(["Nuggets"]);
  });

  it("names a host who is also on a team once", () => {
    expect(friendsInGame(game(), ["Sheeo"])).toEqual(["Sheeo"]);
  });

  it("says nothing about a lobby full of strangers", () => {
    expect(friendsInGame(game(), ["Someone"])).toEqual([]);
    expect(friendsInGame(game(), [])).toEqual([]);
  });

  it("reads an observer team like any other", () => {
    const observed = game({ teams: { "-1": ["wlsn"] } });
    expect(friendsInGame(observed, ["wlsn"])).toEqual(["wlsn"]);
  });
});
