// A fact about a queue the client can state for itself.
//
// Everything else an explanation of the matchmaker needs is prose, and prose
// belongs in the message catalogue. This one is computed, because computing
// it is the only way it stays true: a number typed into a paragraph is wrong
// the first time the server changes it.

import type { MatchmakerQueue } from "../../../ipc/bindings";

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
