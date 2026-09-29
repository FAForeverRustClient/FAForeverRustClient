// A running Swiss stage's playoffs, for the organiser: the website's Playoffs
// panel on its Admin tab.
//
// Who picks their opponent, the clock per pick and how equal records are
// ordered can be changed while the Swiss is played; the playoffs are then set
// up that way the moment it ends. Once they exist, a different setting means
// redoing them, and once a playoff match has begun nothing changes any more.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import type { PickMode, SwissTiebreak, Tourney, TourneyAdmin } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { pickHelpText, pickOptionText, tiebreakText } from "../bracket/swissPresentation";

interface PlayoffsPanelProps {
  event: Tourney;
  busy: boolean;
  onAdmin: (change: TourneyAdmin) => void;
}

type PickChoice = "off" | PickMode;

const CHOICES: PickChoice[] = ["off", "half", "unbeaten", "bottom"];

export function PlayoffsPanel({ event, busy, onAdmin }: PlayoffsPanelProps) {
  const { t } = useTranslation();
  const playoffs = event.playoffs;
  const current: PickChoice = playoffs?.pick ?? "off";
  const [pick, setPick] = useState<PickChoice>(current);
  const [tiebreak, setTiebreak] = useState<SwissTiebreak>(event.swissTiebreak);
  const [minutes, setMinutes] = useState(String(event.pickMinutes));
  if (playoffs === null) return null;

  const cuts = event.swissCuts;
  const mode: PickMode | null = pick === "off" ? null : pick;
  // Picking from the lowest record through orders the pickers by who they beat.
  const effectiveTiebreak: SwissTiebreak = pick === "bottom" ? "beaten" : tiebreak;
  const changed = pick !== current || effectiveTiebreak !== event.swissTiebreak;
  const redo = playoffs.made && changed;
  const typed = Number.parseInt(minutes, 10);
  const clock = Number.isInteger(typed) ? Math.min(Math.max(typed, 0), 1440) : 0;
  const lastPick = event.picks !== null && event.picks.stageTwo ? event.picks.log[event.picks.log.length - 1] : undefined;
  const name = (teamId: string) => event.teams.find((team) => team.id === teamId)?.name ?? teamId;

  const state = playoffs.locked
    ? "tournaments.playoffs.stateLocked"
    : !playoffs.swissDone
      ? "tournaments.playoffs.stateSwiss"
      : playoffs.made && !playoffs.built
        ? "tournaments.playoffs.statePicking"
        : "tournaments.playoffs.stateBuilt";

  const setup = (withRedo: boolean) =>
    onAdmin({
      type: "playoffSetup",
      payload: { pick: mode, minutes: clock, tiebreak: effectiveTiebreak, redo: withRedo },
    });

  return (
    <div className="tournament-playoffs-setup">
      <p className="muted">{t(state)}</p>

      {playoffs.locked ? (
        <div className="tournament-cell">
          <div className="tournament-cell-label">{t("tournaments.playoffs.setUpAs")}</div>
          <div className="tournament-cell-body">
            <p>{pickOptionText(playoffs.pick, cuts, t)}</p>
            <p className="muted">{tiebreakText(event, t)}</p>
          </div>
        </div>
      ) : (
        <>
          <label className="tournament-field">
            <span>{t("tournaments.playoffs.whenSwissEnds")}</span>
            <select value={pick} disabled={busy} onChange={(changed) => setPick(changed.target.value as PickChoice)}>
              {CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {pickOptionText(choice === "off" ? null : choice, cuts, t)}
                </option>
              ))}
            </select>
          </label>
          <label className="tournament-field">
            <span>{t("tournaments.playoffs.tiebreak")}</span>
            <select
              value={effectiveTiebreak}
              disabled={busy || pick === "bottom"}
              onChange={(changed) => setTiebreak(changed.target.value as SwissTiebreak)}
            >
              <option value="gameDiff">{t("tournaments.playoffs.tiebreakGdOption")}</option>
              <option value="beaten">{t("tournaments.playoffs.tiebreakBeatenOption")}</option>
            </select>
            <small className="muted">{t("tournaments.playoffs.tiebreakHint")}</small>
          </label>
          {pick !== "off" && (
            <label className="tournament-field">
              <span>{t("tournaments.playoffs.minutes")}</span>
              <input
                type="number"
                min={0}
                max={1440}
                value={minutes}
                onChange={(changed) => setMinutes(changed.target.value)}
              />
              <small className="muted">{t("tournaments.playoffs.minutesHint")}</small>
            </label>
          )}
          <p className="muted">{pickHelpText(mode, playoffs.cutTo, cuts, t)}</p>
          <div className="tournament-detail-actions">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                if (!redo || window.confirm(t("tournaments.playoffs.redoConfirm", { what: redoWhat(mode, t) }))) {
                  setup(redo);
                }
              }}
            >
              {t(redo ? "tournaments.playoffs.saveRedo" : "tournaments.playoffs.save")}
            </Button>
          </div>
        </>
      )}

      {playoffs.made && !playoffs.locked && (
        <div className="tournament-detail-actions">
          {playoffs.built && lastPick !== undefined && (
            <Button
              disabled={busy}
              onClick={() => {
                if (window.confirm(t("tournaments.playoffs.undoConfirm", { by: name(lastPick.by), target: name(lastPick.target) }))) {
                  onAdmin({ type: "undoPickOpponent" });
                }
              }}
            >
              {t("tournaments.picks.undo")}
            </Button>
          )}
          <Button
            disabled={busy}
            onClick={() => {
              if (window.confirm(t("tournaments.playoffs.redoConfirm", { what: redoWhat(playoffs.pick, t) }))) {
                onAdmin({
                  type: "playoffSetup",
                  payload: { pick: playoffs.pick, minutes: event.pickMinutes, tiebreak: event.swissTiebreak, redo: true },
                });
              }
            }}
          >
            {t("tournaments.playoffs.redo")}
          </Button>
        </div>
      )}

      {!playoffs.double && (
        <ThirdPlaceSwitch event={event} busy={busy} onAdmin={onAdmin} />
      )}
    </div>
  );
}

