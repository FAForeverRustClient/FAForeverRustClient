// Where everyone finished, or stands right now.
//
// Three tables behind one heading, because a reader wants the same thing from
// all of them and the format is not their concern: Swiss is a record, an
// elimination bracket is a depth, an import is a placing somebody else decided.
// Which one applies is `standingsKind`, and the columns follow from it.
//
// The rows come from `shared/rules/tourneyRules`, which is a twin of
// `Tourney::standings` pinned by the conformance harness. The service sends no
// table at all: the website works one out in the browser and so do we, so the
// only thing keeping the three honest is that pin.

import type { PlayerSummary, Tourney, TourneyTeam } from "../../../ipc/bindings";
import type { Standing, StandingsKind } from "../../../shared/rules/tourneyRules";
import { tiebreakText } from "./swissPresentation";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { EntrantName } from "../EntrantName";
import { useTourneyDisplay } from "../display";
import { BRACKET_LABELS } from "../tourneyPresentation";
import { profileOf, standings, standingsKind, teamMembers } from "../../../shared/rules/tourneyRules";

const OUTCOME_LABELS: Record<
  "champion" | "stillIn" | "lostFinal" | "wonThirdPlace" | "lostThirdPlace" | "placed",
  MessageKey
> = {
  champion: "tournaments.standings.champion",
  stillIn: "tournaments.standings.stillIn",
  lostFinal: "tournaments.standings.lostFinal",
  wonThirdPlace: "tournaments.standings.wonThirdPlace",
  lostThirdPlace: "tournaments.standings.lostThirdPlace",
  placed: "tournaments.standings.placed",
};

interface StandingsPanelProps {
  event: Tourney;
  profiles: PlayerSummary[];
}

/**
 * An import's own tables: one per group, then its final placings. Shown instead
 * of anything worked out here, as the website does, because they are the
 * source's record and the matches behind them never came over.
 */
