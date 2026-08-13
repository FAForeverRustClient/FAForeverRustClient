import { describe, expect, it } from "vitest";
import { advancedReplayFilterCount, EMPTY_REPLAY_QUERY, personalReplayQuery } from "./replayQuery";

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
    expect(personalReplayQuery("TestPlayer")).toEqual({
      ...EMPTY_REPLAY_QUERY,
      player: "TestPlayer",
      exactPlayer: true,
    });
  });

  it("falls back to the public feed when no account is available", () => {
    expect(personalReplayQuery("")).toEqual(EMPTY_REPLAY_QUERY);
  });
});
