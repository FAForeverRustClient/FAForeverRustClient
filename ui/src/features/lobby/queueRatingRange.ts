// How many people waiting in a queue would be a fair match for you.
//
// Mirrors the Python client's `handle_matchmaker_info`, which does this for
// the 1v1 ladder only and uses it to decide whether to show a "someone is
// waiting" hint. The server publishes the same windows for *every* queue, so
// there is no reason for the other queues to stay quiet about it.

import type { MatchmakerQueue, PlayerRatingSummary } from "../../ipc/bindings";

/**
 * Above this deviation the server has not seen enough games to place you, and
 * the reference client shows nothing at all rather than a number built on a
 * rating it does not believe.
 */
const UNCERTAIN_ABOVE = 200;

/**
 * Below this deviation the tighter windows apply.
 *
 * `boundary_80s` is the *narrower* pair despite the higher quality number,
 * which is worth stating because it reads backwards: a confident rating is
 * matched more strictly, not more loosely.
 */
const CONFIDENT_BELOW = 100;

/**
 * The number of queued searches whose window contains your rating, or `null`
 * when that cannot honestly be said.
 *
 * `null` means "no answer", not "nobody": an unrated queue, a rating the
 * server is still unsure of, or a queue the server published no windows for.
 * Those are different from a real zero and the interface should not print a
 * count for them.
 *
 * `ownSearches` is your own search in this queue, which the server counts and
 * you are not looking for.
 */
export function playersInRatingRange(
  queue: MatchmakerQueue,
  rating: PlayerRatingSummary | null,
  ownSearches: number,
): number | null {
  if (!rating || rating.mean === null || rating.deviation === null) return null;
  if (rating.deviation > UNCERTAIN_ABOVE) return null;

  const windows = rating.deviation < CONFIDENT_BELOW ? queue.boundary80s : queue.boundary75s;
  if (windows.length === 0) return null;

  // The mean, not the displayed rating: the server builds these windows from
  // mu, while the client shows mu - 3*sigma everywhere else. Comparing the
  // displayed number against them would shift everybody down by their own
  // uncertainty. Strict on both ends, as the reference does.
  const mean = rating.mean;
  const inRange = windows.filter((window) => window.min < mean && mean < window.max).length;
  return Math.max(0, inRange - ownSearches);
}
