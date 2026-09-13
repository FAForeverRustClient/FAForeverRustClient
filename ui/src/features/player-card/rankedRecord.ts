// The header figures of the map record, as faftracker.xyz computes them.
//
// The record itself is the backend's: `aggregate_map_stats` walks the history
// and applies the same seven verdict rules and the same two rating overrides.
// What is left here is the last step of `analytics.js`'s `overview`, which
// needs something the scan does not have -- the player's leaderboard entries,
// which live on the profile rather than in the scan.
//
// The tracker does not print the ranked games it read. It prints the number
// the leaderboards themselves report, and books the difference between that
// and what its scan returned as draws, so the three columns add up to FAF's
// own total. That is an approximation, and it is the one the numbers players
// compare this client against are made of, so it is the one reproduced here.

import type { PlayerMapStats, PlayerRatingSummary } from "../../ipc/bindings";

/// The five leaderboards `analytics.js` counts as ranked. A retired queue is
/// absent from this list, so its games are not in the total either.
const RANKED_LEADERBOARDS = new Set([
  "global",
  "ladder_1v1",
  "tmm_2v2",
  "tmm_3v3",
  "tmm_4v4_full_share",
]);

/// Spellings the API has used for the same leaderboard, folded together the
/// way `QUEUE_ALIASES` folds them.
const LEADERBOARD_ALIASES: Record<string, string> = {
  ladder1v1: "ladder_1v1",
  tmm2v2: "tmm_2v2",
  tmm3v3: "tmm_3v3",
  tmm4v4: "tmm_4v4_full_share",
  tmm_4v4: "tmm_4v4_full_share",
};

function leaderboardKey(technicalName: string): string {
  const raw = technicalName.trim().toLowerCase();
  return LEADERBOARD_ALIASES[raw] ?? raw;
}

/**
 * How many ranked games FAF's own leaderboards say this player has.
 *
 * `null` when the profile has not arrived, which is not zero: it is "ask the
 * scan instead".
 */
export function leaderboardTotalGames(
  ratings: readonly PlayerRatingSummary[] | undefined,
): number | null {
  if (!ratings) return null;
  return ratings.reduce(
    (total, rating) =>
      RANKED_LEADERBOARDS.has(leaderboardKey(rating.technicalName))
        ? total + rating.gamesPlayed
        : total,
    0,
  );
}

export interface RankedRecord {
  /// What the leaderboards say, falling back to what the scan read.
  rankedGames: number;
  unrankedGames: number;
  wins: number;
  losses: number;
  /// The scan's draws plus every ranked game the leaderboards count and the
  /// history endpoint did not return.
  draws: number;
  /// Percent, undivided by draws. `null` when nothing has been decided.
  winRate: number | null;
}

/** The four header figures, from the scan and the leaderboards together. */
export function rankedRecord(
  stats: PlayerMapStats,
  leaderboardTotal: number | null,
): RankedRecord {
  // Never negative: a scan that read more ranked games than the leaderboards
  // count is not a shortfall, and the tracker clamps the same way.
  const missing =
    leaderboardTotal === null ? 0 : Math.max(0, leaderboardTotal - stats.rankedGames);
  const decided = stats.wins + stats.losses;
  return {
    rankedGames: leaderboardTotal ?? stats.rankedGames,
    unrankedGames: stats.unranked,
    wins: stats.wins,
    losses: stats.losses,
    draws: stats.undecided + missing,
    winRate: decided > 0 ? (stats.wins / decided) * 100 : null,
  };
}
