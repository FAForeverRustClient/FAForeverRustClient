import { describe, expect, it } from "vitest";

import type { LeaderboardEntry } from "../../ipc/bindings";
import { crossRatingIndex, sortLeaderboard } from "./LeaderboardTable";

function entry(playerId: number, rank: number, rating: number | null): LeaderboardEntry {
  return {
    playerId,
    rank,
    playerName: `player${playerId}`,
    avatarUrl: null,
    avatarTooltip: null,
    score: null,
    rating,
    mean: null,
    deviation: null,
    gamesPlayed: rank * 10,
    wonGames: null,
    updateTime: null,
    division: null,
    divisionOrder: null,
    highestScore: null,
    divisionImageUrl: null,
    divisionMediumImageUrl: null,
    returningPlayer: null,
  };
}

const NONE = crossRatingIndex([]);

describe("the order the leaderboard is drawn in", () => {
  const entries = [entry(1, 1, 2_400), entry(2, 2, 1_800), entry(3, 3, 2_100)];

  it("puts the highest value first when a number column is read downwards", () => {
    const sorted = sortLeaderboard(entries, "board:global", true, "global", NONE);
    expect(sorted.map((row) => row.rating)).toEqual([2_400, 2_100, 1_800]);
  });

  it("leaves the rows with no value at the bottom either way round", () => {
    // A player with no rating on a board is not the best player on it and
    // not the worst one: they are not on it. Sorting them as a small number
    // put a screenful of N/A at the top of a column somebody had just asked
    // for the highest value in.
    const withGaps = [entry(1, 1, null), entry(2, 2, 1_800), entry(3, 3, 2_100)];
    // `1v1` is not the ranked board, and nothing was loaded for it, so every
    // cell in that column is empty except where the index has one.
    const cross = crossRatingIndex([
      { playerId: 2, ratings: [{ leaderboard: "1v1", rating: 1_500, gamesPlayed: 40 }] },
      { playerId: 3, ratings: [{ leaderboard: "1v1", rating: 1_900, gamesPlayed: 70 }] },
    ]);
    const down = sortLeaderboard(withGaps, "board:1v1", true, "global", cross);
    expect(down.map((row) => row.playerId)).toEqual([3, 2, 1]);
    const up = sortLeaderboard(withGaps, "board:1v1", false, "global", cross);
    expect(up.map((row) => row.playerId)).toEqual([2, 3, 1]);
  });

  it("reads the rank upwards, because first is its top", () => {
    const sorted = sortLeaderboard(entries, "rank", false, "global", NONE);
    expect(sorted.map((row) => row.rank)).toEqual([1, 2, 3]);
  });
});
