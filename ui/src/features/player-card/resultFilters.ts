// What the profile's Results tab can be narrowed by (#646).

import type { PlayerGameResult } from "../../ipc/bindings";

/** Whether a game changed the rating, as the results list can tell. */
export type RatedFilter = "all" | "rated" | "unrated";

export interface ResultFilters {
  rated: RatedFilter;
  /** Leaderboard technical names; empty is every queue. */
  queues: string[];
}

export const NO_RESULT_FILTERS: ResultFilters = { rated: "all", queues: [] };

/**
 * The games the filters keep. Rated is a game a rating journal carries a
 * change for, which is what the Rating column shows; the queues add up, so
 * 3v3 and 4v4 together is two picks.
 */
export function filterResults(games: readonly PlayerGameResult[], filters: ResultFilters): PlayerGameResult[] {
  const queues = new Set(filters.queues);
  return games.filter((game) => {
    const rated = game.ratingChangeHundredths !== null;
    if (filters.rated === "rated" && !rated) return false;
    if (filters.rated === "unrated" && rated) return false;
    return queues.size === 0 || queues.has(game.queue);
  });
}
