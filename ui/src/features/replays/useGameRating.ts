// A replay's review score, as fresh as this session knows it.
//
// The score a replay shows came from the vault search that listed it, and
// nothing refreshed it: rate a replay and it still read "Unrated" until the
// next search, and a local replay never had a score at all. The reviews panel,
// though, holds the game's whole review list the moment it opens and again
// after every write, and derives the same average from it. So while it is open
// on this game its numbers win, and they are remembered for the rest of the
// session, so closing the panel does not put the stale ones back.

import { useEffect, useMemo } from "react";

import { useAppStore } from "../../store/store";

export interface GameRating {
  /** Mean score, one to five. `null` when nobody has reviewed the game. */
  average: number | null;
  count: number;
}

const known = new Map<number, GameRating>();

export function useGameRating(uid: number, average: number | null, count: number | null): GameRating {
  const reviews = useAppStore((state) => state.state.reviews);
  const live = reviews.target?.kind === "game"
    && reviews.target.id === uid
    && reviews.status.type === "ready"
    ? {
        average: reviews.summary.total > 0 ? reviews.summary.averageTenths / 10 : null,
        count: reviews.summary.total,
      }
    : null;
  const liveAverage = live?.average;
  const liveCount = live?.count;

  useEffect(() => {
    if (uid > 0 && liveCount !== undefined) {
      known.set(uid, { average: liveAverage ?? null, count: liveCount });
    }
  }, [uid, liveAverage, liveCount]);

  // One object per score rather than per render: the facts row is memoised
  // on it.
  const resolved = live ?? known.get(uid) ?? { average, count: count ?? 0 };
  const resolvedAverage = resolved.average;
  const resolvedCount = resolved.count;
  return useMemo(() => ({ average: resolvedAverage, count: resolvedCount }), [resolvedAverage, resolvedCount]);
}
