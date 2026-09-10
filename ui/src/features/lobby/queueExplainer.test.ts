import { describe, expect, it } from "vitest";
import type { MatchmakerQueue } from "../../ipc/bindings";
import { playersPerMatch, queuedRatingBands } from "./queueExplainer";

function queue(overrides: Partial<MatchmakerQueue> = {}): MatchmakerQueue {
  return {
    queueName: "tmm4v4",
    teamSize: 4,
    numPlayers: 0,
    queuePopTimeSeconds: 60,
    boundary80s: [],
    boundary75s: [],
    ...overrides,
  };
}

describe("the rating bands a queue is searching with", () => {
  it("reports the tightest and the widest, in points of width", () => {
    // A width, not two endpoints: the server draws these around the TrueSkill
    // mean while the client shows mean - 3*deviation everywhere, and only the
    // width survives that difference unchanged.
    const bands = queuedRatingBands(queue({
      boundary75s: [{ min: 1000, max: 1400 }, { min: 900, max: 1900 }],
    }));
    expect(bands).toEqual({ narrowest: 400, widest: 1000, searches: 2 });
  });

  it("prefers the wider set, which is the one that says how far apart we could be", () => {
    const bands = queuedRatingBands(queue({
      boundary80s: [{ min: 1000, max: 1200 }],
      boundary75s: [{ min: 900, max: 1500 }],
    }));
    expect(bands?.widest).toBe(600);
  });

  it("falls back to the tighter set when a queue carries only that one", () => {
    const bands = queuedRatingBands(queue({ boundary80s: [{ min: 1000, max: 1200 }] }));
    expect(bands?.widest).toBe(200);
  });

  it("says nothing rather than zero when the server published no windows", () => {
    // An empty queue and a queue the server said nothing about are different
    // facts, and only one of them is worth printing a number for.
    expect(queuedRatingBands(queue())).toBeNull();
  });
});

describe("how many players a queue needs", () => {
  it("is twice the team size", () => {
    // Half the answer to "eight people are queued for 3v3, why is nothing
    // happening": six of the eight would be a game, and eight is two short of
    // two games. The other half is whether those six split evenly, which no
    // count can show.
    expect(playersPerMatch(queue({ teamSize: 1 }))).toBe(2);
    expect(playersPerMatch(queue({ teamSize: 3 }))).toBe(6);
    expect(playersPerMatch(queue({ teamSize: 4 }))).toBe(8);
  });
});
