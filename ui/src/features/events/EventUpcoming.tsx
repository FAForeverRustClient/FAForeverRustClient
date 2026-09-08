// The upcoming list: everything still to come, grouped by day, nearest first.
//
// Not in the issue, and almost certainly the view people will leave the tab on.
// A grid answers "what is on the 14th"; this answers "what is next", which is
// the question somebody opening a client at nine in the evening has.

import { EmptyState } from "../../design-system/EmptyState";
import { useTranslation } from "../../i18n/useTranslation";
import type { CalendarEntry } from "./calendarFeed";
import { hasPassed } from "./calendarFeed";
import { dayOf, parseIsoDay } from "./calendarGrid";
import { EventChip } from "./EventChip";
import { dayTitle } from "./eventPresentation";

interface Props {
  entries: CalendarEntry[];
  now: Date;
  reminded: ReadonlySet<string>;
  onOpen: (entry: CalendarEntry) => void;
}

export function EventUpcoming({ entries, now, reminded, onOpen }: Props) {
  const { t } = useTranslation();
  const seconds = Math.floor(now.getTime() / 1000);
  // Today's entries that are already over stay, at the top and dimmed: the
  // window starts at midnight so that a game night still running is not lost,
  // and dropping the finished ones silently would make the first heading look
  // wrong.
  const groups = new Map<string, CalendarEntry[]>();
  for (const entry of entries) {
    const day = dayOf(entry);
    const existing = groups.get(day);
    if (existing) existing.push(entry);
    else groups.set(day, [entry]);
  }

  if (groups.size === 0) {
    return (
      <EmptyState
        bordered
        icon="calendar"
        title={t("events.upcoming.emptyTitle")}
        hint={t("events.upcoming.emptyHint")}
      />
    );
  }

  return (
    <div className="event-upcoming">
      {[...groups.entries()].map(([day, group]) => {
        const date = parseIsoDay(day);
        return (
          <section className="event-upcoming-day" key={day}>
            <h3>{date ? dayTitle(date) : day}</h3>
            <div className="event-upcoming-entries">
              {group.map((entry) => (
                <EventChip
                  key={entry.id}
                  entry={entry}
                  reminded={reminded.has(entry.id)}
                  onOpen={onOpen}
                  past={hasPassed(entry, seconds)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
