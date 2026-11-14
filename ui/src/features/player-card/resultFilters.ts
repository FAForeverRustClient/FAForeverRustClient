// What the profile's Results tab can be narrowed by (#646).

import type { PlayerGameResult } from "../../ipc/bindings";

/** Whether a game changed the rating, as the results list can tell. */
export type RatedFilter = "all" | "rated" | "unrated";

export interface ResultFilters {
  rated: RatedFilter;
  /** Leaderboard technical names; empty is every queue. */
  queues: string[];
  /** First day kept, `yyyy-mm-dd` in local time; `""` is no lower bound. */
  from: string;
  /** Last day kept, `yyyy-mm-dd` in local time; `""` is no upper bound. */
  to: string;
}

export const NO_RESULT_FILTERS: ResultFilters = { rated: "all", queues: [], from: "", to: "" };

/**
 * A `yyyy-mm-dd` day as the millisecond its local midnight falls on, or the
 * midnight after it with `nextDay`; `null` for no (or no whole) date.
 */
function dayStart(value: string, nextDay = false): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + (nextDay ? 1 : 0)).getTime();
}

/**
 * The games the filters keep. Rated is a game a rating journal carries a
 * change for, which is what the Rating column shows; the queues add up, so
 * 3v3 and 4v4 together is two picks. Both ends of the date range are whole
 * days in the user's own time zone, and either may be left open: from alone
 * is "since", to alone is "up to". A game with no start time cannot be placed
 * in a range, so a set date leaves it out.
 */
export function filterResults(games: readonly PlayerGameResult[], filters: ResultFilters): PlayerGameResult[] {
  const queues = new Set(filters.queues);
  const from = dayStart(filters.from);
  const until = dayStart(filters.to, true);
  return games.filter((game) => {
    const rated = game.ratingChangeHundredths !== null;
    if (filters.rated === "rated" && !rated) return false;
    if (filters.rated === "unrated" && rated) return false;
    if (queues.size > 0 && !queues.has(game.queue)) return false;
    if (from === null && until === null) return true;
    const played = game.playedAt ? Date.parse(game.playedAt) : Number.NaN;
    if (Number.isNaN(played)) return false;
    return (from === null || played >= from) && (until === null || played < until);
  });
}
