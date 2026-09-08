// The week view: seven day columns, each a list in time order.
//
// Not an hour grid. An hour grid is the right shape for a diary with six
// overlapping meetings a day; FAF's week is a game night, a tournament and a
// patch, and drawing them as slivers against a 24-hour ruler would make three
// entries hard to read. Each column is the day's list, with the time on every
// row, which is the same information without the ruler.

import { useTranslation } from "../../i18n/useTranslation";
import type { WeekStart } from "../../ipc/bindings";
import type { CalendarEntry } from "./calendarFeed";
import { isoDay, sameDay, weekDays } from "./calendarGrid";
import { EventChip } from "./EventChip";
import { weekdayNames } from "./eventPresentation";

interface Props {
  anchor: Date;
  now: Date;
  weekStart: WeekStart;
  byDay: Map<string, CalendarEntry[]>;
  reminded: ReadonlySet<string>;
  onOpen: (entry: CalendarEntry) => void;
}

export function EventWeek({ anchor, now, weekStart, byDay, reminded, onOpen }: Props) {
  const { t } = useTranslation();
  const days = weekDays(anchor, weekStart);
  const names = weekdayNames(weekStart);

  return (
    <div className="event-week">
      {days.map((day, index) => {
        const key = isoDay(day);
        const entries = byDay.get(key) ?? [];
        const classes = ["event-week-day", sameDay(day, now) ? "is-today" : ""]
          .filter(Boolean)
          .join(" ");
        return (
          <section className={classes} key={key} aria-label={key}>
            <header>
              <span className="event-week-weekday">{names[index]}</span>
              <span className="event-week-date">{day.getDate()}</span>
            </header>
            <div className="event-week-entries">
              {entries.length === 0 ? (
                <p className="event-week-empty">{t("events.week.nothing")}</p>
              ) : (
                entries.map((entry) => (
                  <EventChip
                    key={entry.id}
                    entry={entry}
                    reminded={reminded.has(entry.id)}
                    onOpen={onOpen}
                  />
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
