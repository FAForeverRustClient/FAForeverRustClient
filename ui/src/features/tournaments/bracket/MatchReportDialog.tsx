// Reporting one series result, as an organiser.
//
// `report` takes a score, an explicit winner, a forfeit and the replay ids, and
// it is also the correction path, so it stays open on a finished match. The ids
// are optional here, unlike on the players' own path, but they are what makes a
// result auditable and what casters pull the games from, so they are asked for.
//
// The score is a running total, not this game's result: a Bo3 at 1-1 is
// reported as 2-1, and the server counts the difference.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import type { MatchReport, Tourney, TourneyMatch } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { cleanReplayField, isSubmittable, replayIdsOf } from "../../../shared/rules/tourneyRules";
import { NumberInput } from "../../../design-system/NumberInput";

interface MatchReportDialogProps {
  event: Tourney;
  entry: TourneyMatch;
  busy: boolean;
  onSubmit: (report: MatchReport) => void;
  /** Settle a score one side submitted, which an organiser may do for either. */
  onAnswer: (accept: boolean) => void;
  onClose: () => void;
}

export function MatchReportDialog({
  event,
  entry,
  busy,
  onSubmit,
  onAnswer,
  onClose,
}: MatchReportDialogProps) {
  const { t } = useTranslation();
  const [score1, setScore1] = useState(entry.score1 ?? (entry.handicap > 0 ? 1 : 0));
  const [score2, setScore2] = useState(entry.score2 ?? 0);
  /** A team the organiser declares the winner regardless of the score. */
  const [winner, setWinner] = useState<string | null>(null);
  /** A team that did not turn up, or walked away. */
  const [forfeit, setForfeit] = useState<string | null>(null);
  // Prefilled from the match, so a correction keeps what was recorded.
  const [replays, setReplays] = useState(entry.replayIds.join(", "));
  const [drawReplays, setDrawReplays] = useState(entry.drawReplayIds.join(", "));
  const pending = entry.pendingReport;

  const needed = Math.ceil(entry.bestOf / 2);
  // The shorthand: a forfeit alone, no score. The server awards the win to the
  // other side and records the forfeiting team at -1.
  const bareForfeit = forfeit !== null && winner === null && score1 === 0 && score2 === 0;
  const ready = bareForfeit || isSubmittable(entry, score1, score2, winner);

  const teamName = (teamId: string | null): string => {
    const team = event.teams.find((candidate) => candidate.id === teamId);
    if (team === undefined) return t("tournaments.bracket.tbd");
    const named = team.name.trim();
    if (named !== "") return named;
    return event.players.find((player) => player.id === team.playerIds[0])?.name ?? named;
  };

  const scoreBox = (teamId: string | null, value: number, set: (next: number) => void) => (
    <label className="tournament-field tournament-score-field">
      <span>{teamName(teamId)}</span>
      <NumberInput min={0} max={needed} value={value} onChange={set} />
    </label>
  );

  return (
    <Modal onClose={onClose} className="tournament-form" ariaLabel={t("tournaments.match.report")}>
      <h3>{t("tournaments.match.report")}</h3>
      <p className="muted">{t("tournaments.report.bestOf", { count: entry.bestOf })}</p>

      {/* A score one side submitted and the other has not answered. The
          organiser settles it here rather than overwriting it unseen. */}
      {pending !== null && (
        <div className="tournament-report-pending">
          <span>
            {t("tournaments.report.pending", {
              score: `${pending.score1}–${pending.score2}`,
              who: pending.byName || teamName(pending.byTeam),
            })}
          </span>
          <Button variant="primary" disabled={busy} onClick={() => onAnswer(true)}>
            {t("tournaments.report.acceptPending")}
          </Button>
          <Button disabled={busy} onClick={() => onAnswer(false)}>
            {t("tournaments.report.rejectPending")}
          </Button>
        </div>
      )}

      <div className="tournament-score-row">
        {scoreBox(entry.team1, score1, setScore1)}
        {scoreBox(entry.team2, score2, setScore2)}
      </div>

      {/* A no-show is the commonest reason a bracket stalls, and it needs no
          score: naming the absent side is the whole report. */}
      <fieldset className="tournament-field">
        <legend>{t("tournaments.report.forfeit")}</legend>
        <div className="tournament-detail-actions">
          {[entry.team1, entry.team2].map((teamId) => (
            <Button
              key={teamId ?? "none"}
              variant={forfeit === teamId ? "primary" : undefined}
              disabled={teamId === null}
              onClick={() => setForfeit(forfeit === teamId ? null : teamId)}
            >
              {teamName(teamId)}
            </Button>
          ))}
        </div>
        {bareForfeit && (
          <small className="muted">{t("tournaments.report.forfeitHint")}</small>
        )}
      </fieldset>

      {/* For a series nobody clinched that still has to send someone onward: a
          1-1 one side walked away from. Only the organiser may do this, and only
          `report` accepts it. */}
      <fieldset className="tournament-field">
        <legend>{t("tournaments.report.winner")}</legend>
        <div className="tournament-detail-actions">
          {[entry.team1, entry.team2].map((teamId) => (
            <Button
              key={teamId ?? "none"}
              variant={winner === teamId ? "primary" : undefined}
              disabled={teamId === null}
              onClick={() => setWinner(winner === teamId ? null : teamId)}
            >
              {teamName(teamId)}
            </Button>
          ))}
        </div>
        <small className="muted">{t("tournaments.report.winnerHint")}</small>
      </fieldset>

      <label className="tournament-field">
        <span>{t("tournaments.report.replayIds")}</span>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={replays}
          placeholder="21534001, 21534050"
          onChange={(changed) => setReplays(cleanReplayField(changed.target.value))}
        />
        <small className="muted">{t("tournaments.report.replayIdsHint")}</small>
      </label>
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
              replayIds: replayIdsOf(replays),
              drawReplayIds: replayIdsOf(drawReplays),
              winner,
              forfeit,
            })
          }
        >
          {t(busy ? "tournaments.match.reporting" : "tournaments.match.submit")}
        </Button>
      </div>
    </Modal>
  );
}
