// The two facts about a queue the client can state for itself.
//
// Everything else an explanation of the matchmaker needs is prose, and prose
// belongs in the message catalogue. These two are computed, because computing
// them is the only way they stay true: a number typed into a paragraph is
// wrong the first time the server changes it.

import type { MatchmakerQueue, PlayerRatingSummary } from "../../ipc/bindings";

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
 * Which share condition a queue plays under, when its own name says so.
 *
 * Read from the leaderboard technical name rather than written down, because
 * that name is the server's: the 4v4 queue's board is `tmm_4v4_full_share`,
 * and the client already keys its ratings off exactly that string. A queue
 * whose name says nothing about sharing returns `null` and the explanation
 * stays quiet rather than guessing.
 */
export type ShareCondition = "fullShare" | "shareUntilDeath";

export function shareConditionFor(rating: PlayerRatingSummary | null): ShareCondition | null {
  const name = rating?.technicalName.toLocaleLowerCase().replace(/[^a-z]/g, "") ?? "";
  if (name.includes("fullshare")) return "fullShare";
  if (name.includes("shareuntildeath")) return "shareUntilDeath";
  return null;
}
