// Where everyone finished, or stands right now.
//
// Three tables behind one heading, because a reader wants the same thing from
// all of them and the format is not their concern: Swiss is a record, an
// elimination bracket is a depth, an import is a placing somebody else decided.
// Which one applies is `standingsKind`, and the columns follow from it.
//
// The rows come from `shared/tourneyRules`, which is a twin of
// `Tourney::standings` pinned by the conformance harness. The service sends no
// table at all: the website works one out in the browser and so do we, so the
// only thing keeping the three honest is that pin.

import type { PlayerSummary, Tourney, TourneyTeam } from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerChip } from "./PlayerChip";
import { BRACKET_LABELS } from "./tourneyPresentation";
import { profileOf, standings, standingsKind, teamMembers } from "../../shared/tourneyRules";

const OUTCOME_LABELS: Record<"champion" | "stillIn" | "lostFinal" | "placed", MessageKey> = {
  champion: "tournaments.standings.champion",
  stillIn: "tournaments.standings.stillIn",
  lostFinal: "tournaments.standings.lostFinal",
  placed: "tournaments.standings.placed",
};

interface StandingsPanelProps {
  event: Tourney;
  profiles: PlayerSummary[];
}

export function StandingsPanel({ event, profiles }: StandingsPanelProps) {
  const { t } = useTranslation();
  const kind = standingsKind(event);
  const rows = standings(event);

  if (kind === "none" || rows.length === 0) {
    return <p className="muted">{t("tournaments.standings.none")}</p>;
  }

  const teamOf = (teamId: string): TourneyTeam | undefined =>
    event.teams.find((team) => team.id === teamId);

  /* A solo event's "team" is one person, so it is shown as the person: the
     bracket already does this, and a table that said "Ada's team" beside a
     bracket that said "Ada" would read as two different entrants. */
  const nameOf = (teamId: string) => {
    const team = teamOf(teamId);
    if (team === undefined) return teamId;
    if (event.teamSize === 1) {
      const only = teamMembers(event, team)[0];
      if (only !== undefined) {
        const profile = profileOf(profiles, only);
        return profile ? <PlayerChip player={profile} overrideName={only.name} /> : only.name;
      }
    }
    const named = team.name.trim();
    return named === "" ? teamId : named;
  };

  const resultOf = (row: (typeof rows)[number]) => {
    if (typeof row.outcome === "object") {
      return t("tournaments.standings.outIn", {
        round: t(BRACKET_LABELS[row.outcome.outIn.bracket]),
        number: row.outcome.outIn.round,
      });
    }
    if (row.outcome === "swiss") return "";
    return t(OUTCOME_LABELS[row.outcome]);
  };

  return (
    <div className="tournament-standings">
      <table>
        <thead>
          <tr>
            <th scope="col">{t("tournaments.standings.place")}</th>
            <th scope="col">
              {t(event.teamSize === 1 ? "tournaments.standings.player" : "tournaments.standings.team")}
            </th>
            {kind === "swiss" && (
              <>
                <th scope="col">{t("tournaments.standings.wins")}</th>
                <th scope="col">{t("tournaments.standings.losses")}</th>
                <th scope="col">{t("tournaments.standings.gameDiff")}</th>
              </>
            )}
            {/* A points table carries its total in the same field a Swiss table
                keeps wins in, so only the heading differs. */}
            {kind === "points" && <th scope="col">{t("tournaments.standings.points")}</th>}
            {kind !== "swiss" && kind !== "points" && (
              <th scope="col">{t("tournaments.standings.result")}</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.teamId}
              /* Only the podium is marked, and only once the place is real: a
                 leader mid-event has no place yet and must not look like one. */
              className={row.place !== null && row.place <= 3 ? `rank-${row.place}` : undefined}
            >
              <td className="mono">
                {row.place ?? t("tournaments.standings.unplaced")}
                {row.outcome === "champion" && " \u{1F3C6}"}
              </td>
              <td>{nameOf(row.teamId)}</td>
              {kind === "swiss" && (
                <>
                  <td className="mono">{row.wins}</td>
                  <td className="mono">{row.losses}</td>
                  <td className="mono">
                    {row.gameDiff > 0 ? "+" : ""}
                    {row.gameDiff}
                  </td>
                </>
              )}
              {kind === "points" && <td className="mono">{row.wins}</td>}
              {kind !== "swiss" && kind !== "points" && (
                <td className="muted">{resultOf(row)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
