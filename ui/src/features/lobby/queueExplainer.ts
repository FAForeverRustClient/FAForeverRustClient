// The two facts about a queue the client can state for itself.
//
// Everything else an explanation of the matchmaker needs is prose, and prose
// belongs in the message catalogue. These two are computed, because computing
// them is the only way they stay true: a number typed into a paragraph is
// wrong the first time the server changes it.

import type { MatchmakerQueue } from "../../ipc/bindings";

/**
 * How wide the rating bands of the searches queued right now are.
 *
 * This is the answer to "how far apart can my opponent and I be", and it is
 * deliberately expressed as a *width* rather than as two ratings. The server
 * publishes these windows around each searcher's TrueSkill mean, while every
 * number the client shows is the displayed rating (`mean - 3*deviation`), so
 * the endpoints are not in the same units as anything on screen. A width is,
 * because the offset cancels.
 *
 * `null` when the server published no windows for this queue, which is not the
 * same as a queue nobody is waiting in and should not print as a zero.
 *
 * `boundary75s` is the wider of the two sets the server sends, and therefore
 * the one that answers "how far apart *could* we be". `boundary80s` is only a
 * fallback for a queue that carries one and not the other.
 */
export interface QueueBands {
  /** The tightest band anybody in this queue is currently searching with. */
  narrowest: number;
  /** The widest, which is what somebody who has been waiting has by now. */
  widest: number;
  /** How many searches those bands are drawn from. */
  searches: number;
}

export function queuedRatingBands(queue: MatchmakerQueue): QueueBands | null {
  const windows = queue.boundary75s.length > 0 ? queue.boundary75s : queue.boundary80s;
  if (windows.length === 0) return null;
  const widths = windows.map((window) => Math.max(0, window.max - window.min));
  return {
    narrowest: Math.min(...widths),
    widest: Math.max(...widths),
    searches: windows.length,
  };
}

/**
 * How many players a queue needs before it can start anything.
 *
 * Twice the team size, and it is worth stating because it is half the answer
 * to the question people actually ask: eight people are queued for 3v3 and no
 * game starts. Six of the eight would be a game; the other half of the answer
 * is that those six have to split into two sides the server calls balanced,
 * which is not something a count can show.
 */
export function playersPerMatch(queue: MatchmakerQueue): number {
  return queue.teamSize * 2;
}
