import { describe, expect, it } from "vitest";
import type { MatchmakerQueue, PlayerRatingSummary } from "../../../ipc/bindings";
import { matchReach, playersInRatingRange, queueRatingBuckets } from "./queueRatingRange";

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
  it("counts the 1v1 searches the server would match with you after waiting", () => {
    // Searches at 1000, 1300 and 1800. From 1150 with a deviation of 60 the
    // reach is about 387 after waiting: the first two, not the third.
    expect(playersInRatingRange(queue(), rating(1150, 60), 0)).toBe(2);
  });

  it("reaches further than the published window, the way the server does", () => {
    // The report behind this (#303): 1300 is 250 away from 1050, outside the
    // ±200 window the server publishes, and within what it actually matches
    // after a few failed pops.
    expect(playersInRatingRange(queue(), rating(1050, 60), 0)).toBe(2);
  });

  it("keeps the published windows for team queues", () => {
    // The team matchmaker weighs team balance and ignores these ranges, so
    // there is no rule to replicate: the windows are all there is.
    const team = queue({ teamSize: 2, queueName: "tmm2v2" });
    expect(playersInRatingRange(team, rating(1050, 60), 0)).toBe(1);
    expect(playersInRatingRange(team, rating(1050, 150), 0)).toBe(2);
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

describe("the queue breakdown by rating", () => {
  it("groups searches by the middle of their window", () => {
    // Middles of 1000, 1300 and 1800: the 800 band, the 1200 band, the 1600.
    expect(queueRatingBuckets(queue())).toEqual([
      { min: 800, max: 1200, count: 1, inRange: 0, mine: false },
      { min: 1200, max: 1600, count: 1, inRange: 0, mine: false },
      { min: 1600, max: 2000, count: 1, inRange: 0, mine: false },
    ]);
  });

  it("counts several searches into the same band", () => {
    const crowded = queue({
      boundary80s: [
        { min: 900, max: 1100 },
        { min: 800, max: 1200 },
        { min: 950, max: 1050 },
      ],
    });
    expect(queueRatingBuckets(crowded)).toEqual([
      { min: 800, max: 1200, count: 3, inRange: 0, mine: false },
    ]);
  });

  it("leaves out the bands nobody is waiting in", () => {
    const sparse = queue({ boundary80s: [{ min: 1900, max: 2100 }] });
    expect(queueRatingBuckets(sparse)).toEqual([
      { min: 2000, max: 2400, count: 1, inRange: 0, mine: false },
    ]);
  });

  it("falls back to the wider windows when the narrow ones are absent", () => {
    const wide = queue({ boundary80s: [] });
    expect(queueRatingBuckets(wide).map((bucket) => bucket.min)).toEqual([800, 1200, 1600]);
  });

  it("says nothing about an empty queue", () => {
    expect(queueRatingBuckets(queue({ boundary80s: [], boundary75s: [] }))).toEqual([]);
  });

  it("says which of a band would take you, and which band you are in", () => {
    // The report: a band with somebody in it, a rating that looks like it
    // belongs there, and 0 in range underneath.
    const buckets = queueRatingBuckets(queue(), rating(1150, 60), 0);
    expect(buckets).toEqual([
      { min: 800, max: 1200, count: 1, inRange: 1, mine: true },
      { min: 1200, max: 1600, count: 1, inRange: 1, mine: false },
      { min: 1600, max: 2000, count: 1, inRange: 0, mine: false },
    ]);
  });

  it("adds up to the number on the card", () => {
    for (const [mean, deviation] of [
      [1150, 60],
      [1050, 150],
      [2500, 60],
    ]) {
      const summary = rating(mean, deviation);
      const total = queueRatingBuckets(queue(), summary, 1)
        .map((bucket) => bucket.inRange)
        .reduce((sum, value) => sum + value, 0);
      expect(total).toBe(playersInRatingRange(queue(), summary, 1));
    }
  });

  it("claims nothing about a rating the server is unsure of", () => {
    const buckets = queueRatingBuckets(queue(), rating(1150, 201), 0);
    expect(buckets.every((bucket) => bucket.inRange === 0 && !bucket.mine)).toBe(true);
    // And the same windows as with no rating at all, so the list itself holds
    // still when the deviation crosses the line.
    expect(buckets.map((bucket) => bucket.min)).toEqual(
      queueRatingBuckets(queue()).map((bucket) => bucket.min),
    );
  });
});

describe("the 1v1 reach", () => {
  it("follows the server's quality rule", () => {
    // beta 240, deviation 60: about 234 at once, 387 after the threshold has
    // dropped by its full 0.25.
    expect(Math.round(matchReach(60, 0))).toBe(234);
    expect(Math.round(matchReach(60, 0.25))).toBe(387);
  });

  it("widens with the deviation", () => {
    expect(matchReach(150, 0.25)).toBeGreaterThan(matchReach(60, 0.25));
  });
});
