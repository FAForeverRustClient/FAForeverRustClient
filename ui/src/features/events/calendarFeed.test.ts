import { describe, expect, it } from "vitest";
import type { CalendarEvent, ChangelogRelease, EventsQuery } from "../../ipc/bindings";
import { tourney } from "../tournaments/fixtures";
import {
  buildFeed,
  entriesByDay,
  filterFeed,
  hasPassed,
  occurrences,
  type CalendarEntry,
} from "./calendarFeed";

const HOUR = 3_600;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** The 14th of March 2026, 19:00 UTC. */
const START = Math.floor(Date.UTC(2026, 2, 14, 19, 0, 0) / 1000);

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "cgn",
    title: "Community Game Night",
    summary: "Setons, all welcome.",
    category: "cgn",
    origin: "community",
    host: "Setons Clutch",
    startsAt: START,
    endsAt: 0,
    allDay: false,
    links: [],
    recurrence: null,
    recursUntil: 0,
    ...over,
  };
}

function release(over: Partial<ChangelogRelease> = {}): ChangelogRelease {
  return {
    id: "3837",
    kind: "Game Patch",
    date: "2026-03-14",
    year: "2026",
    sourceUrl: "https://example.invalid/3837.md",
    webUrl: "https://example.invalid/3837",
    ...over,
  };
}

const NO_FILTER: EventsQuery = { text: "", category: null, origin: null, onlyReminders: false };

