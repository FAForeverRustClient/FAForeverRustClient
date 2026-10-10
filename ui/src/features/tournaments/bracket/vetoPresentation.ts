// How a match's vetoes are read: the ban and pick run in the order it was
// walked, and how many steps this account still owes.
//
// Presentation only, taken from the website (`vetoOrderedLog`,
// `myVetoStepCount` in its `app.bracket.js`). The service keeps the state and
// decides every turn; nothing here is a rule it enforces.

import type { MatchVeto, Tourney, TourneyFaction, TourneyMatch } from "../../../ipc/bindings";
import { factionVetoOn, vetoTurn } from "../../../shared/rules/tourneyRules";

export interface VetoLogEntry {
  kind: "ban" | "pick";
  map: string;
  by: string;
  /** Which game a pick is played as. */
  game: number | null;
}

/**
 * The bans and picks in the order they were made.
 *
 * The service keeps them in two lists, so the order is recovered by walking
 * the sequence up to the current step. Anything left over, which only a run
 * edited under its own feet could produce, is appended rather than dropped.
 */
export function vetoLog(veto: MatchVeto): VetoLogEntry[] {
  const log: VetoLogEntry[] = [];
  let bans = 0;
  let picks = 0;
  const walked = Math.min(veto.done ? veto.sequence.length : veto.stepIndex, veto.sequence.length);
  for (let index = 0; index < walked; index += 1) {
    const step = veto.sequence[index];
    const choice = step.action === "ban" ? veto.banned[bans++] : veto.picks[picks++];
    if (choice !== undefined) {
      log.push({ kind: step.action, map: choice.map, by: choice.by, game: choice.game });
    }
  }
  for (; bans < veto.banned.length; bans += 1) {
    const choice = veto.banned[bans];
    log.push({ kind: "ban", map: choice.map, by: choice.by, game: null });
  }
  for (; picks < veto.picks.length; picks += 1) {
    const choice = veto.picks[picks];
    log.push({ kind: "pick", map: choice.map, by: choice.by, game: choice.game });
  }
  return log;
}

/** Whether this account captains the team the map veto is waiting on. */
export function myMapVetoTurn(event: Tourney, entry: TourneyMatch): boolean {
  if (entry.veto === null || !event.veto.enabled || entry.status === "done") return false;
  const turn = vetoTurn(entry.veto);
  if (turn === null) return false;
  const team = event.teams.find((held) => held.id === turn.teamId);
  const me = event.viewer.signedUpPlayerId;
  return team !== undefined && me !== null && team.captainId === me;
}

/** How many games of this match still wait on this account's faction choices. */
export function myFactionGamesOwed(event: Tourney, entry: TourneyMatch): number {
  if (entry.factionVeto === null || !factionVetoOn(event) || entry.status === "done") return 0;
  return entry.factionVeto.games.filter((game) => game.next !== null).length;
}

/**
 * The steps this account owes on one match: a map ban or pick that is due,
 * and every game that still wants its factions. What the Vetoes tab's badge
 * and the match's own button count.
 */
export function myVetoSteps(event: Tourney, entry: TourneyMatch): number {
  return (myMapVetoTurn(event, entry) ? 1 : 0) + myFactionGamesOwed(event, entry);
}

/** Whether a match has any veto the viewer can open: a map run, or factions. */
export function hasVeto(event: Tourney, entry: TourneyMatch): boolean {
  return (
    (entry.veto !== null && event.veto.enabled) ||
    (entry.factionVeto !== null && factionVetoOn(event))
  );
}

/**
 * Whether a match's vetoes are over: every run it has, the maps and the
 * factions. A 1v1 can have both, and the map run ending used to read as the
 * whole match settled while the faction choices were still owed, so the
 * Matches tab said Ready and the Vetoes tab filed it as done (issue 367).
 */
export function vetoSettled(event: Tourney, entry: TourneyMatch): boolean {
  if (entry.status === "done") return true;
  const maps = entry.veto !== null && event.veto.enabled ? entry.veto.done : null;
  const factions =
    entry.factionVeto !== null && factionVetoOn(event)
      ? entry.factionVeto.games.length > 0 && entry.factionVeto.games.every((game) => game.result !== null)
      : null;
  if (maps === null && factions === null) return false;
  return maps !== false && factions !== false;
}

/** The four factions in the order the website offers them. */
export const FACTIONS: ReadonlyArray<{ id: TourneyFaction }> = [
  { id: "uef" },
  { id: "aeon" },
  { id: "cybran" },
  { id: "seraphim" },
];
