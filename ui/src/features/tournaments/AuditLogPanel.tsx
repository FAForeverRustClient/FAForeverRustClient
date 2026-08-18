// What the organisers did, newest first.
//
// The service withholds `tlog` from everyone else and keeps at most the last
// three hundred lines, so this is a window rather than a record: it exists so a
// co-organiser can see who moved a player or reopened signups without asking.
//
// Read-only by design. Every line is a sentence the service composed, and there
// is nothing here to act on, which is why it is the last section and carries no
// controls at all.

import type { Tourney } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { formatMoment } from "./tourneyPresentation";

interface AuditLogPanelProps {
  event: Tourney;
}

export function AuditLogPanel({ event }: AuditLogPanelProps) {
  const { t } = useTranslation();

  if (event.auditLog.length === 0) {
    return <p className="muted">{t("tournaments.log.none")}</p>;
  }

  return (
    <ol className="tournament-log">
      {event.auditLog.map((line, index) => (
        // No id on the wire, and two lines can share a timestamp and a text
        // when a write touches several things at once, so the position is the
        // only honest key. The list is replaced wholesale on every reload.
        <li key={`${line.at ?? 0}-${index}`} className="tournament-log-line">
          <span className="tournament-log-when muted">
            {formatMoment(line.at, t("tournaments.log.whenUnknown"))}
          </span>
          <span className="tournament-log-who">{line.by}</span>
          <span className="tournament-log-what">{line.text}</span>
        </li>
      ))}
    </ol>
  );
}
