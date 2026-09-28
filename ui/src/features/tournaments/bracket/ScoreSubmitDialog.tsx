// Submitting a series score as a player, for the other side to confirm.
//
// `report_submit`, the website's player path: the score is a running total
// that only goes up from what is confirmed, and every new game needs its FAF
// replay id, one field each. Nothing counts until the opponent or an organiser
// accepts it, and submitting again replaces a submission nobody has answered.
// Winner and forfeit are the organiser's, through `MatchReportDialog`.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import { NumberInput } from "../../../design-system/NumberInput";
import type { MatchReport, Tourney, TourneyMatch } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import {
  cleanReplayField,
  isPlayerSubmittable,
  replayIdsOf,
} from "../../../shared/rules/tourneyRules";

interface ScoreSubmitDialogProps {
  event: Tourney;
  entry: TourneyMatch;
  busy: boolean;
  onSubmit: (report: MatchReport) => void;
  onClose: () => void;
}

export function ScoreSubmitDialog({ event, entry, busy, onSubmit, onClose }: ScoreSubmitDialogProps) {
  const { t } = useTranslation();
  const needed = Math.ceil(entry.bestOf / 2);
  const current1 = entry.score1 ?? (entry.handicap > 0 ? 1 : 0);
  const current2 = entry.score2 ?? 0;
  const [score1, setScore1] = useState(current1);
  const [score2, setScore2] = useState(current2);
  // One field per new game, kept by index so raising and lowering a score
  // does not throw away what was already pasted.
  const [replays, setReplays] = useState<string[]>([]);
  const [drawn, setDrawn] = useState(false);
  const [drawReplays, setDrawReplays] = useState("");

  // Bounded by the series, as the website does: a typed 1000 must not build a
  // thousand fields.
  const fresh = Math.max(0, Math.min(entry.bestOf, score1 + score2 - current1 - current2));
  const replayIds = Array.from({ length: fresh }, (_, index) => replays[index] ?? "");
  const ready = isPlayerSubmittable(entry, score1, score2, replayIds);

  const mine = event.viewer.memberTeamId;
  const ownPending = entry.pendingReport !== null && entry.pendingReport.byTeam === mine;

  const teamName = (teamId: string | null): string => {
    const team = event.teams.find((candidate) => candidate.id === teamId);
    if (team === undefined) return t("tournaments.bracket.tbd");
    const named = team.name.trim();
    if (named !== "") return named;
    return event.players.find((player) => player.id === team.playerIds[0])?.name ?? named;
  };

  const scoreBox = (
    teamId: string | null,
    value: number,
    floor: number,
    set: (next: number) => void,
  ) => (
    <label className="tournament-field tournament-score-field">
      <span>{teamName(teamId)}</span>
      <NumberInput min={floor} max={needed} value={value} onChange={set} />
    </label>
  );

  const setReplay = (index: number, text: string) => {
    const next = [...replayIds];
    next[index] = text.replace(/\D/g, "").slice(0, 24);
    setReplays(next);
  };

  return (
    <Modal onClose={onClose} className="tournament-form" ariaLabel={t("tournaments.submit.title")}>
      <h3>{t("tournaments.submit.title")}</h3>
      <p className="muted">{t("tournaments.report.bestOf", { count: entry.bestOf })}</p>
      <p className="muted">
        {t("tournaments.submit.confirmed", { score: `${current1}–${current2}` })}{" "}
        {t("tournaments.submit.intro")}
      </p>

      {ownPending && entry.pendingReport !== null && (
        <p className="tournament-report-pending">
          {t("tournaments.submit.yoursPending", {
            score: `${entry.pendingReport.score1}–${entry.pendingReport.score2}`,
          })}
        </p>
      )}

      <div className="tournament-score-row">
        {scoreBox(entry.team1, score1, current1, setScore1)}
        {scoreBox(entry.team2, score2, current2, setScore2)}
      </div>

      {fresh === 0 ? (
        <p className="muted">{t("tournaments.submit.raise")}</p>
      ) : (
        <fieldset className="tournament-field">
          <legend>{t("tournaments.report.replayIds")}</legend>
          {replayIds.map((value, index) => (
            <input
              key={index}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              maxLength={24}
              value={value}
              placeholder={t("tournaments.submit.replayFor", {
                game: current1 + current2 + index + 1,
              })}
              onChange={(changed) => setReplay(index, changed.target.value)}
            />
          ))}
          <small className="muted">{t("tournaments.submit.replayHint")}</small>
        </fieldset>
      )}

      <label className="tournament-check">
        <input
          type="checkbox"
          checked={drawn}
          onChange={(changed) => setDrawn(changed.target.checked)}
        />
        <span>{t("tournaments.submit.draw")}</span>
      </label>
      {drawn && (
        <label className="tournament-field">
          <span>{t("tournaments.report.drawReplayIds")}</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={drawReplays}
            placeholder="21534010"
            onChange={(changed) => setDrawReplays(cleanReplayField(changed.target.value))}
          />
          <small className="muted">{t("tournaments.report.drawReplayIdsHint")}</small>
        </label>
      )}

      <div className="tournament-form-actions">
        <Button onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          disabled={busy || !ready}
          onClick={() =>
            onSubmit({
              matchId: entry.id,
              score1,
              score2,
              replayIds,
              drawReplayIds: drawn ? replayIdsOf(drawReplays).slice(0, 10) : [],
              winner: null,
              forfeit: null,
            })
          }
        >
          {t(busy ? "tournaments.match.reporting" : "tournaments.submit.go")}
        </Button>
      </div>
    </Modal>
  );
}
