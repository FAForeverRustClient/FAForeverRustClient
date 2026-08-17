// Reporting one series result.
//
// Its own dialog rather than an inline field, because the server's rule is
// specific and unforgiving: exactly one FAF replay id per newly reported game,
// or the whole submission is refused. That rule is what makes a bracket
// auditable afterwards, so the form asks for the right number of ids up front
// instead of letting the player discover it by being turned away.
//
// The score is a running total, not this game's result: a Bo3 at 1-1 is
// reported as 2-1, and the server counts the difference.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import type { MatchReport, Tourney, TourneyMatch } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";

/**
 * How many games this report adds to what is already confirmed.
 *
 * Twin of `MatchReport::new_games`. A grand final with a handicap starts the
 * upper-bracket side at 1-0, so an absent score is not always zero.
 */
export function newGames(entry: TourneyMatch, score1: number, score2: number): number {
  const confirmed = (entry.score1 ?? (entry.handicap > 0 ? 1 : 0)) + (entry.score2 ?? 0);
  return Math.max(0, score1 + score2 - confirmed);
}

/** Twin of `MatchReport::is_submittable`: every rule the server checks. */
export function isSubmittable(
  entry: TourneyMatch,
  score1: number,
  score2: number,
  replayIds: string[],
): boolean {
  const needed = Math.ceil(entry.bestOf / 2);
  const games = newGames(entry, score1, score2);
  const usable = replayIds.filter((id) => id.trim() !== "");
  return (
    score1 >= 0 &&
    score2 >= 0 &&
    score1 <= needed &&
    score2 <= needed &&
    !(score1 === needed && score2 === needed) &&
    games > 0 &&
    usable.length === games
  );
}

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
  const [replayIds, setReplayIds] = useState<string[]>([]);

  const needed = Math.ceil(entry.bestOf / 2);
  const games = newGames(entry, score1, score2);
  // The list is resized to the score rather than being a free-form textarea:
  // one box per game is the shape of the rule, so an off-by-one is visible
  // before the request rather than after it.
  const rows = Array.from({ length: games }, (_, index) => replayIds[index] ?? "");
  const ready = isSubmittable(entry, score1, score2, rows);

  const teamName = (teamId: string | null): string => {
    const team = event.teams.find((candidate) => candidate.id === teamId);
    if (team === undefined) return t("tournaments.bracket.tbd");
    const named = team.name.trim();
    if (named !== "") return named;
    return event.players.find((player) => player.id === team.playerIds[0])?.name ?? named;
  };

  const setRow = (index: number, value: string) => {
    const next = [...rows];
    next[index] = value;
    setReplayIds(next);
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

      <fieldset className="tournament-field">
        <legend>{t("tournaments.report.replayIds")}</legend>
        <small className="muted">{t("tournaments.report.replayHint")}</small>
        {rows.map((id, index) => (
          // The index is the identity here: these are positional slots in a
          // list that only ever grows or shrinks at the end.
          <input
            key={index}
            value={id}
            inputMode="numeric"
            placeholder={t("tournaments.report.replayPlaceholder")}
            onChange={(changed) => setRow(index, changed.target.value)}
            autoFocus={index === 0}
          />
        ))}
        {games === 0 && <p className="muted">{t("tournaments.report.nothingNew")}</p>}
      </fieldset>

      <div className="tournament-form-actions">
        <Button onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" disabled={busy || !ready} onClick={() =>
          onSubmit({
            matchId: entry.id,
            score1,
            score2,
            replayIds: rows.map((id) => id.trim()).filter((id) => id !== ""),
            drawReplayIds: [],
          })
        }>
          {t(busy ? "tournaments.match.reporting" : "tournaments.match.submit")}
        </Button>
      </div>
    </Modal>
  );
}
