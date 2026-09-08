// The month grid: six weeks of squares, each holding its day's entries.
//
// Six rows always, so nothing under the grid moves when the month changes.
// A square that overflows says how many it is hiding rather than growing, and
// clicking the day opens it in the week view, which has the room.

import { useTranslation } from "../../i18n/useTranslation";
import type { CalendarEntry } from "./calendarFeed";
import { isoDay, monthGrid, sameDay } from "./calendarGrid";
import { EventChip } from "./EventChip";
import { weekdayNames } from "./eventPresentation";
import type { WeekStart } from "../../ipc/bindings";

/**
 * Chips one square draws before it starts counting the rest.
 *
 * Three fits the row height at the client's usual window size. The fourth is
 * replaced by "+2 more", which is what a reader needs to know is there.
 */
const CHIPS_PER_DAY = 3;

interface Props {
  anchor: Date;
  now: Date;
  weekStart: WeekStart;
  byDay: Map<string, CalendarEntry[]>;
  reminded: ReadonlySet<string>;
  onOpen: (entry: CalendarEntry) => void;
  onOpenDay: (day: Date) => void;
}

export function EventMonth({
  anchor,
  now,
  weekStart,
  byDay,
  reminded,
  onOpen,
  onOpenDay,
}: Props) {
  const { t } = useTranslation();
  const squares = monthGrid(anchor, weekStart);
  const names = weekdayNames(weekStart);

  return (
    <div className="event-month">
      <div className="event-month-head" aria-hidden="true">
        {names.map((name) => (
          <span key={name}>{name}</span>
        ))}
      </div>
      <div className="event-month-grid">
        {squares.map((day) => {
          const key = isoDay(day);
          const entries = byDay.get(key) ?? [];
          const outside = day.getMonth() !== anchor.getMonth();
          const today = sameDay(day, now);
          const classes = [
            "event-day",
            outside ? "is-outside" : "",
            today ? "is-today" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const hidden = entries.length - CHIPS_PER_DAY;
          return (
            <div className={classes} key={key}>
              <button
                type="button"
                className="event-day-number"
                onClick={() => onOpenDay(day)}
                aria-label={t("events.openDay", { day: key })}
              >
                {day.getDate()}
              </button>
              <div className="event-day-entries">
                {entries.slice(0, CHIPS_PER_DAY).map((entry) => (
                  <EventChip
                    key={entry.id}
                    entry={entry}
                    reminded={reminded.has(entry.id)}
                    onOpen={onOpen}
                  />
                ))}
                {hidden > 0 && (
                  <button
                    type="button"
                    className="event-day-more"
                    onClick={() => onOpenDay(day)}
                  >
                    {t("events.moreOnDay", { count: hidden })}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
