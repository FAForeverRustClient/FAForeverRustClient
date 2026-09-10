import { describe, expect, it } from "vitest";
import type { MatchmakerQueue, PlayerRatingSummary } from "../../ipc/bindings";
import { queuedRatingBands, shareConditionFor } from "./queueExplainer";

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

const rating = (technicalName: string) => ({ technicalName } as PlayerRatingSummary);

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

describe("the share condition a queue plays under", () => {
  it("reads it off the leaderboard name the server chose", () => {
    expect(shareConditionFor(rating("tmm_4v4_full_share"))).toBe("fullShare");
    expect(shareConditionFor(rating("4v4_share_until_death_league"))).toBe("shareUntilDeath");
  });

  it("stays quiet for a name that says nothing about sharing", () => {
    expect(shareConditionFor(rating("ladder_1v1"))).toBeNull();
    expect(shareConditionFor(null)).toBeNull();
  });
});
