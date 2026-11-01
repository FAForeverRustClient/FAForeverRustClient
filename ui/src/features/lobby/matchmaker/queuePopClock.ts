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
 *
 * Never more than the delta the server sent: time only runs forward from the
 * moment it arrived. A larger answer means `now` is older than that moment, or
 * this machine's clock was set back since, and showed 1:50 on a queue that
 * pops every 90 seconds.
 */
export function secondsUntil(queue: MatchmakerQueue, now: number): number {
  const delta = Math.max(0, queue.queuePopTimeSeconds);
  const at = queue.queuePopsAt ? Date.parse(queue.queuePopsAt) : Number.NaN;
  if (Number.isNaN(at)) return delta;
  return Math.min(delta, Math.max(0, Math.ceil((at - now) / 1000)));
}
