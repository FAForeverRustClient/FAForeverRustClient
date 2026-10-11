// Which map pool a match is actually played on.
//
// The service's `poolForMatch` (lib/match.js) does not stop at an explicit
// assignment: a match's own pool wins, then its round's, then for the 3rd
// place match the semi-finals' pool, and failing all of those the first pool
// there is. The bracket used to show only an explicit assignment, which left
// the pool a round really used invisible whenever the organiser had bound
// none. Where the answer came from is kept, because the website says it:
// "(default)" and "(as the semi-finals)".

import type { BracketSide, MapPool, Tourney, TourneyMatch } from "../../../ipc/bindings";
import { roundKeyOf } from "../../../shared/rules/tourneyRules";

export type PoolSource = "match" | "round" | "semis" | "default";

export interface ResolvedPool {
  pool: MapPool;
  source: PoolSource;
}

/** The pool bound to a key (`wb:2`, `match:m1`), if one is. */
function bound(event: Tourney, key: string): MapPool | null {
  const held = event.poolAssign.find((assignment) => assignment.round === key);
  if (held === undefined) return null;
  return event.mapPools.find((pool) => pool.id === held.poolId) ?? null;
}

/** The key of a match's own pool assignment. */
export function matchPoolKey(matchId: string): string {
  return `match:${matchId}`;
}

/** The pool a round is played on, and why: the column header's answer. */
export function poolForRoundOf(event: Tourney, bracket: BracketSide, round: number): ResolvedPool | null {
  const own = bound(event, roundKeyOf(bracket, round));
  if (own !== null) return { pool: own, source: "round" };
  if (bracket === "thirdPlace") {
    const semis = bound(event, roundKeyOf("winners", round - 1));
    if (semis !== null) return { pool: semis, source: "semis" };
  }
  const first = event.mapPools[0];
  return first === undefined ? null : { pool: first, source: "default" };
}

/** The pool one match is played on, and why. */
export function poolForMatch(event: Tourney, entry: TourneyMatch): ResolvedPool | null {
  const own = bound(event, matchPoolKey(entry.id));
  if (own !== null) return { pool: own, source: "match" };
  return poolForRoundOf(event, entry.bracket, entry.round);
}
