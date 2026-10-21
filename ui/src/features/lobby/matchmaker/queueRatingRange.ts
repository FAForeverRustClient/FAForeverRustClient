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

// ── 1v1: the server's own rule, replicated ─────────────────────────────────
//
// The windows a queue publishes are fixed: ±200 (`boundary_80s`) and ±100
// (`boundary_75s`) around each search's rating, rounded to ten. They never
// widen with waiting, and the 1v1 matchmaker does not use them. It pairs two
// searches when their TrueSkill match quality clears both of their thresholds,
// and a threshold starts at 80% of the quality of a game against yourself and
// drops with every queue pop that fails to match you (`server/matchmaker/
// search.py`, `match_threshold`). That drop is why "0 in your range" could be
// followed by a match (#303): after a few pops the reach is almost twice the
// window. What the client cannot know is an opponent's own deviation, and it
// is taken to be yours.

/** `trueskill.setup(beta=240)` in the server's `config.py`. */
const TRUESKILL_BETA = 240;
/** `LADDER_SEARCH_EXPANSION_MAX`: how far a threshold drops, at most. */
const SEARCH_EXPANSION_MAX = 0.25;
/** `LADDER_SEARCH_EXPANSION_STEP`: how far it drops per pop that fails to match. */
const SEARCH_EXPANSION_STEP = 0.05;
/** `QUEUE_POP_TIME_MAX`: the longest the server waits between two pops. */
export const QUEUE_POP_INTERVAL_SECONDS = 90;
/** `NEWBIE_MIN_GAMES` and `NEWBIE_BASE_MEAN`: a new account is matched on a
 *  mean pulled towards 500 until it has played this many games. */
const NEWBIE_MIN_GAMES = 10;
const NEWBIE_BASE_MEAN = 500;

/** The mean the server matches a 1v1 search on. */
function matchmakingMean(rating: PlayerRatingSummary): number | null {
  if (rating.mean === null) return null;
  const games = rating.gamesPlayed;
  if (games > NEWBIE_MIN_GAMES) return rating.mean;
  return ((NEWBIE_MIN_GAMES - games) * NEWBIE_BASE_MEAN + games * rating.mean) / NEWBIE_MIN_GAMES;
}

/**
 * How far apart in mean two players can be and still be matched in 1v1, with
 * their thresholds dropped by `expansion`. Two players with the same
 * deviation `s`: quality is `sqrt(2b²/c²) * exp(-d²/2c²)` with
 * `c² = 2b² + 2s²`, and the rule is quality >= 0.8 * sqrt(2b²/c²) - expansion.
 */
export function matchReach(deviation: number, expansion: number): number {
  const c2 = 2 * TRUESKILL_BETA ** 2 + 2 * deviation ** 2;
  const selfQuality = Math.sqrt((2 * TRUESKILL_BETA ** 2) / c2);
  const ratio = 0.8 - expansion / selfQuality;
  if (ratio <= 0) return Number.POSITIVE_INFINITY;
  return Math.sqrt(-2 * c2 * Math.log(ratio));
}

/**
 * The reach now, after the threshold has dropped as far as it goes, and how
 * much it grows per pop on the way there, averaged over the pops it takes.
 */
export function matchReaches(
  rating: PlayerRatingSummary,
): { now: number; waited: number; perPop: number } | null {
  if (rating.deviation === null) return null;
  const now = matchReach(rating.deviation, 0);
  const waited = matchReach(rating.deviation, SEARCH_EXPANSION_MAX);
  return { now, waited, perPop: (waited - now) / (SEARCH_EXPANSION_MAX / SEARCH_EXPANSION_STEP) };
}

/**
 * Whether a published window's search could be matched with you: for 1v1 by
 * the server's quality rule after a few minutes of waiting, measured from the
 * middle of the window, which is that search's rating; elsewhere by the old
 * overlap test, since the team matchmaker weighs team balance instead and
 * nothing the queue publishes describes it.
 */
