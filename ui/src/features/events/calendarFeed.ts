// The calendar feed: three sources merged into one list of occurrences.
//
// Why this is here rather than in Rust. The merge has exactly one consumer,
// which is the view: nothing in the backend has a reason to know that a
// tournament and a patch note belong on the same grid. Two of the three sources
// are also slices another tab owns and loads on its own schedule, so a feed
// composed once in a service would be stale the moment the Tournaments tab
// finished loading. Computed on render from mirrored state, it cannot be.
//
// It is still a rule, so it is a pure function with tests rather than something
// spread through components: `libraryGroups`, `coopScenarios` and
// `galacticWarRing` are the same shape.

import type {
  CalendarEvent,
  ChangelogRelease,
  EventCategory,
  EventLink,
  EventOrigin,
  EventsQuery,
  Recurrence,
  Tourney,
} from "../../ipc/bindings";

import { dayOf, isoDayUtc } from "./calendarGrid";

/** Where an occurrence came from, and what the client can do about it. */
export type EntrySource =
  | { kind: "catalogue"; eventId: string }
  | { kind: "tourney"; tourneyId: string }
  | { kind: "patch"; releaseId: string };

/** One thing on the calendar, at one moment. */
export interface CalendarEntry {
  /**
   * The occurrence key. Stable across loads and independent of the reader's
   * zone, because reminders are stored against it: `catalogue:<id>@<start>`,
   * `tourney:<id>`, `patch:<id>`.
   */
  id: string;
  title: string;
  summary: string;
  category: EventCategory;
  origin: EventOrigin;
  host: string;
  /** Unix seconds, UTC. */
  startsAt: number;
  /** Unix seconds, or 0 when nothing said. */
  endsAt: number;
  allDay: boolean;
  links: EventLink[];
  source: EntrySource;
}

/**
 * How many occurrences one recurring entry may contribute to one window.
 *
 * A guard, not a policy: a document that says "every week" with an interval
 * this client read as 1 and an end date in 2199 must not turn one entry into
 * ten thousand squares. The largest window this code asks for is a year, so
 * anything past a weekly year is a broken rule.
 */
const MAX_OCCURRENCES = 80;

/**
 * Unix seconds of a UTC calendar date shifted by whole months.
 *
 * The day is clamped to the end of the target month, so a rule anchored on the
 * 31st lands on the 30th in April rather than skipping to the 1st of May and
 * losing a month, which is what plain month arithmetic does.
 */
function addUtcMonths(seconds: number, months: number): number {
  const date = new Date(seconds * 1000);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  // Day 0 of the following month is the last day of this one.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.floor(
    Date.UTC(
      year,
      month,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
    ) / 1000,
  );
}

/**
 * Every start of one catalogue entry that falls inside `[from, to)`.
 *
 * Recurrence is expanded in UTC, by exact weeks and by whole calendar months.
 * That means a weekly event keeps its UTC instant across a daylight-saving
 * change and therefore moves by an hour in local time. That is a real
 * limitation and the honest one: the document says when the event is, in UTC,
 * and nothing in it says which zone the organiser meant to hold it fixed in.
 *
 * Every occurrence is computed from the original start rather than from the one
 * before it, which is what makes the monthly clamp non-sticky: a rule anchored
 * on the 31st is the 28th in February and the 31st again in March, instead of
 * staying on the 28th for the rest of the year.
 *
 * The window is jumped to rather than walked to. A game night that has run
 * weekly for two years, looked at next month, would otherwise spend the
 * occurrence budget below on occurrences nobody asked to see.
 */
export function occurrences(event: CalendarEvent, from: number, to: number): number[] {
  const rule: Recurrence | null = event.recurrence;
  if (!rule) return event.startsAt >= from && event.startsAt < to ? [event.startsAt] : [];

  const limit = event.recursUntil > 0 ? Math.min(to, event.recursUntil + 1) : to;
  const found: number[] = [];
  const first = firstIndexAtOrAfter(event.startsAt, rule, from);
  for (let index = first; index < first + MAX_OCCURRENCES; index += 1) {
    const at = occurrenceAt(event.startsAt, rule, index);
    if (at >= limit) break;
    if (at >= from) found.push(at);
  }
  return found;
}

/** Seconds in a week, for the weekly rule. */
const WEEK_SECONDS = 7 * 24 * 60 * 60;

/** The `index`th occurrence of a rule, counting the first as zero. */
function occurrenceAt(startsAt: number, rule: Recurrence, index: number): number {
  return rule.type === "weekly"
    ? startsAt + index * Math.max(1, rule.payload.interval) * WEEK_SECONDS
    : addUtcMonths(startsAt, index);
}

/**
 * The first index worth looking at: a lower bound, never past the answer.
 *
 * For months it is the plain month difference, which can be one short when the
 * day of the month falls earlier than the window's first day. The loop above
 * skips those, so being conservative here is free and being clever would not
 * be.
 */
