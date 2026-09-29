// The Stats tab's numbers, worked out from the event itself.
//
// The website has no endpoint for these: `drawStats` counts them in the
// browser from the tournament document once the event is over, and so does
// this, rule for rule, so both show the same figures for the same event.
//
// Presentation only: nothing here decides anything the service acts on, so it
// has no Rust twin and no conformance pin, only its own tests.

import type { Tourney } from "../../ipc/bindings";
import { teamRating } from "../../shared/rules/tourneyRules";

export interface TeamTotal {
  teamId: string;
  name: string;
  rating: number;
}

export interface MapUse {
  mapId: string;
  name: string;
  count: number;
}

export interface EventStats {
  /** One person per team: the team counts are left out then. */
  solo: boolean;
  signups: number;
  /** The mean rating of those with one, rounded; null where nobody has one. */
  averageRating: number | null;
  rated: number;
  /** Players on a team that has anybody on it: who actually played. */
  onTeams: number;
  teams: number;
  /** Head-to-head series with a result. Free-for-all lobbies are not series. */
  series: number;
  /** Single games across those series; a walkover adds none. */
  games: number;
  forfeits: number;
  /** Forfeits that were walkovers: no game was played at all. */
  decidedByForfeit: number;
  vetoesDone: number;
  mapsInDatabase: number;
  /** Every map the event could have been played on, and how often it was. */
  mapUse: MapUse[];
  /** Teams by their combined rating, strongest first. */
  teamTotals: TeamTotal[];
}

/** The website's `drawStats` figures for an event. */
export function eventStats(event: Tourney): EventStats {
  const done = event.matches.filter((entry) => entry.status === "done" && entry.bracket !== "freeForAll");
  const solo = event.teamSize === 1 || event.formation === "solo";

  let games = 0;
  let forfeits = 0;
  let decidedByForfeit = 0;
  const plays = new Map<string, number>();
  const played = (mapId: string) => plays.set(mapId, (plays.get(mapId) ?? 0) + 1);
  for (const entry of done) {
    // A walkover is recorded with a negative score on one side: no game at all.
    const walkover = entry.forfeit !== null && ((entry.score1 ?? 0) < 0 || (entry.score2 ?? 0) < 0);
    if (entry.forfeit !== null) {
      forfeits += 1;
      if (walkover) decidedByForfeit += 1;
    }
    if (!walkover) games += Math.max(entry.score1 ?? 0, 0) + Math.max(entry.score2 ?? 0, 0);
    // Only what a veto chose: maps pinned to a round are not counted, as on
    // the website.
    if (entry.veto !== null) {
      for (const pick of entry.veto.picks) played(pick.map);
      if (entry.veto.decider !== null) played(entry.veto.decider.map);
    }
  }

  const rated = event.players.filter((player) => player.rating !== null);
  const averageRating =
    rated.length > 0
      ? Math.round(rated.reduce((total, player) => total + (player.rating ?? 0), 0) / rated.length)
      : null;

  const fullTeams = event.teams.filter((team) => team.playerIds.length > 0);
  const fullIds = new Set(fullTeams.map((team) => team.id));
  const nameOf = (teamId: string) => {
    const team = event.teams.find((held) => held.id === teamId);
    const named = team?.name.trim() ?? "";
    if (named !== "") return named;
    return event.players.find((player) => player.id === team?.playerIds[0])?.name ?? teamId;
  };
  const teamTotals = fullTeams
    .map((team) => ({ teamId: team.id, name: nameOf(team.id), rating: teamRating(event, team) }))
    .sort((left, right) => right.rating - left.rating);

  const known = new Map<string, string>(event.mapDb.map((map) => [map.id, map.name]));
  for (const mapId of plays.keys()) if (!known.has(mapId)) known.set(mapId, mapId);
  const mapUse = [...known.entries()]
    .map(([mapId, name]) => ({ mapId, name, count: plays.get(mapId) ?? 0 }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

  return {
    solo,
    signups: event.players.length,
    averageRating,
    rated: rated.length,
    onTeams: event.players.filter((player) => player.teamId !== null && fullIds.has(player.teamId)).length,
    teams: fullTeams.length,
    series: done.length,
    games,
    forfeits,
    decidedByForfeit,
    vetoesDone: done.filter((entry) => entry.veto?.done === true).length,
    mapsInDatabase: event.mapDb.length,
    mapUse,
    teamTotals,
  };
}

/** How many maps were played how often, most played first: `{ count, maps }`. */
export function usageBuckets(mapUse: MapUse[]): { count: number; maps: number }[] {
  const byCount = new Map<number, number>();
  for (const use of mapUse) byCount.set(use.count, (byCount.get(use.count) ?? 0) + 1);
  return [...byCount.entries()]
    .sort((left, right) => right[0] - left[0])
    .map(([count, maps]) => ({ count, maps }));
}
