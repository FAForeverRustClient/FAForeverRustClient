import { describe, expect, it } from "vitest";
import type { PlayerProfile } from "../ipc/bindings";
import { displayedRating, gameLeaderboard } from "./playerRatings";

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
