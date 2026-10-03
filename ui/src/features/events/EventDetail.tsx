// One occurrence, opened, in the panel beside the calendar.
//
// A panel rather than a dialog, the way the map and mod vaults show the thing
// picked from their lists: reading an event is not a task that needs the rest
// of the screen dimmed, and with the panel in a fixed place the calendar stays
// in view while one entry after another is clicked through.
//
// Two things happen here that cannot happen on a chip: the links out, and the
// reminder. Both are the point of the tab as the thread scoped it: "here is a
// tournament (linking to the tournament tab to sign up) or dojo 1v1 night: join
// this discord button".
//
// There is no "I will participate". Nothing would carry it: FAF has no events
// service, and the one kind of entry that really does have a guest list is a
// tournament, whose signup is in the Tournaments tab and is one button away
// below. A reminder is the part the client can do alone and honestly.

import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { Icon } from "../../design-system/Icon";
import { Select } from "../../design-system/Select";
import { Switch } from "../../design-system/Switch";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import { openHttpsUrl } from "../../shared/externalLinks";
import { hasPassed, type CalendarEntry } from "./calendarFeed";
import { dayOf, parseIsoDay } from "./calendarGrid";
import {
  categoryLabel,
  entryTime,
  fullDate,
  LEAD_TIMES,
  leadLabel,
  localZoneName,
  originLabel,
} from "./eventPresentation";

interface Props {
  /** The open occurrence, or `null` when nothing is picked. */
  entry: CalendarEntry | null;
  /** The lead time already set on this occurrence, or `null` for none. */
  leadMinutes: number | null;
  now: Date;
}

/**
 * The lead time a new reminder starts with.
 *
 * A day: enough to plan an evening around, and the shorter ones are one
 * choice away in the select under the switch.
 */
const DEFAULT_LEAD = LEAD_TIMES[1];

const remind = (entry: CalendarEntry, leadMinutes: number) =>
  ipc.send({
    kind: "Events",
    command: {
      type: "remind",
      payload: {
        occurrenceId: entry.id,
        title: entry.title,
        startsAt: entry.startsAt,
        leadMinutes,
      },
    },
  });

const forget = (entry: CalendarEntry) =>
  ipc.send({
    kind: "Events",
    command: { type: "forget", payload: { occurrenceId: entry.id } },
  });

/** Open the tab that owns this entry, on this entry. */
async function openSource(entry: CalendarEntry) {
  switch (entry.source.kind) {
    case "tourney":
      await ipc.settle({ kind: "Nav", command: { type: "select", payload: { tab: "tournaments" } } });
      await ipc.settle({
        kind: "Tourney",
        command: { type: "select", payload: { tournamentId: entry.source.tourneyId } },
      });
      break;
    case "patch":
      await ipc.settle({ kind: "Nav", command: { type: "select", payload: { tab: "changelog" } } });
      await ipc.settle({
        kind: "Changelog",
        command: { type: "select", payload: { id: entry.source.releaseId } },
      });
      break;
    case "catalogue":
      // Nothing to open: a catalogue entry's own destinations are its links.
      break;
  }
}

export function EventDetail({ entry, leadMinutes, now }: Props) {
  const { t } = useTranslation();

  // The panel holds its place with nothing picked, so the calendar beside it
  // does not change width the first time something is clicked.
  if (entry === null) {
    return (
      <aside className="event-panel surface-panel is-empty" aria-label={t("events.detail.aria")}>
        <EmptyState
          icon="calendar"
          title={t("events.detail.emptyTitle")}
          hint={t("events.detail.emptyHint")}
        />
      </aside>
    );
  }

  const time = entryTime(entry);
  const zone = localZoneName();
  const day = parseIsoDay(dayOf(entry));
  const over = hasPassed(entry, Math.floor(now.getTime() / 1000));
  const sourceLabel =
    entry.source.kind === "tourney"
      ? t("events.openTournament")
      : entry.source.kind === "patch"
        ? t("events.openChangelog")
        : "";
  const hasActions = sourceLabel !== "" || entry.links.length > 0;

  return (
    <aside className="event-panel surface-panel" aria-label={entry.title}>
      <header className="event-panel-head">
        <h2>{entry.title}</h2>
        <div className="event-panel-tags">
          <span className={`event-tag is-${entry.category}`}>
            <span className="event-dot" aria-hidden="true" />
            {t(categoryLabel(entry.category))}
          </span>
          <span className={`event-tag is-${entry.origin}`}>
            <Icon name={entry.origin === "official" ? "shield" : "users"} size={12} />
            {t(originLabel(entry.origin))}
          </span>
        </div>
      </header>

      <ul className="event-panel-facts">
        <li>
          <Icon name="clock" size={15} />
          <span>
            {time || t("events.detail.allDay")}
            {time && zone && <span className="event-panel-zone"> {zone}</span>}
          </span>
        </li>
        <li>
          <Icon name="calendar" size={15} />
          <span>{day ? fullDate(day) : dayOf(entry)}</span>
        </li>
        {entry.host && (
          <li>
            <Icon name="user" size={15} />
            <span>
              <span className="event-panel-label">{t("events.detail.host")}</span> {entry.host}
            </span>
          </li>
        )}
      </ul>

      {entry.summary && <p className="event-panel-summary">{entry.summary}</p>}

      {/* The reminder, in its own block rather than among the links: the issue
          asked for it to be prominent, and it is the one control here that
          changes something rather than going somewhere. Nothing to remind
          about once it is over, so then the block says that instead. */}
      {over ? (
        <p className="event-panel-over">{t("events.detail.over")}</p>
      ) : (
        <section className="event-panel-reminder" aria-label={t("events.reminder.title")}>
          <div className="event-panel-reminder-row">
            <Icon name="bell" size={15} />
            <div className="event-panel-reminder-copy">
              <strong>{t("events.reminder.title")}</strong>
              <small>{t("events.reminder.hint")}</small>
            </div>
            <Switch
              checked={leadMinutes !== null}
              label={t("events.reminder.title")}
              onChange={(on) => (on ? remind(entry, DEFAULT_LEAD) : forget(entry))}
            />
          </div>
          <Select
            className="event-lead-select"
            label={t("events.reminder.lead")}
            disabled={leadMinutes === null}
            value={leadMinutes ?? DEFAULT_LEAD}
            options={LEAD_TIMES.map((minutes) => ({
              value: minutes,
              label: t(leadLabel(minutes)),
            }))}
            onChange={(minutes) => remind(entry, minutes)}
          />
        </section>
      )}

      {hasActions && (
        <div className="event-panel-actions">
          {sourceLabel && (
            <Button variant="primary" onClick={() => ipc.run(openSource(entry))}>
              {sourceLabel}
            </Button>
          )}
          {entry.links.map((link) => (
            <Button key={link.url} onClick={() => void openHttpsUrl(link.url)} title={link.url}>
              {link.label} <Icon name="external" size={13} />
            </Button>
          ))}
        </div>
      )}
    </aside>
  );
}
