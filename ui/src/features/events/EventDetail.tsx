// One occurrence, opened.
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
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { Select } from "../../design-system/Select";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import { openHttpsUrl } from "../../shared/externalLinks";
import { formatShortDate } from "../../shared/dates";
import type { CalendarEntry } from "./calendarFeed";
import {
  categoryLabel,
  entryTime,
  LEAD_TIMES,
  leadLabel,
  localZoneName,
  originLabel,
} from "./eventPresentation";

interface Props {
  entry: CalendarEntry;
  /** The lead time already set on this occurrence, or `null` for none. */
  leadMinutes: number | null;
  onClose: () => void;
}

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

export function EventDetail({ entry, leadMinutes, onClose }: Props) {
  const { t } = useTranslation();
  const time = entryTime(entry);
  const zone = localZoneName();
  const sourceLabel =
    entry.source.kind === "tourney"
      ? t("events.openTournament")
      : entry.source.kind === "patch"
        ? t("events.openChangelog")
        : "";

  return (
    <Modal className="event-detail-modal" onClose={onClose} ariaLabel={entry.title}>
      <header className="event-detail-head">
        <h2>{entry.title}</h2>
        <div className="event-detail-tags">
          <span className={`event-tag is-${entry.category}`}>{t(categoryLabel(entry.category))}</span>
          <span className={`event-origin is-${entry.origin}`}>{t(originLabel(entry.origin))}</span>
        </div>
      </header>

      <dl className="event-detail-facts">
        <dt>{t("events.detail.when")}</dt>
        <dd>
          {formatShortDate(entry.startsAt * 1000)}
          {time && <> - {time}</>}
          {time && zone && <span className="event-detail-zone"> ({zone})</span>}
          {entry.allDay && <span className="event-detail-zone"> ({t("events.detail.allDay")})</span>}
        </dd>
        {entry.host && (
          <>
            <dt>{t("events.detail.host")}</dt>
            <dd>{entry.host}</dd>
          </>
        )}
      </dl>

      {entry.summary && <p className="event-detail-summary">{entry.summary}</p>}

      <div className="event-detail-actions">
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

      {/* The reminder, in its own block rather than among the links: the issue
          asked for it to be prominent, and it is the one control here that
          changes something rather than going somewhere. */}
      <section className="event-detail-reminder" aria-label={t("events.reminder.title")}>
        <div className="event-detail-reminder-copy">
          <strong>{t("events.reminder.title")}</strong>
          <small>{t("events.reminder.hint")}</small>
        </div>
        <div className="event-detail-reminder-controls">
          <Select
            className="event-lead-select"
            label={t("events.reminder.lead")}
            value={leadMinutes ?? LEAD_TIMES[1]}
            options={LEAD_TIMES.map((minutes) => ({
              value: minutes,
              label: t(leadLabel(minutes)),
            }))}
            onChange={(minutes) => remind(entry, minutes)}
          />
          {leadMinutes === null ? (
            <Button variant="primary" onClick={() => remind(entry, LEAD_TIMES[1])}>
              <Icon name="bell" size={13} /> {t("events.reminder.add")}
            </Button>
          ) : (
            <Button onClick={() => forget(entry)}>{t("events.reminder.remove")}</Button>
          )}
        </div>
      </section>
    </Modal>
  );
}
