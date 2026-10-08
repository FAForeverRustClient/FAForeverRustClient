import { describe, expect, it } from "vitest";
import type { PlayerLeaguePlacement, PlayerRatingSummary } from "../../../ipc/bindings";
import { placementForQueue, ratingForQueue } from "./matchmakerRatings";

const placement = (technicalName: string, division: string, score: number): PlayerLeaguePlacement => ({
  technicalName,
  seasonNumber: 12,
  division,
  subdivision: "II",
  score,
  highestScore: score + 100,
  gamesPlayed: 20,
  imageUrl: "",
});

const rating = (technicalName: string, value: number): PlayerRatingSummary => ({
  leaderboardId: value,
  technicalName,
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
    placement("ladder_1v1", "diamond", 1773),
    placement("tmm_2v2", "platinum", 1484),
    placement("tmm_4v4_full_share", "gold", 1379),
  ];

  it("matches a queue to its leaderboard however either is spelled", () => {
    expect(placementForQueue(placements, "Ladder1v1")?.division).toBe("diamond");
    expect(placementForQueue(placements, "TMM-2V2")?.division).toBe("platinum");
  });

  it("resolves the short 4v4 queue name the lobby still sends", () => {
    expect(placementForQueue(placements, "tmm4v4")?.division).toBe("gold");
  });

  it("is null for a queue the player has no placement in", () => {
    expect(placementForQueue(placements, "tmm_3v3")).toBeNull();
    expect(placementForQueue([], "ladder_1v1")).toBeNull();
  });
});

describe("the queue rating after a game (#449)", () => {
  it("takes the lobby's refreshed numbers over the profile read at the start", () => {
    const live = [{ leaderboard: "ladder_1v1", rating: 1943, mean: 2140, deviation: 65, gamesPlayed: 1451 }];
    const merged = ratingForQueue([rating("ladder_1v1", 1912)], "ladder1v1", live);
    expect(merged?.rating).toBe(1943);
    expect(merged?.mean).toBe(2140);
    expect(merged?.wonGames).toBe(5);
  });

  it("keeps the profile's numbers when the lobby has no such board", () => {
    expect(ratingForQueue([rating("ladder_1v1", 1912)], "ladder1v1", [])?.rating).toBe(1912);
  });
});
