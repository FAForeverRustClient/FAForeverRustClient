// How a Swiss round is read: which record each side brought into it, and in
// which order its matches are listed.
//
// The website's own rules (`swissRecordsBefore`, `swissMatchRecord`,
// `swissQueueSort` in its `app.js`), and presentation only, so no Rust twin:
// the server pairs the rounds, and nothing here decides anything. What they
// answer is the question a column of cards could not: why these two meet.
// Swiss pairs teams of equal record, so a round listed best group first, with
// the record on each match, explains itself.

import type { Tourney, TourneyMatch } from "../../../ipc/bindings";
import { roundsFor, swissCutRounds } from "../../../shared/rules/tourneyRules";

/** The side of a Swiss bye that is nobody. */
export const BYE = "BYE";

export interface SwissRecord {
  wins: number;
  losses: number;
}

/** A Swiss match: its own bracket, and not the final that may follow it. */
export function isSwissMatch(entry: TourneyMatch): boolean {
  return entry.bracket === "swiss";
}

/** Whether one side of this match is a bye rather than a team. */
export function isBye(entry: TourneyMatch): boolean {
  return entry.team1 === BYE || entry.team2 === BYE || entry.status === "bye";
}

/**
 * Each team's wins and losses from the Swiss rounds before `round`.
 *
 * The record a team brought *into* the round, which is what the pairing used,
 * not the one it has now: a finished round would otherwise show every match
 * with the result already counted. A bye counts as a win for the side that had
 * it.
 */
export function swissRecordsBefore(
  matches: TourneyMatch[],
  round: number,
): Map<string, SwissRecord> {
  const records = new Map<string, SwissRecord>();
  const of = (teamId: string): SwissRecord => {
    let held = records.get(teamId);
    if (held === undefined) {
      held = { wins: 0, losses: 0 };
      records.set(teamId, held);
    }
    return held;
  };
  for (const entry of matches) {
    if (!isSwissMatch(entry) || entry.round >= round) continue;
    if (isBye(entry)) {
      const side = entry.team1 !== BYE ? entry.team1 : entry.team2;
      if (side !== null && side !== BYE) of(side).wins += 1;
      continue;
    }
    if (entry.status !== "done") continue;
    if (entry.winner !== null) of(entry.winner).wins += 1;
    if (entry.loser !== null) of(entry.loser).losses += 1;
  }
  return records;
}

function recordOf(records: Map<string, SwissRecord>, teamId: string | null): SwissRecord {
  return (teamId === null ? undefined : records.get(teamId)) ?? { wins: 0, losses: 0 };
}

/**
 * The record chip on a match, "2-1", or "2-1 vs 1-2" for a pairing that
 * floated a team into another group. Null in round 1, where everybody is 0-0,
 * and on a bye.
 */
export function swissMatchRecord(
  entry: TourneyMatch,
  records: Map<string, SwissRecord>,
): string | null {
  if (!isSwissMatch(entry) || entry.round < 2 || isBye(entry)) return null;
  if (entry.team1 === null || entry.team2 === null) return null;
  const one = recordOf(records, entry.team1);
  const two = recordOf(records, entry.team2);
  const left = `${one.wins}-${one.losses}`;
  const right = `${two.wins}-${two.losses}`;
  return left === right ? left : `${left} vs ${right}`;
}

/**
 * The score group a match is listed under: "2-0", "1-1".
 *
 * A floated pairing belongs to the lower of its two groups, by the fewer wins
 * and the more losses of its sides, which is also where `swissRoundOrder`
 * puts it.
 */
export function swissGroupOf(entry: TourneyMatch, records: Map<string, SwissRecord>): string {
  const one = recordOf(records, entry.team1);
  const two = recordOf(records, entry.team2);
  return `${Math.min(one.wins, two.wins)}-${Math.max(one.losses, two.losses)}`;
}

/**
 * A round's matches, best score group first.
 *
 * More wins first, then fewer losses, then the server's own order. A floated
 * pairing sorts with the lower of its two groups, because it is ranked by the
 * fewer wins and the more losses of its two sides.
 */
export function swissRoundOrder(
  matches: TourneyMatch[],
  records: Map<string, SwissRecord>,
): TourneyMatch[] {
  const rank = (entry: TourneyMatch): [number, number] => {
    const one = recordOf(records, entry.team1);
    const two = recordOf(records, entry.team2);
    return [Math.min(one.wins, two.wins), Math.max(one.losses, two.losses)];
  };
  return [...matches].sort((left, right) => {
    const [leftWins, leftLosses] = rank(left);
    const [rightWins, rightLosses] = rank(right);
    return rightWins - leftWins || leftLosses - rightLosses || left.index - right.index;
  });
}

/**
 * How many Swiss rounds the event will play.
 *
 * The record cuts where there are any, then the draw's own count, then the
 * default a field of this size gets: `ceil(log2(teams))`.
 */
export function plannedSwissRounds(event: Tourney): number {
  return (
    swissCutRounds(event.swissCuts) ??
    (event.swissRounds > 0 ? event.swissRounds : roundsFor(Math.max(event.teams.length, 2)))
  );
}
