// The Players section's side column: how full the field is, and how strong.
//
// Presentation only, so no conformance twin. Counted from the detail the
// service sends, the same players the table lists.

import type { Tourney } from "../../ipc/bindings";

export interface FieldSummary {
  /** What is counted: a solo event's players, a team event's teams. */
  unit: "players" | "teams";
  count: number;
  /** The floor the event runs with and its cap, 0 where there is none. */
  min: number;
  max: number;
  /** The tournament ratings of the field, where two or more have one. */
  ratings: { high: number; average: number; low: number } | null;
}

/**
 * How full the field is and how strong it is.
 *
 * The limits are the organiser's `minTeams` and `maxTeams`, which count
 * entries: a player in a solo event or a free-for-all, a team otherwise, so
 * that is what is counted against them, as the website's Players page does.
 * A team counts once it is full, which is when the website lists it as a
 * participant. The minimum is a target only: the service never checks it, and
 * the organiser decides whether to start short. The cap is enforced at signup
 * for solo entrants and named teams; teams formed past it in an open event
 * wait for a place. The ratings are the ones this event seeds on, capped
 * where the event caps them, the same numbers the table shows.
 */
export function fieldSummary(event: Tourney): FieldSummary {
  const solo = event.competition === "freeForAll" || event.teamSize === 1;
  const rated = event.players
    .map((player) => player.rating)
    .filter((rating): rating is number => rating !== null);
  return {
    unit: solo ? "players" : "teams",
    count: solo
      ? event.playerCount
      : event.teams.filter((team) => team.playerIds.length >= event.teamSize).length,
    min: event.minTeams,
    max: event.maxTeams,
    ratings:
      rated.length < 2
        ? null
        : {
            high: Math.max(...rated),
            average: Math.round(rated.reduce((sum, rating) => sum + rating, 0) / rated.length),
            low: Math.min(...rated),
          },
  };
}