/** What redoing the playoffs does, for its confirmation. */
function redoWhat(pick: PickMode | null, t: (key: "tournaments.playoffs.redoSeeded" | "tournaments.playoffs.redoPicks" | "tournaments.playoffs.redoPicksDrawn") => string): string {
  if (pick === null) return t("tournaments.playoffs.redoSeeded");
  return t(pick === "unbeaten" ? "tournaments.playoffs.redoPicksDrawn" : "tournaments.playoffs.redoPicks");
}

/** The playoffs' 3rd place match, on or off, and why it is where it is. */
function ThirdPlaceSwitch({ event, busy, onAdmin }: PlayoffsPanelProps) {
  const { t } = useTranslation();
  const playoffs = event.playoffs;
  if (playoffs === null) return null;
  const match = event.matches.find((entry) => entry.bracket === "thirdPlace") ?? null;
  const started = match !== null && (match.status === "done" || match.status === "live" || match.pendingReport !== null);
  const note = started
    ? "tournaments.playoffs.thirdStarted"
    : match !== null
      ? "tournaments.playoffs.thirdOnBracket"
      : playoffs.built
        ? "tournaments.playoffs.thirdAddNow"
        : "tournaments.playoffs.thirdWhenBuilt";
  return (
    <div className="tournament-field">
      <label className="tournament-checkbox">
        <input
          type="checkbox"
          checked={playoffs.thirdPlace || match !== null}
          disabled={busy || started}
          onChange={(changed) => onAdmin({ type: "thirdPlace", payload: { on: changed.target.checked } })}
        />
        <span>{t("tournaments.playoffs.third")}</span>
      </label>
      <small className="muted">{t(note)}</small>
    </div>
  );
}
