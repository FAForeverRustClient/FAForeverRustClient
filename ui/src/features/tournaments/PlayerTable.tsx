// A list of people as a table, ranked by the rating the event seeds on.
//
// One table for the two places that answer "who is in this": the Players
// section, which is everybody, and the free agents under the Teams section,
// which is everybody a team never took. They were drifting apart as two
// hand-written lists, and the difference between them is two optional columns.

import type { PlayerSummary, Tourney, TourneyPlayer, TourneyTeam } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerChip } from "./PlayerChip";
import { rankedEntrants } from "./tourneyPresentation";
import { profileOf } from "../../shared/tourneyRules";

/** A cell with nothing in it, drawn rather than left blank so the row reads. */
const NO_RATING = "–";

interface PlayerTableProps {
  event: Tourney;
  profiles: PlayerSummary[];
  /** Which people to draw. Ranked here, so the caller passes any order. */
  players: TourneyPlayer[];
  /** Name each player's team. Off where every row would say the same thing. */
  showTeam?: boolean;
  /** Seed, check-in and placing. Off before there is anything to say. */
  showStanding?: boolean;
}

export function PlayerTable({
  event,
  profiles,
  players,
  showTeam = false,
  showStanding = false,
}: PlayerTableProps) {
  const { t } = useTranslation();

  const teamOf = (player: TourneyPlayer): TourneyTeam | null =>
    player.teamId === null
      ? null
      : (event.teams.find((team) => team.id === player.teamId) ?? null);

  const teamName = (team: TourneyTeam): string => {
    const named = team.name.trim();
    if (named !== "") return named;
    // A team that never named itself reads as its first member, which is how
    // the bracket names it too.
    const first = event.players.find((player) => player.id === team.playerIds[0]);
    return first?.name ?? team.id;
  };

  return (
    <div className="tournament-entrants">
      <table>
        <thead>
          <tr>
            <th scope="col">{t("tournaments.entrants.rank")}</th>
            <th scope="col">{t("tournaments.entrants.player")}</th>
            <th scope="col">{t("tournaments.entrants.ratingColumn")}</th>
            {showTeam && <th scope="col">{t("tournaments.entrants.team")}</th>}
            {showStanding && <th scope="col">{t("tournaments.entrants.standing")}</th>}
          </tr>
        </thead>
        <tbody>
          {rankedEntrants(players).map((player, index) => {
            const profile = profileOf(profiles, player);
            const team = teamOf(player);
            const mine = team !== null && team.id === event.viewer.memberTeamId;
            return (
              <tr key={player.id} className={mine ? "is-mine" : undefined}>
                {/* Row position in this ranking, not a seed: the seed is the
                    organiser's decision and has its own column. */}
                <td className="mono muted">{index + 1}</td>
                <td>
                  <span className="tournament-entrant-name">
                    {profile ? (
                      <PlayerChip player={profile} overrideName={player.name} />
                    ) : (
                      player.name
                    )}
                    {player.note !== "" && <span className="muted"> ({player.note})</span>}
                    {player.pending && (
                      <span className="tournament-badge">{t("tournaments.entrants.pending")}</span>
                    )}
                    {player.late && (
                      <span className="tournament-badge">{t("tournaments.entrants.late")}</span>
                    )}
                    {player.manual && (
                      <span className="tournament-badge" title={t("tournaments.entrants.manual")}>
                        {t("tournaments.entrants.manualShort")}
                      </span>
                    )}
                  </span>
                </td>
                {/* The tournament's own rating, not the account's: it is taken
                    as of the event's rating date and may have been capped, so
                    the two really can differ and the one that decides seeding
                    is this one. */}
                <td className="mono" title={t("tournaments.entrants.rating")}>
                  {player.rating === null ? (
                    <span className="muted">{NO_RATING}</span>
                  ) : (
                    <>
                      {player.rating}
                      {player.ratingActual !== null && player.ratingActual !== player.rating && (
                        <span className="muted" title={t("tournaments.entrants.capped")}>
                          {" "}
                          ({player.ratingActual})
                        </span>
                      )}
                    </>
                  )}
                </td>
                {showTeam && (
                  <td className="muted">{team === null ? NO_RATING : teamName(team)}</td>
                )}
                {showStanding && (
                  <td className="tournament-entrant-standing">
                    {team !== null && team.seed > 0 && (
                      <span className="muted">
                        {t("tournaments.entrants.seed", { seed: team.seed })}
                      </span>
                    )}
                    {team !== null && team.checkedIn && (
                      <span className="tournament-badge is-running">
                        {t("tournaments.entrants.checkedIn")}
                      </span>
                    )}
                    {team !== null && team.finalRank !== null && (
                      <span className="tournament-badge">
                        {t("tournaments.entrants.finalRank", { rank: team.finalRank })}
                      </span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
