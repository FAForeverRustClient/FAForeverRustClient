import { describe, expect, it } from "vitest";
import type { PlayerGameResult } from "../../ipc/bindings";
import { filterResults, NO_RESULT_FILTERS } from "./resultFilters";

function game(gameId: number, queue: string, rated: boolean, playedAt = "2026-10-26T20:00:00Z"): PlayerGameResult {
  return {
    gameId,
    playedAt,
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
    expect(ids(filterResults(games, { ...NO_RESULT_FILTERS, rated: "rated", queues: [] }))).toEqual([1, 3, 4, 5]);
    expect(ids(filterResults(games, { ...NO_RESULT_FILTERS, rated: "unrated", queues: [] }))).toEqual([2]);
  });

  it("adds queues together, so 3v3 and 4v4 are one view", () => {
    expect(ids(filterResults(games, { ...NO_RESULT_FILTERS, rated: "all", queues: ["tmm_3v3", "tmm_4v4_full_share"] }))).toEqual([3, 4]);
  });

  it("combines the queue with rated or unrated", () => {
    expect(ids(filterResults(games, { ...NO_RESULT_FILTERS, rated: "unrated", queues: ["global"] }))).toEqual([2]);
  });

  describe("by date", () => {
    // Local noon, so the day is the same in every time zone the tests run in.
    const noon = (day: string) => new Date(`${day}T12:00:00`).toISOString();
    const dated = [
      game(10, "global", true, noon("2026-01-10")),
      game(11, "global", true, noon("2026-02-15")),
      game(12, "global", true, noon("2026-03-20")),
      game(13, "global", true, ""),
    ];

    it("keeps every game since the from day, that day included", () => {
      expect(ids(filterResults(dated, { ...NO_RESULT_FILTERS, from: "2026-02-15" }))).toEqual([11, 12]);
    });

    it("keeps every game up to the to day, that day included", () => {
      expect(ids(filterResults(dated, { ...NO_RESULT_FILTERS, to: "2026-02-15" }))).toEqual([10, 11]);
    });

    it("keeps the games between both days", () => {
      expect(ids(filterResults(dated, { ...NO_RESULT_FILTERS, from: "2026-02-01", to: "2026-03-01" }))).toEqual([11]);
    });

    it("leaves out a game with no start time once a date is set", () => {
      expect(ids(filterResults(dated, NO_RESULT_FILTERS))).toEqual([10, 11, 12, 13]);
      expect(ids(filterResults(dated, { ...NO_RESULT_FILTERS, from: "2026-01-01" }))).toEqual([10, 11, 12]);
    });
  });
});