function ImportedTables({ event }: { event: Tourney }) {
  const { t } = useTranslation();
  return (
    <div className="tournament-standings">
      {event.importedGroups.map((group) => (
        <section className="tournament-panel" key={group.name}>
          <h4>{group.name}</h4>
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">{t("tournaments.standings.player")}</th>
                <th scope="col">{t("tournaments.standings.winLoss")}</th>
                <th scope="col">{t("tournaments.standings.games")}</th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row, index) => (
                <tr key={`${row.name}-${index}`}>
                  <td className="mono muted">{index + 1}</td>
                  <td>{row.name}</td>
                  <td className="mono">
                    {row.wins}
                    {"–"}
                    {row.losses}
                  </td>
                  <td className="mono">
                    {row.gamesWon}
                    {"–"}
                    {row.gamesLost}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      {event.importedStandings.length > 0 && (
        <section className="tournament-panel">
          <h4>{t("tournaments.standings.finalPlacings")}</h4>
          <ol className="tournament-placings">
            {event.importedStandings.map((placing, index) => (
              <li
                key={`${placing.name}-${index}`}
                className={placing.rank <= 3 ? `rank-${placing.rank}` : undefined}
              >
                <span className="mono">{placing.rank}</span>
                <span>{placing.name}</span>
              </li>
            ))}
          </ol>
          <p className="muted">{t("tournaments.standings.placingsNote")}</p>
        </section>
      )}
    </div>
  );
}

export function StandingsPanel({ event, profiles }: StandingsPanelProps) {
  const { t } = useTranslation();
  const display = useTourneyDisplay();
  const kind = standingsKind(event);
  const rows = standings(event);

  // The whole table would give every result away at once.
  if (display.streamer) {
    return <p className="muted">{t("tournaments.display.standingsHidden")}</p>;
  }

  if (event.imported && (event.importedGroups.length > 0 || event.importedStandings.length > 0)) {
    return <ImportedTables event={event} />;
  }

  if (kind === "none" || rows.length === 0) {
    return <p className="muted">{t("tournaments.standings.none")}</p>;
  }

  if (kind !== "swiss") return <StandingsTable event={event} profiles={profiles} kind={kind} rows={rows} />;

  // A Swiss with playoffs: the playoffs decide the places, so their table
  // comes first, worked out like any elimination bracket's from the playoff
  // matches and field. The Swiss table below is how everyone got there.
  const playoffs = event.playoffs;
  const field = playoffs !== null && playoffs.built ? playoffs.field : [];
  const playoffEvent: Tourney | null =
    field.length > 0
      ? {
          ...event,
          bracketKind: playoffs?.double === true ? "double" : "single",
          teams: event.teams.filter((team) => field.includes(team.id)),
          matches: event.matches.filter((entry) => entry.bracket !== "swiss"),
        }
      : null;
  const playoffRows = playoffEvent === null ? [] : standings(playoffEvent);
  const cuts = event.swissCuts;
  const withCuts = cuts.wins > 0 || cuts.losses > 0;
  const cutTo = playoffs?.cutTo ?? event.stageTwoPlan?.cutTo ?? 0;
  const cutLabel =
    cuts.wins > 0 && cuts.losses > 0
      ? t("tournaments.swiss.cutBoth", { wins: cuts.wins, losses: cuts.losses })
      : cuts.wins > 0
        ? t("tournaments.swiss.cutWins", { wins: cuts.wins })
        : t("tournaments.swiss.cutLosses", { losses: cuts.losses });
  const note = [withCuts ? cutLabel : "", cutTo > 0 ? t("tournaments.standings.throughToPlayoffs", { count: cutTo }) : ""]
    .filter((part) => part !== "")
    .join(" · ");

  return (
    <div className="tournament-stats">
      {playoffEvent !== null && playoffRows.length > 0 && (
        <section className="tournament-panel">
          <h4>{t("tournaments.standings.playoffTitle")}</h4>
          <StandingsTable
            event={playoffEvent}
            profiles={profiles}
            kind={standingsKind(playoffEvent)}
            rows={playoffRows}
          />
        </section>
      )}
      <section className="tournament-panel">
        {playoffEvent !== null && <h4>{t("tournaments.standings.swissTitle")}</h4>}
        {note !== "" && <p className="muted">{note}</p>}
        {event.swissTiebreak === "beaten" && <p className="muted">{tiebreakText(event, t)}</p>}
        <StandingsTable event={event} profiles={profiles} kind={kind} rows={rows} withStatus={withCuts} />
      </section>
    </div>
  );
}

interface StandingsTableProps {
  event: Tourney;
  profiles: PlayerSummary[];
  kind: StandingsKind;
  rows: Standing[];
  /** A Swiss stage with record cuts says what each record means. */
  withStatus?: boolean;
}

function StandingsTable({ event, profiles, kind, rows, withStatus = false }: StandingsTableProps) {
  const { t } = useTranslation();
  const cuts = event.swissCuts;
  const statusOf = (row: Standing) => {
    if (cuts.wins > 0 && row.wins >= cuts.wins) {
      return <span className="tournament-badge is-ok">{t("tournaments.standings.qualified")}</span>;
    }
    if (cuts.losses > 0 && row.losses >= cuts.losses) {
      return <span className="tournament-badge">{t("tournaments.standings.eliminated")}</span>;
    }
    const need = [
      cuts.wins > 0 ? t("tournaments.standings.moreWins", { count: cuts.wins - row.wins }) : "",
      cuts.losses > 0 ? t("tournaments.standings.lossesLeft", { count: cuts.losses - row.losses }) : "",
    ].filter((part) => part !== "");
    return <span className="muted">{need.join(" · ")}</span>;
  };

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
        return <EntrantName name={only.name} fafId={only.fafId} profile={profile} />;
      }
    }
    const named = team.name.trim();
    return named === "" ? teamId : named;
  };

  const showBeaten = kind === "swiss" && rows.some((row) => row.beaten !== null);

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
                {/* Only where the event breaks ties this way, so the order the
                    server sends can be checked against the number behind it. */}
                {showBeaten && (
                  <th scope="col" title={t("tournaments.standings.beatenHint")}>
                    {t("tournaments.standings.beaten")}
                  </th>
                )}
              </>
            )}
            {/* A points table carries its total in the same field a Swiss table
                keeps wins in, so only the heading differs. */}
            {kind === "points" && <th scope="col">{t("tournaments.standings.points")}</th>}
            {kind !== "swiss" && kind !== "points" && (
              <th scope="col">{t("tournaments.standings.result")}</th>
            )}
            {withStatus && <th scope="col">{t("tournaments.standings.status")}</th>}
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
                  {showBeaten && <td className="mono">{row.beaten ?? 0}</td>}
                </>
              )}
              {kind === "points" && <td className="mono">{row.wins}</td>}
              {kind !== "swiss" && kind !== "points" && (
                <td className="muted">{resultOf(row)}</td>
              )}
              {withStatus && <td>{statusOf(row)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
