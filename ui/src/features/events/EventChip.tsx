// One entry, as it appears inside a day: a time, a title, and a coloured edge
// saying what kind of thing it is.
//
// The same chip in the month grid, the week columns and the upcoming list, so a
// tournament looks like a tournament wherever it is seen.

import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import type { CalendarEntry } from "./calendarFeed";
import { entryTime } from "./eventPresentation";

interface Props {
  entry: CalendarEntry;
  /** Whether a reminder is set on this occurrence. Drawn as a bell. */
  reminded: boolean;
  onOpen: (entry: CalendarEntry) => void;
  /** Dimmed rather than hidden: a day that has passed still happened. */
  past?: boolean;
}

export function EventChip({ entry, reminded, onOpen, past = false }: Props) {
  const { t } = useTranslation();
  const time = entryTime(entry);
  const classes = [
    "event-chip",
    `is-${entry.category}`,
    past ? "is-past" : "",
    entry.origin === "official" ? "is-official" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={classes}
      onClick={() => onOpen(entry)}
      title={`${time ? `${time} ` : ""}${entry.title}`}
    >
      {time && <span className="event-chip-time">{time}</span>}
      <span className="event-chip-title">{entry.title}</span>
      {reminded && (
        <span className="event-chip-bell" aria-label={t("events.reminder.set")}>
          <Icon name="bell" size={11} />
        </span>
      )}
    </button>
  );
}
