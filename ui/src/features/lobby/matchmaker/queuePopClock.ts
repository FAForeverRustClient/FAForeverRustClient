import type { MatchmakerQueue } from "../../../ipc/bindings";

/**
 * Whole seconds until the queue pops next, never below zero.
 *
 * Counted down to `queuePopsAt`, the instant the backend worked out when the
 * server's `matchmaker_info` arrived, which is what the Java client's
 * `MatchmakingQueueItemController` counts down to. It used to be the delta
 * counted from whenever the Play tab rendered the queue, so a delta that had
 * arrived while the tab was closed restarted from its full value on opening,
 * and the countdown reached zero well after the pop it was for.
 *
 * At zero it stays at zero until the server's next update, which it sends
 * after the pop with the time of the one after (`MatchmakerQueue.queue_pop_timer`).
 * Java keeps the last value it showed instead; zero is the true one.
 */
export function secondsUntil(queue: MatchmakerQueue, now: number): number {
  const at = queue.queuePopsAt ? Date.parse(queue.queuePopsAt) : Number.NaN;
  if (Number.isNaN(at)) return Math.max(0, queue.queuePopTimeSeconds);
  return Math.max(0, Math.ceil((at - now) / 1000));
}
