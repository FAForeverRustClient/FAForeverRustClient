// One entry, as it appears inside a day: a dot saying what kind of thing it
// is, a start time, and the title under them.
//
// The same chip in the month grid and the week columns, so a tournament looks
// like a tournament wherever it is seen. Both are narrow, so the title goes
// under the time rather than beside it. The upcoming list has the width for a
// row of its own; see `EventUpcoming`.

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
}

export function EventChip({ entry, reminded, selected, onOpen }: Props) {
  const { t } = useTranslation();
  // A month square is about seventy pixels wide at the default window size,
  // which holds "18:00" and not "18:00 - 22:59". The panel has the end.
  const time = entryStart(entry);
  const classes = [
    "event-chip",
    `is-${entry.category}`,
    time ? "" : "is-untimed",
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
