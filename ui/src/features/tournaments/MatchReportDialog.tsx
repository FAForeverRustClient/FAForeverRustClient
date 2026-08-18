// Reporting one series result.
//
// The organiser's, and only theirs. `report` takes a score, an explicit winner
// and a forfeit, and it is also the correction path, so it stays open on a
// finished match. It needs no replay ids: that rule belongs to `report_submit`,
// the player path, which this client does not use.
//
// The score is a running total, not this game's result: a Bo3 at 1-1 is
// reported as 2-1, and the server counts the difference.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import type { MatchReport, Tourney, TourneyMatch } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { isSubmittable } from "../../shared/tourneyRules";

interface MatchReportDialogProps {
  event: Tourney;
  entry: TourneyMatch;
  busy: boolean;
  onSubmit: (report: MatchReport) => void;
  onClose: () => void;
}

export function MatchReportDialog({
  event,
  entry,
  busy,
  onSubmit,
  onClose,
}: MatchReportDialogProps) {
  const { t } = useTranslation();
  const [score1, setScore1] = useState(entry.score1 ?? (entry.handicap > 0 ? 1 : 0));
  const [score2, setScore2] = useState(entry.score2 ?? 0);
  /** A team the organiser declares the winner regardless of the score. */
  const [winner, setWinner] = useState<string | null>(null);
  /** A team that did not turn up, or walked away. */
  const [forfeit, setForfeit] = useState<string | null>(null);

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
      <input
        type="number"
        min={0}
        max={needed}
        value={value}
        onChange={(changed) => set(Number(changed.target.value))}
      />
    </label>
  );

  return (
    <Modal onClose={onClose} className="tournament-form" ariaLabel={t("tournaments.match.report")}>
      <h3>{t("tournaments.match.report")}</h3>
      <p className="muted">{t("tournaments.report.bestOf", { count: entry.bestOf })}</p>

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

      <div className="tournament-form-actions">
        <Button onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          disabled={busy || !ready}
          // No replay ids: `report` treats them as optional, and only the
          // organiser records results here.
          onClick={() =>
            onSubmit({
              matchId: entry.id,
              score1,
              score2,
              replayIds: [],
              drawReplayIds: [],
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
