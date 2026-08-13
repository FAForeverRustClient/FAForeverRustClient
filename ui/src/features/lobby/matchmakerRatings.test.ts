import { describe, expect, it } from "vitest";
import type { PlayerRatingSummary } from "../../ipc/bindings";
import { ratingForQueue } from "./matchmakerRatings";

const rating = (technicalName: string, value: number): PlayerRatingSummary => ({
  leaderboardId: value,
  technicalName,
  name: technicalName,
  rating: value,
  mean: value,
  deviation: 0,
  gamesPlayed: 10,
  wonGames: 5,
  updateTime: "",
});

describe("matchmaker queue ratings", () => {
  it("matches lobby and API identifiers despite separators and casing", () => {
    const ratings = [
      rating("ladder_1v1", 1400),
      rating("tmm_2v2", 1500),
      rating("tmm_4v4_full_share", 1600),
    ];
    expect(ratingForQueue(ratings, "Ladder1v1")?.rating).toBe(1400);
    expect(ratingForQueue(ratings, "TMM-2V2")?.rating).toBe(1500);
    expect(ratingForQueue(ratings, "tmm4v4")?.rating).toBe(1600);
  });

  it("does not substitute the unrelated global rating", () => {
    expect(ratingForQueue([rating("global", 1800)], "tmm_4v4_full_share")).toBeNull();
  });
});
