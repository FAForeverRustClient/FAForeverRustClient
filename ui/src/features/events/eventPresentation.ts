// How a calendar entry is worded and dated on screen.
//
// Every date here goes through `clientIntlTag()`, so the calendar follows the
// language the player picked rather than the language of the machine, and every
// time is rendered in the operating system's zone. That is the whole of the
// issue's "start times automatically converted to my time zone": the client
// already knows where the player is, and a timezone setting would be one more
// thing that can be set wrong.

import type { EventCategory, EventOrigin, WeekStart } from "../../ipc/bindings";
import { clientIntlTag, formatTime } from "../../shared/dates";
import type { MessageKey } from "../../i18n";
import type { CalendarEntry } from "./calendarFeed";
import { addDays, weekDays } from "./calendarGrid";

/** The label key for one category. */
export function categoryLabel(category: EventCategory): MessageKey {
  return `events.category.${category}`;
}

/** The label key for one origin. */
export function originLabel(origin: EventOrigin): MessageKey {
  return `events.origin.${origin}`;
}

/** Every category, in the order the filter offers them. */
export const CATEGORIES: EventCategory[] = [
  "tournament",
  "cgn",
  "meetup",
  "patch",
  "ladderPool",
  "other",
];

/**
 * The lead times a reminder can be set to, in minutes.
 *
 * The issue asked for a week and a day. The two shorter ones are what somebody
 * setting a reminder on the morning of the event wants, and a reminder whose
 * lead time is already past is raised on the next tick rather than never, so
 * offering them costs nothing.
 */
export const LEAD_TIMES: number[] = [7 * 24 * 60, 24 * 60, 2 * 60, 15];

/** The label key for one lead time. */
export function leadLabel(minutes: number): MessageKey {
  switch (minutes) {
    case 7 * 24 * 60:
      return "events.lead.week";
    case 24 * 60:
      return "events.lead.day";
    case 2 * 60:
      return "events.lead.hours";
    default:
      return "events.lead.minutes";
  }
}

/** "March 2026", for the month view's heading. */
export function monthTitle(anchor: Date): string {
  return anchor.toLocaleDateString(clientIntlTag(), { month: "long", year: "numeric" });
}

/**
 * "9 - 15 March 2026", for the week view's heading.
 *
 * Written out rather than as a week number: FAF talks about weekends, not about
 * week 11.
 */
export function weekTitle(anchor: Date, weekStart: WeekStart): string {
  const days = weekDays(anchor, weekStart);
  const first = days[0];
  const last = days[6];
  const sameMonth = first.getMonth() === last.getMonth();
  const from = first.toLocaleDateString(clientIntlTag(), {
    day: "numeric",
    month: sameMonth ? undefined : "short",
  });
  const to = last.toLocaleDateString(clientIntlTag(), {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${from} - ${to}`;
}

/** The seven weekday names, starting on the configured day. */
export function weekdayNames(weekStart: WeekStart): string[] {
  // Any known week works as the source of the names; this one starts on a
  // Sunday, so the offset below picks the configured first day out of it.
  const sunday = new Date(2026, 2, 8);
  return Array.from({ length: 7 }, (_, index) =>
    addDays(sunday, weekStart === "sunday" ? index : index + 1).toLocaleDateString(
      clientIntlTag(),
      { weekday: "short" },
    ),
  );
}

/** The day heading in the week view and the upcoming list. */
export function dayTitle(date: Date): string {
  return date.toLocaleDateString(clientIntlTag(), {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/**
 * The time an entry is drawn with, or an empty string for an all-day one.
 *
 * An entry with a stated end shows both ends, which is what a game night wants:
 * "19:00 - 23:00" says whether it is worth joining at ten.
 */
export function entryTime(entry: CalendarEntry): string {
  if (entry.allDay) return "";
  const start = formatTime(entry.startsAt * 1000, "");
  if (entry.endsAt <= entry.startsAt) return start;
  return `${start} - ${formatTime(entry.endsAt * 1000, "")}`;
}

/** The reader's own zone, named, so the times above are unambiguous. */
export function localZoneName(): string {
  try {
    return new Intl.DateTimeFormat(clientIntlTag(), { timeZoneName: "short" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    // A runtime without the zone name is not a reason to draw no calendar.
    return "";
  }
}
