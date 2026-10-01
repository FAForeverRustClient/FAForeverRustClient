// One entry, as it appears inside a day: a dot saying what kind of thing it
// is, a time, and a title.
//
// The same chip in the month grid, the week columns and the upcoming list, so a
// tournament looks like a tournament wherever it is seen. The grid and the
// columns are narrow, so there it stacks the title under the time; the list is
// wide, so there the two share a line and the times form a column.

import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import type { CalendarEntry } from "./calendarFeed";
import { categoryLabel, entryStart, entryTime } from "./eventPresentation";

interface Props {
  entry: CalendarEntry;
  /** Whether a reminder is set on this occurrence. Drawn as a bell. */
  reminded: boolean;
  /** Whether this is the entry open in the detail panel. */
  selected: boolean;
  onOpen: (entry: CalendarEntry) => void;
  /** Title under the time, and the start alone: for the narrow grid squares. */
  stacked?: boolean;
  /** Dimmed rather than hidden: a day that has passed still happened. */
  past?: boolean;
}

export function EventChip({
  entry,
  reminded,
  selected,
  onOpen,
  stacked = false,
  past = false,
}: Props) {
  const { t } = useTranslation();
  // A month square is about seventy pixels wide at the default window size,
  // which holds "18:00" and not "18:00 - 22:59". The panel has the end. The
  // list has a time column, and a blank in it reads as missing data, so there
  // a whole-day entry says so.
  const time = stacked
    ? entryStart(entry)
    : entryTime(entry) || t("events.detail.allDay");
  const classes = [
    "event-chip",
    `is-${entry.category}`,
    stacked ? "is-stacked" : "",
    time ? "" : "is-untimed",
    past ? "is-past" : "",
    selected ? "is-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");
  // The category is otherwise only the dot's colour; the tooltip says it in
  // words, so colour is never the one thing carrying it.
  const tooltip = [t(categoryLabel(entry.category)), entryTime(entry), entry.title]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      className={classes}
      onClick={() => onOpen(entry)}
      aria-pressed={selected}
      title={tooltip}
    >
      {/* A reminder takes the dot's place, in the dot's colour: a day square
          has no room for both, and the bell still says what kind of entry it
          is by the same colour. */}
      {reminded ? (
        <span className="event-chip-mark event-chip-bell" role="img" aria-label={t("events.reminder.set")}>
          <Icon name="bell" size={11} />
        </span>
      ) : (
        <span className="event-chip-mark" aria-hidden="true">
          <span className="event-dot" />
        </span>
      )}
      {time && <span className="event-chip-time">{time}</span>}
      <span className="event-chip-title">{entry.title}</span>
    </button>
  );
}
