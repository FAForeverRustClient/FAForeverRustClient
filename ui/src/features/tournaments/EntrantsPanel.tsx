// Who has entered.
//
// One table of people, ranked by the rating this event seeds on, which is what
// the website shows and what a reader is actually looking for: am I in it, who
// else is, and where do I stand among them.
//
// It used to be a list of team cards with the members nested inside, and that
// was wrong in two ways at once. A solo event's entrant *is* a team of one, so
// every row printed the same name twice, once as the team and once as its only
// member, inside a card built to hold six. And a team event answered "who has
// entered" with a roster, which is the Teams tab's question, not this one.
// Team membership is a column here, exactly as on the website.

import type { PlayerSummary, Tourney } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerTable } from "./PlayerTable";

interface EntrantsPanelProps {
  event: Tourney;
  profiles: PlayerSummary[];
}

export function EntrantsPanel({ event, profiles }: EntrantsPanelProps) {
  const { t } = useTranslation();

  if (event.players.length === 0) {
    return <p className="muted">{t("tournaments.entrants.none")}</p>;
  }

  // Both extra columns are earned rather than always drawn: a 1v1 has no teams
  // to name, and an event that has not been seeded has nothing to say about
  // where anyone stands.
  const showStanding = event.teams.some(
    (team) => team.seed > 0 || team.checkedIn || team.finalRank !== null,
  );

  return (
    <PlayerTable
      event={event}
      profiles={profiles}
      players={event.players}
      showTeam={event.teamSize > 1}
      showStanding={showStanding}
    />
  );
}
