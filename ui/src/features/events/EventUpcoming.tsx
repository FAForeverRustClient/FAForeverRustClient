// The upcoming list: everything still to come, grouped by day, nearest first.
//
// Not in the issue, and almost certainly the view people will leave the tab on.
// A grid answers "what is on the 14th"; this answers "what is next", which is
// the question somebody opening a client at nine in the evening has.
//
// Drawn as an agenda: one ruled panel, the date in a column of its own on the
// left, the day's entries as rows beside it. Separate grey bars per entry were
// mostly empty grey on a wide window, and a heading per day repeated the same
// shape all the way down; a date column lets the eye run down the days and the
// rows carry what the bar had no room for, the category and who runs it.

import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import type { CalendarEntry } from "./calendarFeed";
import { hasPassed } from "./calendarFeed";
import { dayOf, parseIsoDay, sameDay } from "./calendarGrid";
import {
  categoryLabel,
  dayTitle,
  entryTime,
  monthShort,
  relativeDay,
  weekdayShort,
} from "./eventPresentation";

interface Props {
  entries: CalendarEntry[];
  now: Date;
  reminded: ReadonlySet<string>;
  selected: string | null;
  /** Whether a filter is narrowing the list, which changes what empty means. */
  filtered: boolean;
  onClearFilters: () => void;
  onOpen: (entry: CalendarEntry) => void;
  /** Whether the catalogue has answered; until then an empty list says nothing. */
  settled: boolean;
}

export function EventUpcoming({
  entries,
  now,
  reminded,
  selected,
  filtered,
  onClearFilters,
  onOpen,
  settled,
}: Props) {
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
    // The loading line above the list speaks for this case.
    if (!settled) return null;
    // "Nothing coming up" would be wrong while a filter is hiding things:
    // say it is the filter, and offer the way back.
    return filtered ? (
      <EmptyState bordered icon="filter" title={t("events.emptyFiltered")}>
        <Button onClick={onClearFilters}>{t("events.filter.clear")}</Button>
      </EmptyState>
    ) : (
      <EmptyState
        bordered
        icon="calendar"
        title={t("events.upcoming.emptyTitle")}
        hint={t("events.upcoming.emptyHint")}
      />
    );
  }

  return (
    <div className="event-agenda">
      {[...groups.entries()].map(([day, group]) => {
        const date = parseIsoDay(day);
        const relative = date ? relativeDay(date, now) : "";
        const today = date !== null && sameDay(date, now);
        return (
          <section className={today ? "event-agenda-day is-today" : "event-agenda-day"} key={day}>
            <h3 className="event-agenda-date" aria-label={date ? dayTitle(date) : day}>
              {date ? (
                <>
                  <span className="event-agenda-daynum">{date.getDate()}</span>
                  <span className="event-agenda-daywords" aria-hidden="true">
                    <span className={relative ? "event-agenda-relative" : undefined}>
                      {relative || weekdayShort(date)}
                    </span>
                    <span>{monthShort(date)}</span>
                  </span>
                </>
              ) : (
                day
              )}
            </h3>
            <div className="event-agenda-entries">
              {group.map((entry) => (
                <AgendaRow
                  key={entry.id}
                  entry={entry}
                  reminded={reminded.has(entry.id)}
                  selected={entry.id === selected}
                  past={hasPassed(entry, seconds)}
                  onOpen={onOpen}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function AgendaRow({
  entry,
  reminded,
  selected,
  past,
  onOpen,
}: {
  entry: CalendarEntry;
  reminded: boolean;
  selected: boolean;
  past: boolean;
  onOpen: (entry: CalendarEntry) => void;
}) {
  const { t } = useTranslation();
  // A blank in a time column reads as missing data, so a whole-day entry says so.
  const time = entryTime(entry) || t("events.detail.allDay");
  // The category in words beside its dot, so the colour is never the only
  // thing saying what kind of entry this is.
  const meta = [t(categoryLabel(entry.category)), entry.host].filter(Boolean).join(" · ");
  const classes = [
    "event-agenda-row",
    `is-${entry.category}`,
    past ? "is-past" : "",
    selected ? "is-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={classes} aria-pressed={selected} onClick={() => onOpen(entry)}>
      <span className="event-agenda-time">{time}</span>
      <span className="event-agenda-title">
        <span className="event-dot" aria-hidden="true" />
        <span className="event-agenda-name">{entry.title}</span>
      </span>
      <span className="event-agenda-meta">{meta}</span>
      <span className="event-agenda-bell">
        {reminded && (
          <span role="img" aria-label={t("events.reminder.set")}>
            <Icon name="bell" size={13} />
          </span>
        )}
      </span>
    </button>
  );
}
