import { describe, expect, it } from "vitest";
import type { PlayerProfile } from "../../ipc/bindings";
import { rosterRatingSummary } from "./ratingSummary";

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

describe("rosterRatingSummary", () => {
  it("shows familiar queues first with ratings and known game counts", () => {
    const n = (value: number) => value.toLocaleString("en-US");
    expect(rosterRatingSummary("[dp]Unknown", profile)).toBe(
      `[dp]Unknown: ratings\nGlobal: ${n(1_200)} · ${n(374)} games\n1v1: ${n(1_050)}\n2v2: ${n(980)} · ${n(20)} games`,
    );
  });

  it("falls back to the legacy global estimate", () => {
    expect(rosterRatingSummary("Player", { ...profile, ratings: [] })).toBe(
      `Player: ratings\nGlobal: ${(1_200).toLocaleString("en-US")}`,
    );
  });

  it("explains when a nickname has no FAF profile", () => {
    expect(rosterRatingSummary("Guest", undefined)).toBe("Guest\nNo FAF rating data available");
  });
});
