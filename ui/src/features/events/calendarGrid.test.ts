import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  dayOf,
  isoDay,
  isoDayUtc,
  monthGrid,
  parseIsoDay,
  resolveAnchor,
  sameDay,
  viewWindow,
  weekDays,
  weekdayOffset,
} from "./calendarGrid";

// Every date here is built with the local `Date` constructor and read back with
// local getters, so these assertions hold in any zone the tests are run in.
// The UTC cases are stated as UTC on purpose: that is the distinction the
// all-day rule turns on.

describe("reading a day off a date", () => {
  it("pads the month and the day", () => {
    expect(isoDay(new Date(2026, 2, 1))).toBe("2026-03-01");
    expect(isoDay(new Date(2026, 11, 25))).toBe("2026-12-25");
  });

  it("reads an all-day entry in UTC and a timed one locally", () => {
    // Midnight UTC on the 14th. As a date it is the 14th everywhere, which is
    // what a patch release means; as a moment it is the 13th in New York.
    const midnightUtc = Math.floor(Date.UTC(2026, 2, 14) / 1000);
    expect(dayOf({ startsAt: midnightUtc, allDay: true })).toBe("2026-03-14");

    const localEvening = Math.floor(new Date(2026, 2, 14, 19, 0, 0).getTime() / 1000);
    expect(dayOf({ startsAt: localEvening, allDay: false })).toBe("2026-03-14");
  });

  it("reads a UTC day without going through the local zone", () => {
    expect(isoDayUtc(Math.floor(Date.UTC(2026, 0, 1) / 1000))).toBe("2026-01-01");
  });
});

describe("parsing an anchor", () => {
  it("accepts an ISO day and rejects anything else", () => {
    expect(isoDay(parseIsoDay("2026-03-14")!)).toBe("2026-03-14");
    expect(parseIsoDay("")).toBeNull();
    expect(parseIsoDay("14.03.2026")).toBeNull();
    expect(parseIsoDay("2026-3-14")).toBeNull();
  });

  it("rejects a day that does not exist rather than rolling over", () => {
    // `new Date(2026, 1, 31)` is the 3rd of March, which would silently anchor
    // the calendar on a month nobody asked for.
    expect(parseIsoDay("2026-02-31")).toBeNull();
  });

  it("falls back to today, which is what the empty anchor means", () => {
    const now = new Date(2026, 8, 8, 14, 30);
    expect(isoDay(resolveAnchor("", now))).toBe("2026-09-08");
    expect(isoDay(resolveAnchor("nonsense", now))).toBe("2026-09-08");
    expect(isoDay(resolveAnchor("2026-03-14", now))).toBe("2026-03-14");
  });
});

describe("week arithmetic", () => {
  it("counts the offset from the configured first day", () => {
    const sunday = new Date(2026, 2, 8);
    const monday = new Date(2026, 2, 9);
    expect(sunday.getDay()).toBe(0);
    expect(weekdayOffset(sunday, "monday")).toBe(6);
    expect(weekdayOffset(sunday, "sunday")).toBe(0);
    expect(weekdayOffset(monday, "monday")).toBe(0);
    expect(weekdayOffset(monday, "sunday")).toBe(1);
  });

  it("starts the week on the configured day", () => {
    const wednesday = new Date(2026, 2, 11);
    expect(weekDays(wednesday, "monday").map(isoDay)[0]).toBe("2026-03-09");
    expect(weekDays(wednesday, "sunday").map(isoDay)[0]).toBe("2026-03-08");
    expect(weekDays(wednesday, "monday")).toHaveLength(7);
  });

  it("crosses a month end", () => {
    expect(isoDay(addDays(new Date(2026, 1, 27), 3))).toBe("2026-03-02");
  });
});

describe("month arithmetic", () => {
  it("is always six whole weeks, starting on the configured day", () => {
    const squares = monthGrid(new Date(2026, 2, 14), "monday");
    expect(squares).toHaveLength(42);
    expect(isoDay(squares[0])).toBe("2026-02-23");
    expect(isoDay(squares[41])).toBe("2026-04-05");
  });

  it("does not skip a month when paging from a 31st", () => {
    // The bug plain `setMonth` has: the 31st of March plus one month is the 1st
    // of May, so April never appears.
    expect(isoDay(addMonths(new Date(2026, 2, 31), 1))).toBe("2026-04-30");
    expect(isoDay(addMonths(new Date(2026, 2, 31), -1))).toBe("2026-02-28");
    expect(isoDay(addMonths(new Date(2026, 0, 15), -1))).toBe("2025-12-15");
  });

  it("knows when two dates are the same day", () => {
    expect(sameDay(new Date(2026, 2, 14, 1), new Date(2026, 2, 14, 23))).toBe(true);
    expect(sameDay(new Date(2026, 2, 14), new Date(2026, 2, 15))).toBe(false);
  });
});

describe("the window a view covers", () => {
  const now = new Date(2026, 8, 8, 14, 30);

  it("covers exactly the week on screen", () => {
    const { from, to } = viewWindow("week", new Date(2026, 2, 11), "monday", now);
    expect(from).toBe(Math.floor(new Date(2026, 2, 9).getTime() / 1000));
    expect(to).toBe(Math.floor(new Date(2026, 2, 16).getTime() / 1000));
  });

  it("covers the whole grid, not the whole month", () => {
    // The grid shows the tail of February and the start of April, and an event
    // on one of those squares has to be found.
    const { from, to } = viewWindow("month", new Date(2026, 2, 14), "monday", now);
    expect(from).toBe(Math.floor(new Date(2026, 1, 23).getTime() / 1000));
    expect(to).toBe(Math.floor(new Date(2026, 3, 6).getTime() / 1000));
  });

  it("starts upcoming at the beginning of today, not at this minute", () => {
    // So something that started this morning and is still running does not
    // vanish off the top of the list.
    const { from, to } = viewWindow("upcoming", new Date(2026, 2, 14), "monday", now);
    expect(from).toBe(Math.floor(new Date(2026, 8, 8).getTime() / 1000));
    expect(to).toBeGreaterThan(from);
  });
});
