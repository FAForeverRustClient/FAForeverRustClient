// How many people waiting in a queue would be a fair match for you.
//
// Mirrors the Python client's `handle_matchmaker_info`, which does this for
// the 1v1 ladder only and uses it to decide whether to show a "someone is
// waiting" hint. The server publishes the same windows for *every* queue, so
// there is no reason for the other queues to stay quiet about it.

import type { MatchmakerQueue, PlayerRatingSummary } from "../../../ipc/bindings";

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
 * The windows this queue publishes for the rating the server has for you.
 *
 * Which of the two sets applies is a question about *your* deviation, so the
 * count and the breakdown have to ask it the same way or they answer the same
 * question differently.
 */
function windowsFor(
  queue: MatchmakerQueue,
  rating: PlayerRatingSummary | null,
): { min: number; max: number }[] {
  if (rating && rating.mean !== null && rating.deviation !== null && rating.deviation <= UNCERTAIN_ABOVE) {
    return rating.deviation < CONFIDENT_BELOW ? queue.boundary80s : queue.boundary75s;
  }
  return queue.boundary80s.length > 0 ? queue.boundary80s : queue.boundary75s;
}

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

  const windows = windowsFor(queue, rating);
  if (windows.length === 0) return null;

  // The mean, not the displayed rating: the server builds these windows from
  // mu, while the client shows mu - 3*sigma everywhere else. Comparing the
  // displayed number against them would shift everybody down by their own
  // uncertainty. Strict on both ends, as the reference does.
  const mean = rating.mean;
  const inRange = windows.filter((window) => window.min < mean && mean < window.max).length;
  return Math.max(0, inRange - ownSearches);
}

/**
 * How wide a rating band each row of the queue breakdown covers.
 *
 * 400 is what the Java client uses, and the bands it produces -- 400 to 800,
 * 800 to 1200 -- are the ones players already talk in.
 */
export const RATING_BUCKET = 400;

/** One band of the breakdown: how many people are queued around that rating. */
export interface RatingBucket {
  min: number;
  max: number;
  count: number;
  /**
   * How many of this band's searches would actually take you, your own search
   * excluded. These sum to the number the card prints as "in your range".
   *
   * They are not the same question as `count`, and a report came from the two
   * being read as though they were: a band of one, a rating apparently inside
   * it, and "0 in your range" underneath. The bands are the matchmaker's mean,
   * the rating on the card is the conservative number every client displays,
   * and a search only takes you if its window contains your *mean*. Saying per
   * band which of them do settles it without printing a second rating nobody
   * recognises.
   */
  inRange: number;
  /** The band your own rating sits in, on the same scale as the bands. */
  mine: boolean;
}

/**
 * The people waiting in a queue, grouped by roughly what they are rated.
 *
 * The server publishes no ratings, only each search's acceptable *window*, so
 * the rating is taken as the middle of that window. That is exact at the
 * moment a search starts and drifts outwards as the window widens with time
 * spent waiting, which is the right direction to be wrong in: it spreads a
 * long-waiting player across neighbouring bands rather than inventing one.
 *
 * The narrow windows are preferred for that reason. Empty bands are left out
 * entirely, so the breakdown is as long as the queue is varied.
 */
export function queueRatingBuckets(
  queue: MatchmakerQueue,
  rating: PlayerRatingSummary | null = null,
  ownSearches = 0,
): RatingBucket[] {
  const windows = windowsFor(queue, rating);
  // The same test `playersInRatingRange` makes, and only when it would make
  // it: an uncertain or absent rating has no answer, and a band cannot claim
  // one either.
  const mean =
    playersInRatingRange(queue, rating, 0) === null ? null : (rating?.mean ?? null);
  const bandOf = (value: number) => Math.floor(Math.max(0, value) / RATING_BUCKET) * RATING_BUCKET;

  const counts = new Map<number, { count: number; inRange: number }>();
  for (const window of windows) {
    const middle = (window.min + window.max) / 2;
    if (!Number.isFinite(middle)) continue;
    const band = bandOf(middle);
    const tally = counts.get(band) ?? { count: 0, inRange: 0 };
    tally.count += 1;
    if (mean !== null && window.min < mean && mean < window.max) tally.inRange += 1;
    counts.set(band, tally);
  }

  // Your own search is in the server's numbers, it is centred on you, and it
  // is therefore in your own band. Taking it off there is what keeps these
  // adding up to the count on the card.
  const myBand = mean === null ? null : bandOf(mean);
  if (myBand !== null && ownSearches > 0) {
    const tally = counts.get(myBand);
    if (tally) tally.inRange = Math.max(0, tally.inRange - ownSearches);
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([min, tally]) => ({
      min,
      max: min + RATING_BUCKET,
      count: tally.count,
      inRange: tally.inRange,
      mine: min === myBand,
    }));
}
