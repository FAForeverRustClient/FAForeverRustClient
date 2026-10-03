// Seeds choosing their own opponent: the website's pick phase.
//
// For the main bracket it runs before anything is drawn, so this panel is the
// whole Bracket section until the last pick; for a Swiss stage's playoffs it
// sits above the rounds. Whoever is on the clock, or an organiser on their
// behalf, picks from the seeds still free. The service keeps the clock and
// applies a lapsed turn only when the event is read, so the panel counts down
// locally, reads the event again at zero, and keeps reading it every few
// seconds while the phase is open, as the website does.

import { useEffect, useRef, useState } from "react";
import { Button } from "../../../design-system/Button";
import type { PickPhase, Tourney, TourneyAdmin } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { teamNameOf } from "./matchParts";
import { clockText, pickRecord, pickSeed } from "./swissPresentation";

/** How often an open phase is read again: the website's four seconds, near enough. */
const POLL_MS = 5_000;

interface PickPhasePanelProps {
  event: Tourney;
  picks: PickPhase;
  busy: boolean;
  onAdmin: (change: TourneyAdmin) => void;
  /** Read the event again, silently. */
  onRefresh: () => void;
}

export function PickPhasePanel({ event, picks, busy, onAdmin, onRefresh }: PickPhasePanelProps) {
  const { t } = useTranslation();
  const organiser = event.viewer.organiser;
  // When this reading arrived: the clock left is as of then. Held beside the
  // reading it belongs to, so a new reading restarts the count.
  const [reading, setReading] = useState(() => ({ picks, at: Date.now() }));
  if (reading.picks !== picks) setReading({ picks, at: Date.now() });
  const [now, setNow] = useState(reading.at);
  // The view above hands a new callback on every render; the timers must not
  // restart with it, or a one-second tick would keep the poll from ever firing.
  const refresh = useRef(onRefresh);
  useEffect(() => {
    refresh.current = onRefresh;
  });
  const refreshedFor = useRef<number | null>(null);

  useEffect(() => {
    if (!picks.open) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    const poll = window.setInterval(() => refresh.current(), POLL_MS);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [picks.open]);

  const left =
    picks.secondsLeft === null ? null : Math.max(0, picks.secondsLeft - Math.floor((now - reading.at) / 1000));
  useEffect(() => {
    // The service applies a lapsed turn when the event is read; read it once.
    if (left === 0 && picks.open && refreshedFor.current !== reading.at) {
      refreshedFor.current = reading.at;
      refresh.current();
    }
  }, [left, picks.open, reading.at]);

  const name = (teamId: string | null) => teamNameOf(event, teamId) ?? t("tournaments.bracket.tbd");
  const seedLine = (teamId: string) => {
    const seed = pickSeed(picks, teamId);
    const record = pickRecord(picks, teamId);
    return [seed === null ? "" : t("tournaments.picks.seed", { seed }), record ?? ""].filter((part) => part !== "").join(" · ");
  };
  const targetOf = (picker: string) => picks.picks.find((made) => made.picker === picker)?.target ?? null;
  const poolRecord = picks.pool.length > 0 ? pickRecord(picks, picks.pool[0]) : null;
  const from = picks.poolBottom && poolRecord !== null ? t("tournaments.picks.from", { record: poolRecord }) : "";

  const explanation = picks.unbeaten
    ? [
        picks.order.length === 1
          ? t("tournaments.picks.unbeatenOne", { from })
          : t("tournaments.picks.unbeatenMany", { count: picks.order.length, from }),
        t(picks.restSeeded ? "tournaments.picks.restSeeded" : "tournaments.picks.restDrawn"),
        picks.poolBottom ? t("tournaments.picks.seedsFrom") : "",
      ]
    : [t("tournaments.picks.half", { count: picks.half })];
  explanation.push(t(picks.secondsPerPick !== null ? "tournaments.picks.clock" : "tournaments.picks.noClock"));

  const turn = picks.turn;
  const mayPick = picks.open && turn !== null && (picks.myTurn || organiser);

  return (
    <section className="surface tournament-picks">
      <h4>{t(picks.open ? "tournaments.picks.choosing" : "tournaments.picks.chosen")}</h4>
      <p className="muted">{explanation.filter((part) => part !== "").join(" ")}</p>

      {picks.open && turn !== null && (
        picks.myTurn ? (
          <div className={left !== null && left <= 30 ? "tournament-picks-callout is-urgent" : "tournament-picks-callout"}>
            <strong>
              {t("tournaments.picks.yourPick")}
              {left !== null && ` ${clockText(left)}`}
            </strong>
            <span>{t("tournaments.picks.chooseBelow")}</span>
          </div>
        ) : (
          <div className="tournament-cell">
            <div className="tournament-cell-label">{t("tournaments.picks.waitingOn")}</div>
            <div className="tournament-cell-body">
              {name(turn)} <span className="muted">({seedLine(turn)})</span>
              {left !== null && <span className="mono"> {clockText(left)}</span>}
            </div>
          </div>
        )
      )}

      <ol className="tournament-picks-rows">
        {picks.order.map((picker) => {
          const target = targetOf(picker);
          return (
            <li key={picker} className={picker === turn && picks.open ? "is-turn" : undefined}>
              <span className="mono muted">{pickSeed(picks, picker) ?? ""}</span>
              <span>
                {name(picker)}
                {pickRecord(picks, picker) !== null && <span className="muted"> {pickRecord(picks, picker)}</span>}
              </span>
              <span className="muted">{t("tournaments.swiss.vs")}</span>
              <span>
                {target !== null ? (
                  <>
                    {name(target)} <span className="muted">({seedLine(target)})</span>
                    {picks.log.some((entry) => entry.by === picker && entry.auto) && (
                      <span className="muted"> {t("tournaments.picks.auto")}</span>
                    )}
                  </>
                ) : picker === turn && picks.open ? (
                  <span className="muted">{t("tournaments.picks.choosingDots")}</span>
                ) : (
                  <span className="muted">{"–"}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      {mayPick && (
        <div className="tournament-picks-choices">
          <h6>
            {picks.myTurn
              ? t("tournaments.picks.pickYours")
              : t("tournaments.picks.pickFor", { name: name(turn) })}
          </h6>
          <div className="tournament-detail-actions">
            {picks.available.map((teamId) => (
              <Button
                key={teamId}
                disabled={busy}
                onClick={() => onAdmin({ type: "pickOpponent", payload: { teamId } })}
              >
                {name(teamId)} <span className="muted">{seedLine(teamId)}</span>
              </Button>
            ))}
          </div>
        </div>
      )}

      {organiser && picks.open && picks.log.length > 0 && (
        <div className="tournament-detail-actions">
          <Button disabled={busy} onClick={() => onAdmin({ type: "undoPickOpponent" })}>
            {t("tournaments.picks.undo")}
          </Button>
        </div>
      )}

      {picks.log.some((entry) => entry.auto) && <p className="muted">{t("tournaments.picks.autoNote")}</p>}
    </section>
  );
}
