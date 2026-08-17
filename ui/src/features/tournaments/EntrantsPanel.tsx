// Who has entered, grouped the way the event is played.
//
// A solo event is a list of people; a 2v2 is a list of teams with people in
// them. One component for both, because the model already is: a solo entrant is
// a team of one, which is what keeps the bracket uniform whatever the size.

import type { PlayerSummary, Tourney, TourneyPlayer } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerChip } from "./PlayerChip";
import { profileOf, teamMembers } from "./tourneyPresentation";

interface EntrantsPanelProps {
  event: Tourney;
  profiles: PlayerSummary[];
}

export function EntrantsPanel({ event, profiles }: EntrantsPanelProps) {
  const { t } = useTranslation();

  if (event.players.length === 0) {
    return <p className="muted">{t("tournaments.entrants.none")}</p>;
  }

  const row = (player: TourneyPlayer) => {
    const profile = profileOf(profiles, player);
    return (
      <li className="tournament-entrant" key={player.id}>
        <span className="tournament-entrant-name">
          {profile ? <PlayerChip player={profile} overrideName={player.name} /> : player.name}
        </span>
        {/* The tournament's own rating, not the account's: it is taken as of
            the event's rating date and may have been capped, so the two really
            can differ and the one that decides seeding is this one. */}
        {player.rating !== null && (
          <span className="muted" title={t("tournaments.entrants.rating")}>
            {player.rating}
            {player.ratingActual !== null && player.ratingActual !== player.rating && (
              <span title={t("tournaments.entrants.capped")}> ({player.ratingActual})</span>
            )}
          </span>
        )}
        {player.pending && (
          <span className="tournament-badge">{t("tournaments.entrants.pending")}</span>
        )}
        {player.late && <span className="tournament-badge">{t("tournaments.entrants.late")}</span>}
      </li>
    );
  };

  // Teams have not been formed yet during signups, so fall back to the flat
  // list rather than showing nothing.
  const grouped = event.teams.length > 0;
  if (!grouped) {
    return <ul className="tournament-entrant-list">{event.players.map(row)}</ul>;
  }

  const mine = event.viewer.memberTeamId;
  const teamed = new Set(event.teams.flatMap((team) => team.playerIds));
  const unteamed = event.players.filter((player) => !teamed.has(player.id));

  return (
    <div className="tournament-entrants">
      <ul className="tournament-team-list">
        {[...event.teams]
          .sort((left, right) => left.seed - right.seed)
          .map((team) => {
            const members = teamMembers(event, team);
            const name =
              team.name.trim() !== "" ? team.name : (members[0]?.name ?? team.id);
            return (
              <li
                className={
                  team.id === mine
                    ? "surface tournament-team is-mine"
                    : team.eliminated
                      ? "surface tournament-team is-eliminated"
                      : "surface tournament-team"
                }
                key={team.id}
              >
                <div className="tournament-team-header">
                  <span className="tournament-team-name">{name}</span>
                  {team.seed > 0 && (
                    <span className="muted">
                      {t("tournaments.entrants.seed", { seed: team.seed })}
                    </span>
                  )}
                  {team.checkedIn && (
                    <span className="tournament-badge is-running">
                      {t("tournaments.entrants.checkedIn")}
                    </span>
                  )}
                  {team.finalRank !== null && (
                    <span className="tournament-badge">
                      {t("tournaments.entrants.finalRank", { rank: team.finalRank })}
                    </span>
                  )}
                </div>
                {/* Every member listed, not just the captain: the whole point
                    of a team event is knowing who you are actually playing. */}
                <ul className="tournament-entrant-list">{members.map(row)}</ul>
              </li>
            );
          })}
      </ul>

      {unteamed.length > 0 && (
        <>
          <h5>{t("tournaments.entrants.unteamed")}</h5>
          <ul className="tournament-entrant-list">{unteamed.map(row)}</ul>
        </>
      )}
    </div>
  );
}
