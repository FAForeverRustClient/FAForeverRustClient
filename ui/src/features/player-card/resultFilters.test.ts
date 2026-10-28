import { describe, expect, it, vi } from "vitest";
import type { PlayerGameResult } from "../../ipc/bindings";
import { filterResults, NO_RESULT_FILTERS } from "./PlayerResults";

vi.mock("../../ipc/client");

function game(gameId: number, queue: string, rated: boolean): PlayerGameResult {
  return {
    gameId,
    playedAt: "2026-10-26T20:00:00Z",
    queue,
    map: "Seton's Clutch",
    mapFolder: "scmp_009",
    generated: false,
    outcome: "win",
    ratingChangeHundredths: rated ? 1250 : null,
  };
}

const games = [
  game(1, "global", true),
  game(2, "global", false),
  game(3, "tmm_3v3", true),
  game(4, "tmm_4v4_full_share", true),
  game(5, "ladder_1v1", true),
];
const ids = (list: PlayerGameResult[]) => list.map((entry) => entry.gameId);

describe("filtering a player's results (#646)", () => {
  it("keeps everything without a filter", () => {
    expect(ids(filterResults(games, NO_RESULT_FILTERS))).toEqual([1, 2, 3, 4, 5]);
  });

  it("splits rated from unrated by whether the rating moved", () => {
    expect(ids(filterResults(games, { rated: "rated", queues: [] }))).toEqual([1, 3, 4, 5]);
    expect(ids(filterResults(games, { rated: "unrated", queues: [] }))).toEqual([2]);
  });

  it("adds queues together, so 3v3 and 4v4 are one view", () => {
    expect(ids(filterResults(games, { rated: "all", queues: ["tmm_3v3", "tmm_4v4_full_share"] }))).toEqual([3, 4]);
  });

  it("combines the queue with rated or unrated", () => {
    expect(ids(filterResults(games, { rated: "unrated", queues: ["global"] }))).toEqual([2]);
  });
});
