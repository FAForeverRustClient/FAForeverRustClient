import { describe, expect, it } from "vitest";
import { activeLocalReplayPreset, activeReplayPreset } from "./replayPresets";
import { EMPTY_REPLAY_QUERY, isoDaysAgo, ALL_TIME_AFTER } from "../../shared/replayQuery";
import { EMPTY_LOCAL_REPLAY_QUERY } from "./local/localReplayQuery";

describe("activeReplayPreset", () => {
  it("calls an unfiltered query the unrestricted scope", () => {
    expect(activeReplayPreset(EMPTY_REPLAY_QUERY, "wilson_")).toBe("newest");
  });

  it("recognises the account's own replays", () => {
    const query = { ...EMPTY_REPLAY_QUERY, player: "wilson_", exactPlayer: true };
    expect(activeReplayPreset(query, "wilson_")).toBe("own");
  });

  it("ignores case, because a handed-over search need not match the login exactly", () => {
    const query = { ...EMPTY_REPLAY_QUERY, player: "WILSON_", exactPlayer: true };
    expect(activeReplayPreset(query, "wilson_")).toBe("own");
  });

  it("does not call a loose match on your own name your replays", () => {
    // "wilson" loosely would also return wilsonX's games, which is not the
    // scope the button stands for.
    const query = { ...EMPTY_REPLAY_QUERY, player: "wilson_", exactPlayer: false };
    expect(activeReplayPreset(query, "wilson_")).toBe("newest");
  });

  it("is never the account's scope when nobody is signed in", () => {
    expect(activeReplayPreset({ ...EMPTY_REPLAY_QUERY, player: "" }, "")).toBe("newest");
  });

  it("recognises the review floor and the sort together", () => {
    const query = {
      ...EMPTY_REPLAY_QUERY,
      minReviewScore: 4,
      sortBy: "reviewScore" as const,
      sortDescending: true,
    };
    expect(activeReplayPreset(query, "wilson_")).toBe("highestRated");
  });

  it("does not call a bare sort by score the best-reviewed scope", () => {
    const query = { ...EMPTY_REPLAY_QUERY, sortBy: "reviewScore" as const };
    expect(activeReplayPreset(query, "wilson_")).toBe("newest");
  });

  it("prefers your own replays when a query is both", () => {
    const query = {
      ...EMPTY_REPLAY_QUERY,
      player: "wilson_",
      exactPlayer: true,
      minReviewScore: 4,
      sortBy: "reviewScore" as const,
    };
    expect(activeReplayPreset(query, "wilson_")).toBe("own");
  });
});

describe("activeLocalReplayPreset", () => {
  it("calls an unfiltered archive the unrestricted scope", () => {
    expect(activeLocalReplayPreset(EMPTY_LOCAL_REPLAY_QUERY, "wilson_")).toBe("newest");
  });

  it("recognises the account's own replays", () => {
    const query = { ...EMPTY_LOCAL_REPLAY_QUERY, player: "wilson_", exactPlayer: true };
    expect(activeLocalReplayPreset(query, "wilson_")).toBe("own");
  });

  it("recognises a date bound", () => {
    const query = { ...EMPTY_LOCAL_REPLAY_QUERY, after: isoDaysAgo(365) };
    expect(activeLocalReplayPreset(query, "wilson_")).toBe("lastYear");
  });

  it("does not read the all-of-history bound as a date filter", () => {
    const query = { ...EMPTY_LOCAL_REPLAY_QUERY, after: ALL_TIME_AFTER };
    expect(activeLocalReplayPreset(query, "wilson_")).toBe("newest");
  });

  it("lets the player scope win over a date bound", () => {
    const query = {
      ...EMPTY_LOCAL_REPLAY_QUERY,
      player: "wilson_",
      exactPlayer: true,
      after: isoDaysAgo(365),
    };
    expect(activeLocalReplayPreset(query, "wilson_")).toBe("own");
  });
});