function reachesYou(
  queue: MatchmakerQueue,
  rating: PlayerRatingSummary,
): ((window: { min: number; max: number }) => boolean) | null {
  if (rating.mean === null || rating.deviation === null) return null;
  if (queue.teamSize === 1) {
    const mean = matchmakingMean(rating);
    const reaches = matchReaches(rating);
    if (mean === null || !reaches) return null;
    return (window) => Math.abs((window.min + window.max) / 2 - mean) <= reaches.waited;
  }
  const mean = rating.mean;
  return (window) => window.min < mean && mean < window.max;
}

/**
 * The number of queued searches that could be matched with you, or `null`
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
  // uncertainty. See `reachesYou` for what counts as in range.
  const reaches = reachesYou(queue, rating);
  if (!reaches) return null;
  const inRange = windows.filter(reaches).length;
  return Math.max(0, inRange - ownSearches);
}

/**
 * The rating axis and sampling resolution for the queue density curve.
 *
 * Spanning 0 to 2400 with ticks every 800 points covers the active ladder
 * without isolating outliers at the top or bottom into narrow rows. Each
 * queued search contributes a Gaussian wave of width `TRUESKILL_BETA` (240)
 * around the middle of its window, producing a smooth activity curve rather
 * than exact per-bracket headcounts.
 */
export const RATING_GRAPH_DOMAIN: readonly [number, number] = [0, 2400];
export const RATING_GRAPH_TICKS: readonly number[] = [0, 800, 1600, 2400];
const RATING_GRAPH_STEPS = 48;
/**
 * Minimum peak density that reaches full plot height, so a single queued
 * search draws a low wave rather than a maxed-out peak.
 */
const FULL_PEAK_DENSITY = 2.5;

export interface RatingGraphPoint {
  rating: number;
  /** Normalized curve height from 0 to 1. */
  value: number;
}

export interface RatingGraphMarker {
  rating: number;
  /** Normalized curve height from 0 to 1 at `rating`. */
  value: number;
}

export interface QueueRatingGraph {
  points: RatingGraphPoint[];
  marker: RatingGraphMarker | null;
}

/**
 * The people waiting in a queue, as a smooth rating density curve.
 *
 * Returns `null` when the queue has no published search windows so an empty
 * queue renders no popover.
 */
export function queueRatingGraph(
  queue: MatchmakerQueue,
  rating: PlayerRatingSummary | null = null,
): QueueRatingGraph | null {
  const windows = windowsFor(queue, rating);
  const [from, to] = RATING_GRAPH_DOMAIN;
  const clamp = (value: number) => Math.min(to, Math.max(from, value));
  const centres: number[] = [];

  for (const window of windows) {
    const middle = (window.min + window.max) / 2;
    if (Number.isFinite(middle)) centres.push(clamp(middle));
  }

  if (centres.length === 0) return null;

  const rawDensity = (target: number) => {
    let sum = 0;
    for (const centre of centres) {
      const distance = (target - centre) / TRUESKILL_BETA;
      sum += Math.exp(-0.5 * distance * distance);
    }
    return sum;
  };

  const sampleRatings: number[] = [];
  for (let step = 0; step <= RATING_GRAPH_STEPS; step++) {
    sampleRatings.push(from + ((to - from) * step) / RATING_GRAPH_STEPS);
  }

  const rawSamples = sampleRatings.map(rawDensity);
  const peak = Math.max(...rawSamples, ...centres.map(rawDensity), FULL_PEAK_DENSITY);
  const points: RatingGraphPoint[] = sampleRatings.map((sampleRating, index) => ({
    rating: sampleRating,
    value: rawSamples[index] / peak,
  }));

  // The same certainty test `playersInRatingRange` makes: an uncertain or
  // absent rating has no marker on the axis.
  const mean =
    playersInRatingRange(queue, rating, 0) === null ? null : (rating?.mean ?? null);
  const markerRating = mean === null ? null : clamp(mean);
  const marker: RatingGraphMarker | null =
    markerRating === null
      ? null
      : {
          rating: markerRating,
          value: Math.min(1, rawDensity(markerRating) / peak),
        };

  return { points, marker };
}
