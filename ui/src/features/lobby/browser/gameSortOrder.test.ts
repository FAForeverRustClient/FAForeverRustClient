import { describe, expect, it } from "vitest";

import type { Game } from "../../../ipc/bindings";
import { compareGames, compareNaturally, sortsDescending } from "./gameSortOrder";

function game(fields: Partial<Game>): Game {
  return {
    id: 1,
    title: "",
    host: "",
    players: 0,
    maxPlayers: 8,
    map: "",
    modName: "faf",
    averageRating: 0,
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
    ...fields,
  };
}

const order = (sort: Parameters<typeof compareGames>[0], reversed: boolean, games: Game[]) =>
  games.slice().sort((left, right) => compareGames(sort, reversed, left, right)).map((g) => g.id);

describe("the game list's natural order", () => {
  it("puts the fullest lobby first", () => {
    const games = [game({ id: 1, players: 2 }), game({ id: 2, players: 7 })];
    expect(order("players", false, games)).toEqual([2, 1]);
  });

  it("puts the newest lobby first, which is the smallest age", () => {
    const games = [
      game({ id: 1, hostedAt: "2026-09-13T10:00:00Z" }),
      game({ id: 2, hostedAt: "2026-09-13T11:00:00Z" }),
    ];
    expect(order("age", false, games)).toEqual([2, 1]);
  });

  it("reads maps and titles from A to Z", () => {
    const maps = [game({ id: 1, map: "Setons" }), game({ id: 2, map: "Astro" })];
    expect(order("map", false, maps)).toEqual([2, 1]);
    const titles = [game({ id: 1, title: "zerg rush" }), game({ id: 2, title: "1400+" })];
    expect(order("title", false, titles)).toEqual([2, 1]);
  });
});

describe("reversing it", () => {
  it("turns every column around, whichever way its own order runs", () => {
    const games = [game({ id: 1, players: 2 }), game({ id: 2, players: 7 })];
    expect(order("players", true, games)).toEqual([1, 2]);
    const maps = [game({ id: 1, map: "Setons" }), game({ id: 2, map: "Astro" })];
    expect(order("map", true, maps)).toEqual([1, 2]);
  });

  it("is exactly the natural comparison negated", () => {
    const left = game({ id: 1, averageRating: 1200 });
    const right = game({ id: 2, averageRating: 1900 });
    expect(compareGames("rating", true, left, right)).toBe(-compareNaturally("rating", left, right));
  });
});

describe("what the header's arrow claims", () => {
  it("points down for the columns that count down, and up once reversed", () => {
    expect(sortsDescending("players", false)).toBe(true);
    expect(sortsDescending("rating", false)).toBe(true);
    expect(sortsDescending("players", true)).toBe(false);
  });

  it("points up for the columns that read A to Z, and for the newest-first age", () => {
    expect(sortsDescending("map", false)).toBe(false);
    expect(sortsDescending("title", false)).toBe(false);
    expect(sortsDescending("age", false)).toBe(false);
    expect(sortsDescending("age", true)).toBe(true);
  });
});
