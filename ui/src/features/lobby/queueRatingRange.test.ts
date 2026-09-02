import { describe, expect, it } from "vitest";
import type { MatchmakerQueue, PlayerRatingSummary } from "../../ipc/bindings";
import { playersInRatingRange } from "./queueRatingRange";

function queue(overrides: Partial<MatchmakerQueue> = {}): MatchmakerQueue {
  return {
    queueName: "ladder1v1",
    teamSize: 1,
    numPlayers: 3,
    queuePopTimeSeconds: 60,
    boundary80s: [
      { min: 800, max: 1200 },
      { min: 1100, max: 1500 },
      { min: 1600, max: 2000 },
    ],
    boundary75s: [
      { min: 700, max: 1300 },
      { min: 1000, max: 1600 },
      { min: 1500, max: 2100 },
    ],
    ...overrides,
  };
}

function rating(mean: number | null, deviation: number | null): PlayerRatingSummary {
  return {
    leaderboardId: 1,
    technicalName: "ladder_1v1",
    name: "1v1",
    rating: (mean ?? 0) - 3 * (deviation ?? 0),
    mean,
    deviation,
    gamesPlayed: 100,
    wonGames: 50,
    updateTime: "",
  };
}

describe("players in your rating range", () => {
  it("counts the windows that contain your rating", () => {
    // 1150 sits inside both of the first two 80% windows, not the third.
    expect(playersInRatingRange(queue(), rating(1150, 60), 0)).toBe(2);
  });

  it("uses the wider windows when the rating is less certain", () => {
    // 1050: one 80% window contains it, but two of the 75% ones do.
    expect(playersInRatingRange(queue(), rating(1050, 60), 0)).toBe(1);
    expect(playersInRatingRange(queue(), rating(1050, 150), 0)).toBe(2);
  });

  it("does not count your own search", () => {
    expect(playersInRatingRange(queue(), rating(1150, 60), 1)).toBe(1);
    // And never goes negative, however the server counted.
    expect(playersInRatingRange(queue(), rating(1150, 60), 5)).toBe(0);
  });

  it("says nothing when the server is unsure of your rating", () => {
    // The reference client stops here rather than showing a number built on a
    // rating the server does not yet believe.
    expect(playersInRatingRange(queue(), rating(1150, 201), 0)).toBeNull();
  });

  it("says nothing without a rating for the queue at all", () => {
    expect(playersInRatingRange(queue(), null, 0)).toBeNull();
    expect(playersInRatingRange(queue(), rating(null, null), 0)).toBeNull();
  });

  it("says nothing when the queue published no windows", () => {
    // Distinct from a real zero: an older server, or a queue nobody is in.
    const empty = queue({ boundary80s: [], boundary75s: [] });
    expect(playersInRatingRange(empty, rating(1150, 60), 0)).toBeNull();
  });

  it("is a real zero when everybody waiting is out of reach", () => {
    expect(playersInRatingRange(queue(), rating(2500, 60), 0)).toBe(0);
  });
});
