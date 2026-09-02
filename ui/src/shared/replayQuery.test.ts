import { describe, expect, it } from "vitest";
import {
  advancedReplayFilterCount,
  ALL_TIME_AFTER,
  EMPTY_REPLAY_QUERY,
  isRecentBound,
  isoDaysAgo,
  personalReplayQuery,
} from "./replayQuery";

describe("advancedReplayFilterCount", () => {
  it("counts logical hidden filters without double-counting ranges", () => {
    expect(advancedReplayFilterCount(EMPTY_REPLAY_QUERY)).toBe(0);
    expect(advancedReplayFilterCount({
      ...EMPTY_REPLAY_QUERY,
      host: "TestPlayer",
      replayId: "27437947",
      minRating: 1000,
      maxRating: 2000,
      after: "2026-01-01",
      before: "2026-08-11",
    })).toBe(2);
  });

  it("does not count the leaderboard filter because it is always visible", () => {
    expect(advancedReplayFilterCount({
      ...EMPTY_REPLAY_QUERY,
      leaderboards: ["1v1"],
    })).toBe(0);
  });
});

describe("personalReplayQuery", () => {
  it("starts with the signed-in player's newest replays", () => {
    expect(personalReplayQuery("TestPlayer", "2023-08-18")).toEqual({
      ...EMPTY_REPLAY_QUERY,
      player: "TestPlayer",
      exactPlayer: true,
      after: "2023-08-18",
    });
  });

  it("falls back to the public feed when no account is available", () => {
    expect(personalReplayQuery("", "2023-08-18")).toEqual(EMPTY_REPLAY_QUERY);
  });
});

describe("the date floor toggle", () => {
  it("gives the landing query a visible bound instead of the backend's hidden one", () => {
    const query = personalReplayQuery("TestPlayer", isoDaysAgo(365));
    // Non-empty `after` is what suppresses `ReplayQuery::fallback_months`, so
    // the six-month floor no longer applies behind the user's back.
    expect(query.after).not.toBe("");
  });

  it("expresses all-time as a bound older than any replay, not as no bound", () => {
    // An empty `after` would hand the decision back to the backend floor, which
    // is the opposite of what turning the toggle off means.
    expect(ALL_TIME_AFTER).not.toBe("");
    expect(Number(ALL_TIME_AFTER.slice(0, 4))).toBeLessThan(2011);
  });

  it("only lights up for a bound that actually limits the search", () => {
    expect(isRecentBound(isoDaysAgo(365))).toBe(true);
    expect(isRecentBound(ALL_TIME_AFTER)).toBe(false);
    // The regression: "All replays" clears `after`, and the toggle used to
    // read that as "recent" and highlight itself while searching all history.
    expect(isRecentBound(EMPTY_REPLAY_QUERY.after)).toBe(false);
  });
});
