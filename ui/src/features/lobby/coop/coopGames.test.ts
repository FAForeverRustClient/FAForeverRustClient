import { describe, expect, it } from "vitest";
import type { Game } from "../../../ipc/bindings";
import { coopEmptyReason, isOpenCoopGame, joinableCoopGame } from "./coopGames";

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: 1,
    title: "Operation Black Day",
    host: "Commander",
    players: 1,
    maxPlayers: 4,
    map: "scca_coop_r03.v0021",
    modName: "coop",
    averageRating: 0,
    ratingType: "global",
    passwordProtected: false,
    visibility: "public",
    gameType: "coop",
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

describe("why the co-op list is empty", () => {
  it("says offline before anything about games", () => {
    // Even with games remembered from before the drop: none of them can be
    // joined, and a Host button would not work either.
    expect(coopEmptyReason("disconnected", 3)).toBe("disconnected");
    expect(coopEmptyReason("connecting", 0)).toBe("connecting");
  });

  it("tells nobody playing from a search that hid every game", () => {
    expect(coopEmptyReason("connected", 0)).toBe("none");
    expect(coopEmptyReason("connected", 2)).toBe("filtered");
  });
});

describe("the open co-op games", () => {
  it("count co-op lobbies and leave out matchmaker games and custom ones", () => {
    expect(isOpenCoopGame(game())).toBe(true);
    expect(isOpenCoopGame(game({ gameType: "custom" }))).toBe(true);
    expect(isOpenCoopGame(game({ visibility: "matchmaker" }))).toBe(false);
    expect(isOpenCoopGame(game({ modName: "faf", gameType: "custom" }))).toBe(false);
  });
});

describe("the game Join joins", () => {
  const games = [game({ id: 1 }), game({ id: 2 })];

  it("is the picked game while it is listed", () => {
    expect(joinableCoopGame(games, 2)?.id).toBe(2);
  });

  it("is nothing rather than a stand-in", () => {
    // Nothing picked, or the picked game closed or was filtered away: falling
    // back to the first row would put a different game under the button.
    expect(joinableCoopGame(games, null)).toBeNull();
    expect(joinableCoopGame(games, 9)).toBeNull();
  });
});
