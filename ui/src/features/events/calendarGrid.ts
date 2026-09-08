// Calendar arithmetic: which days a view covers, and which day a thing is on.
//
// All of it in the reader's own zone, because that is what a calendar is. The
// events themselves are Unix seconds in UTC, which is the only sane way to
// carry a moment, and this module is the one place that turns them back into
// days somebody recognises.
//
// The one thing to keep straight in here: an all-day entry is not a moment.
// It is stored as midnight UTC and it means a *date*, so it is read back in
// UTC. Reading it locally is how "the patch landed on the 14th" becomes the
// 13th for everybody west of Greenwich.

import type { WeekStart } from "../../ipc/bindings";

/** Days per week, named because the arithmetic below reads better with it. */
const WEEK = 7;

/** ISO `YYYY-MM-DD` for a date, in whatever zone the date is being read in. */
export function isoDay(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** ISO `YYYY-MM-DD` of a Unix second, read as a date in UTC. */
export function isoDayUtc(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * The local day one entry belongs on.
 *
 * Timed entries follow the reader: a game night at 23:30 UTC is tomorrow in
 * Moscow, and putting it on today's square there would be wrong. All-day
 * entries do not, for the reason at the top of this file.
 */
export function dayOf(entry: { startsAt: number; allDay: boolean }): string {
  return entry.allDay ? isoDayUtc(entry.startsAt) : isoDay(new Date(entry.startsAt * 1000));
}

/** Parse ISO `YYYY-MM-DD` into local midnight, or `null` if it is not one. */
export function parseIsoDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  // Rejects the 31st of February rather than silently landing in March.
  return date.getMonth() === Number(month) - 1 && date.getDate() === Number(day) ? date : null;
}

/**
 * The day the view is drawn around.
 *
 * An empty or unreadable anchor is today, which is what the slice's empty
 * string means: a client left open overnight opens on the right month in the
 * morning rather than on the one it was started in.
 */
export function resolveAnchor(anchor: string, now: Date): Date {
  return parseIsoDay(anchor) ?? new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** How far into the week a date is, counting from the configured first day. */
export function weekdayOffset(date: Date, weekStart: WeekStart): number {
  const sundayBased = date.getDay();
  return weekStart === "sunday" ? sundayBased : (sundayBased + 6) % WEEK;
}

/** Local midnight `days` after `date`. Handles month ends and DST. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * Local midnight `months` after `date`, clamped to the end of the month.
 *
 * The clamp is the whole reason this is not `setMonth`: the 31st of March plus
 * one month is `setMonth`'s 1st of May, so paging forward from a 31st skips a
 * month entirely.
 */
export function addMonths(date: Date, months: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), lastDay));
}

/** The seven days of the week containing `date`. */
export function weekDays(date: Date, weekStart: WeekStart): Date[] {
  const first = addDays(date, -weekdayOffset(date, weekStart));
  return Array.from({ length: WEEK }, (_, index) => addDays(first, index));
}

/**
 * The squares of the month grid containing `date`: whole weeks, six of them.
 *
 * Always six rows rather than as many as the month needs. A grid that changes
 * height between February and August makes everything under it jump, and the
 * six-row grid is what every calendar the players already use looks like.
 */
export function monthGrid(date: Date, weekStart: WeekStart): Date[] {
  const firstOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
  const first = addDays(firstOfMonth, -weekdayOffset(firstOfMonth, weekStart));
  return Array.from({ length: 6 * WEEK }, (_, index) => addDays(first, index));
}

/** Whether two dates are the same local day. */
export function sameDay(left: Date, right: Date): boolean {
  return isoDay(left) === isoDay(right);
}

/**
 * The window a view covers, in Unix seconds, as `[from, to)`.
 *
 * This is what bounds recurrence expansion: a weekly game night with no end
 * date would otherwise expand forever. The upcoming list gets a year, which is
 * further ahead than anything in FAF is ever announced.
 */
export function viewWindow(
  view: "month" | "week" | "upcoming",
  anchor: Date,
  weekStart: WeekStart,
  now: Date,
): { from: number; to: number } {
  const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
  if (view === "week") {
    const days = weekDays(anchor, weekStart);
    return { from: seconds(days[0]), to: seconds(addDays(days[6], 1)) };
  }
  if (view === "month") {
    const squares = monthGrid(anchor, weekStart);
    return { from: seconds(squares[0]), to: seconds(addDays(squares[squares.length - 1], 1)) };
  }
  // Upcoming starts at the beginning of today rather than at this minute, so
  // something that started an hour ago and is still running does not vanish
  // off the top of the list.
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { from: seconds(today), to: seconds(addDays(today, 366)) };
}
