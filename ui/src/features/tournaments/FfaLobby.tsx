// One free-for-all lobby, and the form for recording it.
//
// A lobby has entrants, not two sides, so the bracket's match card cannot draw
// it: `team1`/`team2` are both null and it would read as "TBD vs TBD". This is
// the same card for a different shape.
//
// The two ways it is settled are the service's, not a choice made here: a
// scored round wants a number for every entrant, everything else wants exactly
// the winners the format calls for. `ffaIsScored` says which, and the submit
// button is gated on the twin of the service's own check.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import type { FfaReport, PlayerSummary, Tourney, TourneyMatch } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerChip } from "./PlayerChip";
import {
  ffaIsScored,
  ffaReportIsSubmittable,
  ffaWinnersNeeded,
  mayReportFfa,
  profileOf,
  teamMembers,
} from "../../shared/tourneyRules";

interface FfaLobbyProps {
  event: Tourney;
  entry: TourneyMatch;
  profiles: PlayerSummary[];
  busy: boolean;
  onReport: (report: FfaReport) => void;
}

export function FfaLobby(props: FfaLobbyProps) {
  const { event, entry, busy } = props;
  const { t } = useTranslation();
  const scored = ffaIsScored(event, entry);
  const needed = ffaWinnersNeeded(event, entry);
  const [open, setOpen] = useState(false);
  const [points, setPoints] = useState<Record<string, string>>({});
  const [winners, setWinners] = useState<string[]>([]);

  const nameOf = (teamId: string) => {
    const team = event.teams.find((held) => held.id === teamId);
    if (team === undefined) return teamId;
    if (event.teamSize === 1) {
      const only = teamMembers(event, team)[0];
      if (only !== undefined) {
        const profile = profileOf(props.profiles, only);
        return profile ? <PlayerChip player={profile} overrideName={only.name} /> : only.name;
      }
    }
    const named = team.name.trim();
    return named === "" ? teamId : named;
  };

  const scoreOf = (teamId: string) =>
    entry.points.find((scored) => scored.teamId === teamId)?.points ?? null;

  const draft: FfaReport = {
    matchId: entry.id,
    winners: scored ? [] : winners,
    points: scored
      ? entry.entrants.map((teamId) => ({
          teamId,
          points: Number((points[teamId] ?? "").trim()),
        }))
      : [],
  };
  const submittable = ffaReportIsSubmittable(draft, entry, scored, needed);

  return (
    <div className="tournament-ffa-lobby surface">
      <header className="tournament-ffa-head">
        <span>{t("tournaments.ffa.lobby", { round: entry.round, index: entry.index + 1 })}</span>
        {entry.isFinal && <span className="muted">{t("tournaments.ffa.final")}</span>}
      </header>

      <ul className="tournament-ffa-entrants">
        {entry.entrants.map((teamId) => {
          const score = scoreOf(teamId);
          const through = entry.winners.includes(teamId);
          return (
            <li key={teamId} className={through ? "is-through" : undefined}>
              <span>{nameOf(teamId)}</span>
              {score !== null && <span className="mono">{score}</span>}
              {through && <span className="muted">{t("tournaments.ffa.through")}</span>}
            </li>
          );
        })}
      </ul>

      {mayReportFfa(event, entry) &&
        (open ? (
          <form
            className="tournament-ffa-form"
            onSubmit={(submitted) => {
              submitted.preventDefault();
              if (!submittable) return;
              props.onReport(draft);
              setOpen(false);
            }}
          >
            {scored ? (
              <>
                <p className="muted">{t("tournaments.ffa.pointsHint")}</p>
                {entry.entrants.map((teamId) => (
                  <label className="tournament-field" key={teamId}>
                    <span>{nameOf(teamId)}</span>
                    <input
                      inputMode="numeric"
                      value={points[teamId] ?? ""}
                      onChange={(changed) =>
                        setPoints((held) => ({ ...held, [teamId]: changed.target.value }))
                      }
                    />
                  </label>
                ))}
              </>
            ) : (
              <>
                <p className="muted">{t("tournaments.ffa.winnersHint", { count: needed })}</p>
                {entry.entrants.map((teamId) => (
                  <label className="tournament-checkbox" key={teamId}>
                    <input
                      type="checkbox"
                      checked={winners.includes(teamId)}
                      onChange={() =>
                        setWinners((held) =>
                          held.includes(teamId)
                            ? held.filter((id) => id !== teamId)
                            : [...held, teamId],
                        )
                      }
                    />
                    <span>{nameOf(teamId)}</span>
                  </label>
                ))}
              </>
            )}
            <div className="tournament-detail-actions">
              <Button type="submit" variant="primary" disabled={busy || !submittable}>
                {t("tournaments.ffa.save")}
              </Button>
              <Button type="button" disabled={busy} onClick={() => setOpen(false)}>
                {t("tournaments.ffa.cancel")}
              </Button>
            </div>
          </form>
        ) : (
          <Button disabled={busy} onClick={() => setOpen(true)}>
            {t(entry.status === "done" ? "tournaments.ffa.correct" : "tournaments.ffa.report")}
          </Button>
        ))}
    </div>
  );
}
