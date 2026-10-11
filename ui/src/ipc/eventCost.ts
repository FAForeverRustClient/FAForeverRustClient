// What applying backend events costs the page, written to the client log.
//
// Applying an event is the reducer plus every store subscriber re-reading its
// selector, and with a populated client (thousands of maps, hundreds of live
// games, a busy chat) that is where the page's time goes when it feels slow.
// Nothing measured it, so a review could only call the narrow selectors and
// the memoisation "sensible". This adds the time up per window and writes one
// line when the window was expensive, naming the slowest event, so a session
// leaves numbers behind instead of an impression.

import type { AppEvent } from "./bindings";
import { ipc } from "./client";

/** How long a window runs from its first event before it is added up and judged. */
const WINDOW_MS = 30_000;

/** Total apply time within one window worth a line. */
const REPORT_TOTAL_ABOVE_MS = 500;

/** A single event this slow is worth a line on its own. */
const REPORT_SINGLE_ABOVE_MS = 50;

let count = 0;
let total = 0;
let slowest = 0;
let slowestName = "";
let timer: ReturnType<typeof setTimeout> | null = null;

/** `Lobby:gamesUpdated`: the slice and the event, never the payload. */
export function eventName(event: AppEvent): string {
  const inner = (event as { event?: unknown }).event;
  const type = inner && typeof inner === "object" && "type" in inner
    ? String(inner.type)
    : "";
  return type ? `${event.kind}:${type}` : event.kind;
}

/** Apply `event` with `apply`, timing it. */
export function measureEventApply(event: AppEvent, apply: (event: AppEvent) => void): void {
  const started = performance.now();
  apply(event);
  const spent = performance.now() - started;
  count += 1;
  total += spent;
  if (spent > slowest) {
    slowest = spent;
    slowestName = eventName(event);
  }
  // A window opens with its first event, so an idle page runs no timer.
  timer ??= setTimeout(flush, WINDOW_MS);
}

function flush(): void {
  timer = null;
  if (total >= REPORT_TOTAL_ABOVE_MS || slowest >= REPORT_SINGLE_ABOVE_MS) {
    ipc.reportEventCost(count, total, slowestName, slowest);
  }
  count = 0;
  total = 0;
  slowest = 0;
  slowestName = "";
}
