// The figures behind the Statistics tab's Activity part (issue 748), as pure
// functions over the `PlayerActivity` the scan carries.

import type { PlayerActivityMonth } from "../../ipc/bindings";
import { formatDecimal, formatNumber } from "../../i18n";

/**
 * Minutes as hours: one decimal below ten hours, where a tenth is still six
 * minutes worth telling apart, whole hours above.
 */
export function playedHours(minutes: number): string {
  const hours = minutes / 60;
  return hours < 10 ? formatDecimal(Math.round(hours * 10) / 10) : formatNumber(Math.round(hours));
}

/**
 * The queues the hours chart tells apart, in the order they take the chart's
 * colours. A queue keeps its colour whatever else a player has played: the
 * colour follows the queue, never its place in one profile's list.
 */
export const ACTIVITY_QUEUES = [
  "global",
  "ladder_1v1",
  "tmm_2v2",
  "tmm_3v3",
  "tmm_4v4_full_share",
  "tmm_4v4_share_until_death",
] as const;

/** Everything else: co-op, a queue added after this was written. */
export const OTHER_QUEUE = "other";

export type ActivityQueue = (typeof ACTIVITY_QUEUES)[number] | typeof OTHER_QUEUE;

/** Which of the chart's queues a leaderboard name falls under. */
export function activityQueue(queue: string): ActivityQueue {
  return (ACTIVITY_QUEUES as readonly string[]).includes(queue) ? (queue as ActivityQueue) : OTHER_QUEUE;
}

/** The queue's colour: `--color-chart-1` to `-7`, in [`ACTIVITY_QUEUES`] order. */
export function activityQueueColor(queue: ActivityQueue): string {
  const index = (ACTIVITY_QUEUES as readonly string[]).indexOf(queue);
  return `var(--color-chart-${index >= 0 ? index + 1 : ACTIVITY_QUEUES.length + 1})`;
}

/** One bar of the hours chart: a month (`YYYY-MM`) or a year (`YYYY`). */
export interface ActivityBar {
  period: string;
  games: number;
  minutes: number;
  /** Minutes per queue, in [`ACTIVITY_QUEUES`] order, other last; none empty. */
  queues: Array<{ queue: ActivityQueue; minutes: number }>;
}

function bar(period: string, rows: readonly PlayerActivityMonth[]): ActivityBar {
  const byQueue = new Map<ActivityQueue, number>();
  let games = 0;
  let minutes = 0;
  for (const row of rows) {
    games += row.games;
    minutes += row.minutes;
    for (const entry of row.queues) {
      const queue = activityQueue(entry.queue);
      byQueue.set(queue, (byQueue.get(queue) ?? 0) + entry.minutes);
    }
  }
  const order: readonly ActivityQueue[] = [...ACTIVITY_QUEUES, OTHER_QUEUE];
  return {
    period,
    games,
    minutes,
    queues: order
      .filter((queue) => (byQueue.get(queue) ?? 0) > 0)
      .map((queue) => ({ queue, minutes: byQueue.get(queue) ?? 0 })),
  };
}

/** The last `count` months, oldest first. */
export function monthBars(months: readonly PlayerActivityMonth[], count = 24): ActivityBar[] {
  return months.slice(-count).map((month) => bar(month.period, [month]));
}

/** One bar per calendar year, oldest first. */
export function yearBars(months: readonly PlayerActivityMonth[]): ActivityBar[] {
  const years = new Map<string, PlayerActivityMonth[]>();
  for (const month of months) {
    const year = month.period.slice(0, 4);
    years.set(year, [...(years.get(year) ?? []), month]);
  }
  return [...years.entries()].map(([year, rows]) => bar(year, rows));
}

/** The queues that appear in any of `bars`, in colour order: the legend. */
export function queuesIn(bars: readonly ActivityBar[]): ActivityQueue[] {
  const present = new Set<ActivityQueue>(bars.flatMap((entry) => entry.queues.map((part) => part.queue)));
  const order: ActivityQueue[] = [...ACTIVITY_QUEUES, OTHER_QUEUE];
  return order.filter((queue) => present.has(queue));
}

/** The month with the most minutes, the earlier of a tie; `null` with none played. */
export function busiestMonth(months: readonly PlayerActivityMonth[]): PlayerActivityMonth | null {
  let best: PlayerActivityMonth | null = null;
  for (const month of months) {
    if (month.minutes > 0 && (best === null || month.minutes > best.minutes)) best = month;
  }
  return best;
}

/**
 * The scan's UTC week (Monday 00:00 first, 168 hours) moved into the reader's
 * time zone. `offsetMinutes` is east of UTC, `-new Date().getTimezoneOffset()`.
 *
 * Today's offset for every game: a game played in summer time lands an hour
 * off in winter, and a half-hour zone is rounded to the hour. A chart of
 * habits over years does not change shape for either.
 */
export function localWeek(weekUtc: readonly number[], offsetMinutes: number): number[] {
  const hours = 7 * 24;
  if (weekUtc.length !== hours) return new Array<number>(hours).fill(0);
  const shift = Math.round(offsetMinutes / 60);
  const local = new Array<number>(hours).fill(0);
  weekUtc.forEach((minutes, utc) => {
    local[(((utc + shift) % hours) + hours) % hours] += minutes;
  });
  return local;
}

/** A gridline step for hours: the smallest of 1, 2, 5 times a power of ten giving at most four lines. */
export function hourStep(maxHours: number): number {
  if (maxHours <= 0) return 1;
  const rough = maxHours / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  return [1, 2, 5, 10].map((factor) => factor * power).find((step) => step >= rough) ?? 10 * power;
}

/** Whole days from `from` to `to`, both ISO; `null` when either is not a date. */
export function daysBetween(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}
