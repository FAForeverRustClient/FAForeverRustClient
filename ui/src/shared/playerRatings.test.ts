import { describe, expect, it } from "vitest";
import type { PlayerProfile } from "../ipc/bindings";
import { averageRating, displayedRating, gameLeaderboard } from "./playerRatings";

const rating = (leaderboard: string, value: number) => ({
  leaderboard,
  rating: value,
  mean: value + 600,
  deviation: 200,
  gamesPlayed: 10,
});

const player = (ratings: PlayerProfile["ratings"], globalRating = 0): PlayerProfile => ({
  id: 1,
  login: "Valkyra",
  globalRating,
  ratings,
  country: "gb",
  clan: "",
  avatarUrl: "",
  avatarTooltip: "",
});

describe("which rating is shown", () => {
  it("reads the leaderboard the game is played on", () => {
    const profile = player([rating("global", 804), rating("ladder_1v1", 466)], 804);
    expect(displayedRating(profile, "ladder_1v1")).toBe(466);
    expect(displayedRating(profile, "global")).toBe(804);
  });

  it("does not answer for a queue with the global rating", () => {
    // The reported bug, in one line: a 1v1 lobby said 804 because that was
    // the only number the client kept. Somebody who has never laddered has no
    // ladder rating, and saying so is the whole point.
    const profile = player([rating("global", 804)], 804);
    expect(displayedRating(profile, "ladder_1v1")).toBeNull();
  });

  it("counts a rating of zero as a rating", () => {
    // A conservative rating is mean - 3 * deviation floored at zero, so a
    // ranked account with a high deviation displays as 0. That is a player
    // with a leaderboard entry and a profile page, not an unknown.
    const profile = player([rating("global", 0)]);
    expect(displayedRating(profile)).toBe(0);
  });

  it("has nothing to say about a player with no entry at all", () => {
    expect(displayedRating(player([]))).toBeNull();
    expect(displayedRating(undefined)).toBeNull();
  });

  it("falls back to the scalar global rating a partial update carries", () => {
    expect(displayedRating(player([], 1_500))).toBe(1_500);
    expect(displayedRating(player([], 1_500), "tmm_2v2")).toBeNull();
  });

  it("treats a game with no rating type as a global one", () => {
    expect(gameLeaderboard("")).toBe("global");
    expect(gameLeaderboard(null)).toBe("global");
    expect(gameLeaderboard("tmm_4v4")).toBe("tmm_4v4");
  });
});

describe("averaging a lineup", () => {
  it("divides by everybody rated, zeroes included", () => {
    // The free-for-all in the report: one player on 242 and three on 0. The
    // panel divided by one and printed 242 beside a game average of 60.
    expect(averageRating([242, 0, 0, 0])).toBe(60);
  });

  it("leaves out only the players with no rating at all", () => {
    expect(averageRating([1_000, null, 500])).toBe(750);
  });

  it("has no average when nobody is rated", () => {
    expect(averageRating([null, null])).toBeNull();
    expect(averageRating([])).toBeNull();
  });
});