describe("expanding a recurrence", () => {
  it("gives a one-off entry exactly one occurrence, inside the window", () => {
    expect(occurrences(event(), START - DAY, START + DAY)).toEqual([START]);
    expect(occurrences(event(), START + DAY, START + WEEK)).toEqual([]);
    // The window is half open, so an event exactly on `to` belongs to the next
    // one and is never drawn twice.
    expect(occurrences(event(), START - DAY, START)).toEqual([]);
  });

  it("repeats weekly, and skips the ones before the window", () => {
    const weekly = event({ recurrence: { type: "weekly", payload: { interval: 1 } } });
    expect(occurrences(weekly, START, START + 3 * WEEK)).toEqual([
      START,
      START + WEEK,
      START + 2 * WEEK,
    ]);
    expect(occurrences(weekly, START + WEEK, START + 3 * WEEK)).toEqual([
      START + WEEK,
      START + 2 * WEEK,
    ]);
  });

  it("honours a fortnightly interval", () => {
    const fortnightly = event({ recurrence: { type: "weekly", payload: { interval: 2 } } });
    expect(occurrences(fortnightly, START, START + 5 * WEEK)).toEqual([
      START,
      START + 2 * WEEK,
      START + 4 * WEEK,
    ]);
  });

  it("stops repeating at the stated end", () => {
    const weekly = event({
      recurrence: { type: "weekly", payload: { interval: 1 } },
      recursUntil: START + WEEK,
    });
    expect(occurrences(weekly, START, START + 5 * WEEK)).toEqual([START, START + WEEK]);
  });

  it("repeats monthly on the same date, not every thirty days", () => {
    const monthly = event({
      startsAt: Math.floor(Date.UTC(2026, 0, 31, 12) / 1000),
      recurrence: { type: "monthly" },
    });
    const found = occurrences(monthly, 0, Math.floor(Date.UTC(2026, 4, 1) / 1000));
    expect(found.map((at) => new Date(at * 1000).toISOString().slice(0, 10))).toEqual([
      "2026-01-31",
      // Clamped in February, and back on the 31st in March: every occurrence is
      // computed from the original start, so the clamp does not stick.
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("cannot be made to expand without bound by a broken rule", () => {
    const forever = event({
      recurrence: { type: "weekly", payload: { interval: 1 } },
      recursUntil: Math.floor(Date.UTC(2199, 0, 1) / 1000),
    });
    expect(occurrences(forever, START, Math.floor(Date.UTC(2199, 0, 1) / 1000)).length).toBe(80);
  });

  it("jumps to the window rather than walking to it", () => {
    // Two years of weekly occurrences behind the window is more than the
    // occurrence budget, so a walk would find nothing at all here.
    const weekly = event({ recurrence: { type: "weekly", payload: { interval: 1 } } });
    const from = START + 120 * WEEK;
    expect(occurrences(weekly, from, from + 2 * WEEK)).toEqual([from, from + WEEK]);
  });

  it("jumps to the window for a monthly rule too", () => {
    const monthly = event({
      startsAt: Math.floor(Date.UTC(2020, 0, 15, 12) / 1000),
      recurrence: { type: "monthly" },
    });
    const found = occurrences(
      monthly,
      Math.floor(Date.UTC(2026, 2, 1) / 1000),
      Math.floor(Date.UTC(2026, 3, 1) / 1000),
    );
    expect(found.map((at) => new Date(at * 1000).toISOString().slice(0, 10))).toEqual([
      "2026-03-15",
    ]);
  });

  it("treats a zero interval as weekly rather than looping on the spot", () => {
    const broken = event({ recurrence: { type: "weekly", payload: { interval: 0 } } });
    expect(occurrences(broken, START, START + 2 * WEEK)).toEqual([START, START + WEEK]);
  });
});

describe("building the feed", () => {
  const window = { from: START - WEEK, to: START + WEEK };

  it("merges the three sources, earliest first", () => {
    const feed = buildFeed({
      catalogue: [event()],
      tourneys: [tourney({ id: "t1", name: "Sunday Cup", eventDate: START - HOUR, published: true })],
      releases: [release()],
      ...window,
    });
    expect(feed.map((entry) => entry.id)).toEqual([
      "patch:3837",
      "tourney:t1",
      `catalogue:cgn@${START}`,
    ]);
  });

  it("reads a tournament's official flag rather than guessing at it", () => {
    const feed = buildFeed({
      catalogue: [],
      tourneys: [
        tourney({ id: "t1", name: "FAF Cup", eventDate: START, category: "official", published: true }),
        tourney({ id: "t2", name: "Dojo Cup", eventDate: START, category: "community", published: true }),
      ],
      releases: [],
      ...window,
    });
    // Keyed rather than positional: both start at the same moment, so the feed
    // orders them by title and "Dojo Cup" comes first.
    expect(new Map(feed.map((entry) => [entry.id, entry.origin]))).toEqual(
      new Map([
        ["tourney:t1", "official"],
        ["tourney:t2", "community"],
      ]),
    );
  });

  it("leaves out a tournament nobody can see yet, and one that was called off", () => {
    const feed = buildFeed({
      catalogue: [],
      tourneys: [
        tourney({ id: "draft", eventDate: START, published: false }),
        tourney({ id: "off", eventDate: START, published: true, abandoned: true }),
        tourney({ id: "on", eventDate: START, published: true }),
      ],
      releases: [],
      ...window,
    });
    expect(feed.map((entry) => entry.id)).toEqual(["tourney:on"]);
  });

  it("leaves out a tournament with no date and the rolling changelog branches", () => {
    const feed = buildFeed({
      catalogue: [],
      tourneys: [tourney({ id: "t1", eventDate: null, published: true })],
      releases: [release({ id: "fafdevelop", date: "", year: "" })],
      ...window,
    });
    expect(feed).toEqual([]);
  });

  it("gives a repeat its own occurrence key and keeps its length", () => {
    const feed = buildFeed({
      catalogue: [
        event({
          endsAt: START + 3 * HOUR,
          recurrence: { type: "weekly", payload: { interval: 1 } },
        }),
      ],
      tourneys: [],
      releases: [],
      from: START,
      to: START + 2 * WEEK,
    });
    expect(feed.map((entry) => entry.id)).toEqual([
      `catalogue:cgn@${START}`,
      `catalogue:cgn@${START + WEEK}`,
    ]);
    expect(feed[1].endsAt).toBe(START + WEEK + 3 * HOUR);
  });
});

describe("filtering the feed", () => {
  const feed = buildFeed({
    catalogue: [event(), event({ id: "meet", title: "London meetup", category: "meetup", host: "wlsn" })],
    tourneys: [tourney({ id: "t1", name: "Sunday Cup", eventDate: START, published: true })],
    releases: [release()],
    from: START - WEEK,
    to: START + WEEK,
  });

  it("shows everything with no filter set", () => {
    expect(filterFeed(feed, NO_FILTER, new Set()).length).toBe(feed.length);
  });

  it("filters by category and by who runs it", () => {
    expect(filterFeed(feed, { ...NO_FILTER, category: "meetup" }, new Set()).map((e) => e.id)).toEqual([
      `catalogue:meet@${START}`,
    ]);
    expect(filterFeed(feed, { ...NO_FILTER, origin: "official" }, new Set()).map((e) => e.id)).toEqual([
      "patch:3837",
    ]);
  });

  it("matches free text against the title, the host and the summary", () => {
    expect(filterFeed(feed, { ...NO_FILTER, text: "sunday" }, new Set()).map((e) => e.id)).toEqual([
      "tourney:t1",
    ]);
    expect(filterFeed(feed, { ...NO_FILTER, text: "WLSN" }, new Set()).map((e) => e.id)).toEqual([
      `catalogue:meet@${START}`,
    ]);
    expect(filterFeed(feed, { ...NO_FILTER, text: "setons" }, new Set()).length).toBe(2);
  });

  it("shows only what a reminder is set on, which is the my-events filter", () => {
    const reminded = new Set(["tourney:t1"]);
    expect(
      filterFeed(feed, { ...NO_FILTER, onlyReminders: true }, reminded).map((e) => e.id),
    ).toEqual(["tourney:t1"]);
    expect(filterFeed(feed, { ...NO_FILTER, onlyReminders: true }, new Set())).toEqual([]);
  });
});

describe("grouping and expiry", () => {
  it("buckets entries by the day they are drawn on", () => {
    const feed = buildFeed({
      catalogue: [event(), event({ id: "next", startsAt: START + DAY })],
      tourneys: [],
      releases: [],
      from: START - WEEK,
      to: START + WEEK,
    });
    const days = entriesByDay(feed);
    expect([...days.keys()].length).toBe(2);
    expect([...days.values()].every((entries) => entries.length === 1)).toBe(true);
  });

  it("treats an entry with no stated end as an hour long", () => {
    const entry = { startsAt: START, endsAt: 0, allDay: false } as CalendarEntry;
    expect(hasPassed(entry, START + 30 * 60)).toBe(false);
    expect(hasPassed(entry, START + HOUR)).toBe(true);
  });

  it("respects a stated end", () => {
    const entry = { startsAt: START, endsAt: START + 4 * HOUR, allDay: false } as CalendarEntry;
    expect(hasPassed(entry, START + 3 * HOUR)).toBe(false);
    expect(hasPassed(entry, START + 4 * HOUR)).toBe(true);
  });

  it("keeps an all-day entry until the end of its day, read in UTC", () => {
    const midnight = Math.floor(Date.UTC(2026, 2, 14) / 1000);
    const entry = { startsAt: midnight, endsAt: 0, allDay: true } as CalendarEntry;
    expect(hasPassed(entry, midnight + 23 * HOUR)).toBe(false);
    expect(hasPassed(entry, midnight + DAY)).toBe(true);
  });
});
