import { describe, expect, it } from "vitest";
import type { PlayerCardProfile, PlayerLeaguePlacement, PlayerRatingSummary } from "../../ipc/bindings";
import { formatUserAgent, queueRows, queueTileColumns } from "./PlayerOverview";

function rating(leaderboardId: number, technicalName: string, gamesPlayed: number): PlayerRatingSummary {
  return { leaderboardId, technicalName, rating: 1500, mean: 1600, deviation: 50, gamesPlayed, wonGames: 0, updateTime: "" };
}

function placement(technicalName: string, division: string): PlayerLeaguePlacement {
  return { technicalName, seasonNumber: 31, division, subdivision: "II", score: 5, highestScore: 10, gamesPlayed: 12, imageUrl: "" };
}

function profileWith(ratings: PlayerRatingSummary[], leaguePlacements: PlayerLeaguePlacement[]): PlayerCardProfile {
  return {
    playerId: 1, login: "Alice", country: "", registeredAt: "", userAgent: "", avatars: [], names: [], clan: null,
    ratings, leaguePlacements, events: [], achievements: [], warnings: [], matchedFormerName: null,
  };
}

describe("queueRows", () => {
  it("puts a league placement on the row of the queue it belongs to", () => {
    const { played } = queueRows(profileWith(
      [rating(1, "global", 40), rating(2, "ladder_1v1", 12)],
      [placement("ladder_1v1", "gold")],
    ));
    expect(played.map((row) => [row.technicalName, row.placement?.division ?? null])).toEqual([
      ["global", null],
      ["ladder_1v1", "gold"],
    ]);
  });

  it("keeps the first placement per board, which the backend sends highest first", () => {
    const { played } = queueRows(profileWith(
      [rating(2, "ladder_1v1", 12)],
      [placement("ladder_1v1", "diamond"), placement("ladder_1v1", "gold")],
    ));
    expect(played[0].placement?.division).toBe("diamond");
  });

  it("gives a placement without a rating a row of its own, after the rated ones", () => {
    const { played } = queueRows(profileWith([rating(1, "global", 40)], [placement("tmm_2v2", "silver")]));
    expect(played.map((row) => [row.technicalName, row.rating === null])).toEqual([
      ["global", false],
      ["tmm_2v2", true],
    ]);
  });

  it("holds back a queue with no games and no placement", () => {
    const { played, unplayed } = queueRows(profileWith(
      [rating(1, "global", 40), rating(3, "tmm_3v3", 0), rating(4, "tmm_2v2", 0)],
      [placement("tmm_2v2", "bronze")],
    ));
    expect(played.map((row) => row.technicalName)).toEqual(["global", "tmm_2v2"]);
    expect(unplayed.map((row) => row.technicalName)).toEqual(["tmm_3v3"]);
  });
});

describe("formatUserAgent", () => {
  it("formats Java client user agents", () => {
    expect(formatUserAgent("faf-client")).toBe("Java client");
    expect(formatUserAgent("downlords-faf-client")).toBe("Java client");
    expect(formatUserAgent("Downlords-FAF-Client/2024.1.0")).toBe("Java client");
    expect(formatUserAgent("faf-client/2023.2.1")).toBe("Java client");
  });

  it("formats Python client user agents", () => {
    expect(formatUserAgent("faf-python-client")).toBe("Python client");
    expect(formatUserAgent("python-client")).toBe("Python client");
    expect(formatUserAgent("python")).toBe("Python client");
  });

  it("formats Rust client user agents", () => {
    expect(formatUserAgent("faf-rust-client")).toBe("Rust client");
    expect(formatUserAgent("forge-client")).toBe("Rust client");
    expect(formatUserAgent("rust")).toBe("Rust client");
  });

  it("falls back gracefully for missing or custom user agents", () => {
    expect(formatUserAgent(null)).toBe("N/A");
    expect(formatUserAgent(undefined)).toBe("N/A");
    expect(formatUserAgent("")).toBe("N/A");
    expect(formatUserAgent("   ")).toBe("N/A");
    expect(formatUserAgent("custom-faf-client-fork")).toBe("Java client");
    expect(formatUserAgent("SomeOtherTool/1.0")).toBe("SomeOtherTool/1.0");
  });
});

describe("queueTileColumns", () => {
  it("keeps every queue a player normally has in one row", () => {
    for (const count of [4, 5, 6]) expect(queueTileColumns(count)).toBe(count);
  });

  it("gives fewer than four tiles a quarter each rather than the full width", () => {
    expect(queueTileColumns(1)).toBe(4);
    expect(queueTileColumns(3)).toBe(4);
  });

  it("splits more than six over two rows", () => {
    expect(queueTileColumns(7)).toBe(4);
    expect(queueTileColumns(8)).toBe(4);
  });
});
