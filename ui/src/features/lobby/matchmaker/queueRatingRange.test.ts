import { describe, expect, it } from "vitest";
import type { MatchmakerQueue, PlayerRatingSummary } from "../../../ipc/bindings";
import { matchReach, playersInRatingRange, queueRatingGraph, RATING_GRAPH_DOMAIN } from "./queueRatingRange";

function queue(overrides: Partial<MatchmakerQueue> = {}): MatchmakerQueue {
  return {
    queueName: "ladder1v1",
    teamSize: 1,
    numPlayers: 3,
    queuePopTimeSeconds: 60,
    queuePopsAt: "",
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

describe("the queue rating density graph", () => {
  it("samples a smooth curve across the 0 to 2400 rating domain", () => {
    const graph = queueRatingGraph(queue());
    expect(graph).not.toBeNull();
    expect(graph?.points[0].rating).toBe(RATING_GRAPH_DOMAIN[0]);
    expect(graph?.points[graph.points.length - 1].rating).toBe(RATING_GRAPH_DOMAIN[1]);
    expect(graph?.points.every((point) => point.value > 0 && point.value <= 1)).toBe(true);
    expect(graph?.marker).toBeNull();
  });

  it("draws a single search as a gentle wave rather than a maxed-out peak", () => {
    const single = queue({ boundary80s: [{ min: 1000, max: 1400 }] });
    const graph = queueRatingGraph(single);
    const maxPoint = Math.max(...(graph?.points.map((point) => point.value) ?? []));
    expect(maxPoint).toBeCloseTo(0.4, 2);
  });

  it("reaches full height where several searches cluster together", () => {
    const crowded = queue({
      boundary80s: [
        { min: 1000, max: 1400 },
        { min: 1050, max: 1350 },
        { min: 1020, max: 1380 },
      ],
    });
    const graph = queueRatingGraph(crowded);
    const at1200 = graph?.points.find((point) => point.rating === 1200)?.value ?? 0;
    const at200 = graph?.points.find((point) => point.rating === 200)?.value ?? 0;
    expect(at1200).toBe(1);
    expect(at200).toBeLessThan(0.1);
  });

  it("falls back to the wider windows when the narrow ones are absent", () => {
    const wide = queue({ boundary80s: [] });
    expect(queueRatingGraph(wide)?.points).toEqual(queueRatingGraph(queue())?.points);
  });

  it("returns null for an empty queue", () => {
    expect(queueRatingGraph(queue({ boundary80s: [], boundary75s: [] }))).toBeNull();
  });

  it("places your marker on the curve when your rating is certain enough", () => {
    const graph = queueRatingGraph(queue(), rating(1150, 60));
    expect(graph?.marker?.rating).toBe(1150);
    expect(graph?.marker?.value).toBeGreaterThan(0.5);
  });

  it("clamps a high-rated marker to the graph domain", () => {
    const graph = queueRatingGraph(queue(), rating(2600, 60));
    expect(graph?.marker?.rating).toBe(RATING_GRAPH_DOMAIN[1]);
  });

  it("omits the marker when the server is unsure of your rating", () => {
    const graph = queueRatingGraph(queue(), rating(1150, 201));
    expect(graph?.marker).toBeNull();
    expect(graph?.points).toEqual(queueRatingGraph(queue())?.points);
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
