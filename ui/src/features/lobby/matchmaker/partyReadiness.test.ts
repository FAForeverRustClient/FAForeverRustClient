import { describe, expect, it } from "vitest";
import type { Game } from "../../../ipc/bindings";
import { playersInGames } from "./partyReadiness";

function game(overrides: Partial<Game>): Game {
  return {
    id: 1,
    title: "glen-luke Vs freerating4you",
    host: "glen-luke",
    players: 2,
    maxPlayers: 2,
    map: "scmp_009",
    modName: "faf",
    averageRating: 900,
    ratingType: "ladder_1v1",
    passwordProtected: false,
    visibility: "public",
    gameType: "matchmaker",
    launchedAt: null,
    hostedAt: null,
    ratingMin: null,
    ratingMax: null,
    enforceRatingRange: false,
    teams: { "2": ["glen-luke"], "3": ["freerating4you"] },
    simMods: {},
    ...overrides,
  };
}

describe("who is in a game before a search (#443)", () => {
  it("does not count the automatic lobby of a match that never launched", () => {
    expect(playersInGames([game({})], []).has("freerating4you")).toBe(false);
  });

  it("counts a launched matchmaker game and a custom lobby somebody joined", () => {
    expect(playersInGames([], [game({ launchedAt: "2026-10-05T21:00:00Z" })]).has("freerating4you")).toBe(true);
    expect(playersInGames([game({ gameType: "custom" })], []).has("freerating4you")).toBe(true);
  });
});
