import { describe, expect, it } from "vitest";
import type { PlayerMapStats, PlayerRatingSummary } from "../../ipc/bindings";
import { leaderboardTotalGames, rankedRecord } from "./rankedRecord";

function rating(technicalName: string, gamesPlayed: number): PlayerRatingSummary {
  return {
    leaderboardId: 1,
    technicalName,
    name: technicalName,
    rating: 1500,
    mean: 1500,
    deviation: 100,
    gamesPlayed,
    wonGames: 0,
    updateTime: "",
  };
}

function stats(overrides: Partial<PlayerMapStats> = {}): PlayerMapStats {
  return {
    totalGames: 7432,
    rankedGames: 5189,
    wins: 2708,
    losses: 2453,
    undecided: 28,
    unranked: 2243,
    unattributed: 0,
    maps: [],
    truncated: false,
    ...overrides,
  };
}

describe("the leaderboards' own game count", () => {
  it("adds up the five ranked leaderboards and nothing else", () => {
    expect(
      leaderboardTotalGames([
        rating("global", 4000),
        rating("ladder_1v1", 1000),
        rating("tmm_2v2", 200),
        rating("tmm_3v3", 50),
        rating("tmm_4v4_full_share", 8),
        // A retired queue is not in the tracker's set, so its games are not in
        // the total either.
        rating("tmm_4v4_share_until_death", 999),
      ]),
    ).toBe(5258);
  });

  it("folds the spellings the API has used for one leaderboard", () => {
    expect(leaderboardTotalGames([rating("ladder1v1", 7), rating("tmm4v4", 3)])).toBe(10);
  });

  it("says nothing rather than zero before the profile has arrived", () => {
    // Zero would read as "this player has never played a ranked game" and
    // would book the entire scan as missing.
    expect(leaderboardTotalGames(undefined)).toBeNull();
  });
});

describe("the header record", () => {
  it("books the games the leaderboards count and the scan never saw as draws", () => {
    // 5258 ranked by the leaderboards, 5189 read: the 69 in between join the
    // draws so the three columns add up to FAF's own total.
    const record = rankedRecord(stats(), 5258);
    expect(record.rankedGames).toBe(5258);
    expect(record.draws).toBe(97);
    expect(record.wins + record.losses + record.draws).toBe(5258);
  });

  it("leaves the record alone when the scan read more than the leaderboards count", () => {
    const record = rankedRecord(stats(), 5000);
    expect(record.draws).toBe(28);
    expect(record.rankedGames).toBe(5000);
  });

  it("falls back to the scan when there is no profile to ask", () => {
    const record = rankedRecord(stats(), null);
    expect(record.rankedGames).toBe(5189);
    expect(record.draws).toBe(28);
  });

  it("takes the win rate over decided games, leaving draws out", () => {
    const record = rankedRecord(stats(), 5258);
    expect(record.winRate).toBeCloseTo(52.47, 2);
  });

  it("has no win rate at all when nothing has been decided", () => {
    expect(rankedRecord(stats({ wins: 0, losses: 0 }), null).winRate).toBeNull();
  });
});
