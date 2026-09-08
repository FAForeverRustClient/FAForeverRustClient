// The number beside "Matchmaker" in the play-mode bar.
//
// It used to be `matchmakerQueues.length`: the number of queues the server
// publishes, which is a constant 4 that moves only when FAF adds a queue. Next
// to "Play 14" and "Coop 1", both of which count things that are happening, it
// read as four of something and told nobody anything. The people waiting is the
// number that changes, and the one worth glancing at before opening the tab.

import type { MatchmakerQueue } from "../../ipc/bindings";

/**
 * How many players the server currently reports as searching, across every
 * queue.
 *
 * A sum, not a headcount: the server publishes `num_players` per queue and
 * somebody searching two queues at once is in both of those numbers. There is
 * nothing in the snapshot to deduplicate them by, and the alternative (showing
 * the largest queue, or the queue count again) says less. The Java client's
 * queue list adds them up the same way.
 */
export function queuedPlayerCount(queues: MatchmakerQueue[]): number {
  return queues.reduce((total, queue) => total + Math.max(0, queue.numPlayers), 0);
}
