// Ending an elimination before its final.
//
// This is the qualifier control: an event that exists to find its top four
// runs until the four are settled, not until somebody wins it. Two ways, as on
// the website: a survivor count the event stops at by itself, and a button that
// stops it now. Either way the standings lock where they stand and nobody is
// crowned. A parent drawing qualifiers from this event invites from them at once.
//
// Both writes are sent confirmed, because the service's own objections are
// knowable here and asked about first: a count the field has already reached
// ends the event on the spot, and a match still being played is abandoned.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import { NumberInput } from "../../../design-system/NumberInput";
import type { Tourney, TourneyAdmin } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { mayEndEarly, mayReopenEarly } from "../../../shared/rules/tourneyRules";
import { teamNameOf } from "../bracket/matchParts";

interface EndEarlyPanelProps {
  event: Tourney;
  busy: boolean;
  onAdmin: (change: TourneyAdmin) => void;
}

export function EndEarlyPanel({ event, busy, onAdmin }: EndEarlyPanelProps) {
  const { t } = useTranslation();
  const survivors = event.survivors ?? { winners: [], losers: [] };
  const alive = survivors.winners.length + survivors.losers.length;
  const declared = event.stopAtAlive;
  const [count, setCount] = useState(() => declared || Math.max(2, Math.min(4, alive - 1)));
  const nameOf = (teamId: string) => teamNameOf(event, teamId) ?? teamId;

  if (mayReopenEarly(event) && event.earlyFinish !== null) {
    const finish = event.earlyFinish;
    return (
      <div className="tournament-step">
        <p className="muted">
          {finish.automatic
            ? t("tournaments.endEarly.stoppedAuto", { count: finish.alive, names: finish.names.join(", ") })
            : t("tournaments.endEarly.stoppedBy", {
                name: finish.by,
                count: finish.alive,
                names: finish.names.join(", "),
              })}
        </p>
        <Button
          disabled={busy}
          onClick={() => {
            if (window.confirm(t("tournaments.endEarly.reopenConfirm"))) {
              onAdmin({ type: "reopenEarly" });
            }
          }}
        >
          {t("tournaments.endEarly.reopen")}
        </Button>
      </div>
    );
  }

  if (!mayEndEarly(event)) return null;

  const live = event.matches.filter((entry) => entry.status === "live").length;
  const valid = count >= 2 && count < event.teams.length;

  const setStop = (target: number) => {
    // A count the field has reached ends the event on the spot. The service
    // asks for a confirmation before doing that, and so does this.
    if (target > 0 && alive <= target && !window.confirm(t("tournaments.endEarly.endsNow", { count: alive }))) {
      return;
    }
    onAdmin({ type: "stopAt", payload: { alive: target } });
  };

  return (
    <>
      <p className="muted">
        {declared > 0
          ? t("tournaments.endEarly.declared", { count: declared, left: Math.max(0, alive - declared) })
          : t("tournaments.endEarly.hint")}
      </p>
      <div className="tournament-step">
        <h6>{t("tournaments.endEarly.standing", { count: alive })}</h6>
        {event.bracketKind === "double" ? (
          <>
            <p className="muted">
              {t("tournaments.endEarly.winnersSide", {
                names: survivors.winners.map(nameOf).join(", ") || t("tournaments.endEarly.nobody"),
              })}
            </p>
            <p className="muted">
              {t("tournaments.endEarly.losersSide", {
                names: survivors.losers.map(nameOf).join(", ") || t("tournaments.endEarly.nobody"),
              })}
            </p>
          </>
        ) : (
          <p className="muted">{survivors.winners.map(nameOf).join(", ") || t("tournaments.endEarly.nobody")}</p>
        )}
      </div>
      <div className="tournament-step">
        <h6>{t("tournaments.endEarly.auto")}</h6>
        <div className="tournament-detail-actions">
          <label className="tournament-field tournament-inline-field">
            <span>{t("tournaments.endEarly.stopWhen")}</span>
            <NumberInput min={2} max={128} value={count} disabled={busy} onChange={setCount} />
          </label>
          <Button disabled={busy || !valid} onClick={() => setStop(count)}>
            {t(declared > 0 ? "tournaments.endEarly.update" : "tournaments.endEarly.set")}
          </Button>
          {declared > 0 && (
            <Button
              disabled={busy}
              onClick={() => {
                if (window.confirm(t("tournaments.endEarly.clearConfirm"))) setStop(0);
              }}
            >
              {t("tournaments.endEarly.clear")}
            </Button>
          )}
        </div>
        {!valid && (
          <small className="muted">{t("tournaments.endEarly.range", { teams: event.teams.length })}</small>
        )}
      </div>
      <div className="tournament-step">
        <Button
          disabled={busy || alive === 0}
          onClick={() => {
            const question = [
              t("tournaments.endEarly.finishConfirm", { name: event.name, count: alive }),
              live > 0 ? t("tournaments.endEarly.finishLive", { count: live }) : "",
            ]
              .filter(Boolean)
              .join("\n\n");
            if (window.confirm(question)) onAdmin({ type: "finishEarly" });
          }}
        >
          {t("tournaments.endEarly.finish")}
        </Button>
      </div>
    </>
  );
}