function firstIndexAtOrAfter(startsAt: number, rule: Recurrence, from: number): number {
  if (from <= startsAt) return 0;
  if (rule.type === "weekly") {
    const step = Math.max(1, rule.payload.interval) * WEEK_SECONDS;
    return Math.floor((from - startsAt) / step);
  }
  const start = new Date(startsAt * 1000);
  const target = new Date(from * 1000);
  const months =
    (target.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (target.getUTCMonth() - start.getUTCMonth());
  return Math.max(0, months);
}

/** The catalogue's own entries, expanded over the window. */
function catalogueEntries(catalogue: CalendarEvent[], from: number, to: number): CalendarEntry[] {
  return catalogue.flatMap((event) =>
    occurrences(event, from, to).map((startsAt) => ({
      id: `catalogue:${event.id}@${startsAt}`,
      title: event.title,
      summary: event.summary,
      category: event.category,
      origin: event.origin,
      host: event.host,
      startsAt,
      // A repeat keeps the length of the first occurrence rather than its end
      // date, which would put every later one in the past.
      endsAt: event.endsAt > event.startsAt ? startsAt + (event.endsAt - event.startsAt) : 0,
      allDay: event.allDay,
      links: event.links,
      source: { kind: "catalogue" as const, eventId: event.id },
    })),
  );
}

/**
 * Tournaments, out of the slice the Tournaments tab already fills.
 *
 * Only the event date. The signup and check-in windows are on the tournament's
 * own page, and putting three squares on the calendar for one tournament would
 * bury everything else in a busy month.
 *
 * `category` is the service's own official/community flag, which is exactly the
 * distinction the issue asked to draw, so it is read rather than guessed at.
 */
function tourneyEntries(tourneys: Tourney[], from: number, to: number): CalendarEntry[] {
  return tourneys
    .filter((tourney) => tourney.published && !tourney.abandoned)
    .flatMap((tourney) => {
      const startsAt = tourney.eventDate ?? 0;
      if (startsAt < from || startsAt >= to) return [];
      return [
        {
          id: `tourney:${tourney.id}`,
          title: tourney.name,
          summary: "",
          category: "tournament" as const,
          // The service's own two values are the same two this calendar draws,
          // so they are passed through rather than mapped. Should the service
          // ever grow a third, this is a type error rather than a silent
          // "community".
          origin: tourney.category,
          // The series it belongs to, where it belongs to one ("FAF Cup"), and
          // empty otherwise. The organisers are account ids on this row rather
          // than names, so they are not something to print.
          host: tourney.seriesName,
          startsAt,
          endsAt: 0,
          allDay: false,
          links: [],
          source: { kind: "tourney" as const, tourneyId: tourney.id },
        },
      ];
    });
}

/**
 * Released patches, out of the changelog index.
 *
 * Dated releases only: the two rolling branch entries have no date at all and
 * are not events. All-day, because a release is a date and not a moment.
 */
function patchEntries(releases: ChangelogRelease[], from: number, to: number): CalendarEntry[] {
  return releases.flatMap((release) => {
    if (!release.date) return [];
    const startsAt = Math.floor(Date.parse(`${release.date}T00:00:00Z`) / 1000);
    if (Number.isNaN(startsAt) || startsAt < from || startsAt >= to) return [];
    return [
      {
        id: `patch:${release.id}`,
        title: `${release.kind} ${release.id}`,
        summary: "",
        category: "patch" as const,
        origin: "official" as const,
        host: "FAForever",
        startsAt,
        endsAt: 0,
        allDay: true,
        links: [],
        source: { kind: "patch" as const, releaseId: release.id },
      },
    ];
  });
}

/**
 * Everything on the calendar inside one window, earliest first.
 *
 * Ties are broken by title so the order of a day's entries does not depend on
 * which source answered first.
 */
export function buildFeed(input: {
  catalogue: CalendarEvent[];
  tourneys: Tourney[];
  releases: ChangelogRelease[];
  from: number;
  to: number;
}): CalendarEntry[] {
  const { catalogue, tourneys, releases, from, to } = input;
  return [
    ...catalogueEntries(catalogue, from, to),
    ...tourneyEntries(tourneys, from, to),
    ...patchEntries(releases, from, to),
  ].sort((left, right) =>
    left.startsAt === right.startsAt
      ? left.title.localeCompare(right.title)
      : left.startsAt - right.startsAt,
  );
}

/** Apply the tab's filters. `reminded` is the set of occurrence keys watched. */
export function filterFeed(
  entries: CalendarEntry[],
  query: EventsQuery,
  reminded: ReadonlySet<string>,
): CalendarEntry[] {
  const text = query.text.trim().toLowerCase();
  return entries.filter((entry) => {
    if (query.category && entry.category !== query.category) return false;
    if (query.origin && entry.origin !== query.origin) return false;
    if (query.onlyReminders && !reminded.has(entry.id)) return false;
    if (!text) return true;
    return (
      entry.title.toLowerCase().includes(text) ||
      entry.host.toLowerCase().includes(text) ||
      entry.summary.toLowerCase().includes(text)
    );
  });
}

/** The entries of each local day, keyed by ISO date, for the grid views. */
export function entriesByDay(entries: CalendarEntry[]): Map<string, CalendarEntry[]> {
  const days = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    const day = dayOf(entry);
    const existing = days.get(day);
    if (existing) existing.push(entry);
    else days.set(day, [entry]);
  }
  return days;
}

/**
 * Whether an occurrence is over.
 *
 * An entry with a stated end is over when that passes. One without is treated
 * as over an hour after it starts, which is the shortest thing on this calendar
 * and stops "upcoming" leading with a game night that began this morning. An
 * all-day entry is over at the end of its day, read in UTC like the rest of it.
 */
export function hasPassed(entry: CalendarEntry, now: number): boolean {
  if (entry.allDay) {
    return now >= Math.floor(Date.parse(`${isoDayUtc(entry.startsAt)}T00:00:00Z`) / 1000) + 86_400;
  }
  const ends = entry.endsAt > entry.startsAt ? entry.endsAt : entry.startsAt + 3_600;
  return now >= ends;
}
