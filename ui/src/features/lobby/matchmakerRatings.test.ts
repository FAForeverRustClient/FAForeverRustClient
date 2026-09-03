import { describe, expect, it } from "vitest";
import type { PlayerLeaguePlacement, PlayerRatingSummary } from "../../ipc/bindings";
import { placementForQueue, ratingForQueue } from "./matchmakerRatings";

const placement = (technicalName: string, division: string, score: number): PlayerLeaguePlacement => ({
  technicalName,
  leaderboard: technicalName,
  season: "Season 12",
  division,
  score,
  highestScore: score + 100,
  gamesPlayed: 20,
  imageUrl: "",
});

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

describe("placementForQueue", () => {
  const placements = [
    placement("ladder_1v1", "Diamond II", 1773),
    placement("tmm_2v2", "Platinum I", 1484),
    placement("tmm_4v4_full_share", "Gold III", 1379),
  ];

  it("matches a queue to its leaderboard however either is spelled", () => {
    expect(placementForQueue(placements, "Ladder1v1")?.division).toBe("Diamond II");
    expect(placementForQueue(placements, "TMM-2V2")?.division).toBe("Platinum I");
  });

  it("resolves the short 4v4 queue name the lobby still sends", () => {
    expect(placementForQueue(placements, "tmm4v4")?.division).toBe("Gold III");
  });

  it("is null for a queue the player has no placement in", () => {
    expect(placementForQueue(placements, "tmm_3v3")).toBeNull();
    expect(placementForQueue([], "ladder_1v1")).toBeNull();
  });
});
