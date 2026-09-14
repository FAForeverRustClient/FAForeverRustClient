import { describe, expect, it } from "vitest";
import type { PlayerProfile } from "../../ipc/bindings";
import { orderedRatings } from "./ratingRows";

const profile: PlayerProfile = {
  id: 7,
  login: "Unknown",
  globalRating: 1_200,
  ratings: [
    { leaderboard: "tmm_2v2", rating: 980, mean: 1_580, deviation: 200, gamesPlayed: 20 },
    { leaderboard: "global", rating: 1_200, mean: 1_800, deviation: 200, gamesPlayed: 374 },
    { leaderboard: "ladder_1v1", rating: 1_050, mean: 1_650, deviation: 200, gamesPlayed: 0 },
  ],
  country: "fr",
  clan: "dp",
  avatarUrl: "",
  avatarTooltip: "",
};

describe("orderedRatings", () => {
  it("puts the familiar queues first, whatever order they arrived in", () => {
    expect(orderedRatings(profile).map((rating) => rating.leaderboard))
      .toEqual(["global", "ladder_1v1", "tmm_2v2"]);
  });

  it("falls back to the legacy global estimate when no table arrived", () => {
    expect(orderedRatings({ ...profile, ratings: [] }))
      .toEqual([{ leaderboard: "global", rating: 1_200, mean: 0, deviation: 0, gamesPlayed: 0 }]);
  });

  it("treats a zero global as the absent value it is, not as a rating", () => {
    // Zero is the scalar's "not supplied" sentinel as well as a rating somebody
    // could hold, so a profile with neither cannot invent one.
    expect(orderedRatings({ ...profile, ratings: [], globalRating: 0 })).toEqual([]);
  });
});
