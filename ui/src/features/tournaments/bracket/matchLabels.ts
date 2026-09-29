// How a match is named and ordered in the lists that are not the bracket: the
// Matches tab and the Vetoes tab.
//
// The website's own short codes (`mLabel` in its `app.bracket.js`): "R2 M1",
// "WB R1 M3", "LB R2 M1", "Final" or "Grand final". Presentation only; the
// division is added where an event has several, which the website leaves out
// and which made two divisions' "R1 M1" read as one match.

import type { BracketSide, Tourney, TourneyMatch } from "../../../ipc/bindings";
import type { MessageKey, MessageValues } from "../../../i18n";
import { roundPlan } from "../../../shared/rules/tourneyRules";
import { BRACKET_LABELS } from "../tourneyPresentation";

type Translate = (key: MessageKey, values?: MessageValues) => string;

/**
 * Whether a Swiss event has a playoff bracket after its stage: then its
 * bracket matches are named as playoffs, not as a Swiss final, the website's
 * `twoStage`.
 */
export function isTwoStage(event: Tourney): boolean {
  return event.bracketKind === "swiss" && (event.playoffs !== null || event.stageTwoPlan !== null);
}

/** A match's short code, e.g. "WB R1 M3". */
export function matchLabel(event: Tourney, entry: TourneyMatch, t: Translate): string {
  const twoStage = isTwoStage(event);
  const double = event.playoffs?.double ?? event.stageTwoPlan?.double ?? false;
  if (entry.bracket === "grandFinal") {
    if (twoStage) return t(double ? "tournaments.bracket.grandFinal" : "tournaments.swiss.final");
    return t(event.bracketKind === "swiss" ? "tournaments.swiss.final" : "tournaments.bracket.grandFinal");
  }
  if (entry.bracket === "thirdPlace") {
    return t(twoStage ? "tournaments.playoffs.thirdLabel" : "tournaments.bracket.thirdPlace");
  }
  const number = `R${entry.round} M${entry.index + 1}`;
  if (twoStage && (entry.bracket === "winners" || entry.bracket === "losers")) {
    const deepest = Math.max(
      0,
      ...event.matches.filter((held) => held.bracket === entry.bracket).map((held) => held.round),
    );
    if (entry.bracket === "winners" && !double && entry.round === deepest) {
      return t("tournaments.playoffs.finalLabel");
    }
    const side = entry.bracket === "losers" ? "LB " : double ? "WB " : "";
    return `${t("tournaments.swiss.playoffs")} ${side}${number}`;
  }
  const division = entry.division > 0 ? `D${entry.division} ` : "";
  switch (entry.bracket) {
    case "losers":
      return `${division}LB ${number}`;
    case "winners":
      return event.bracketKind === "double" ? `${division}WB ${number}` : `${division}${number}`;
    default:
      return `${division}${number}`;
  }
}

/**
 * Where a match sits in play order: by round, winners before losers inside a
 * round, the grand final last. The website's `rank`. The 3rd place match
 * carries the final's round and is listed beside it.
 */
export function matchRank(entry: TourneyMatch): number {
  return (
    (entry.bracket === "grandFinal" ? 1000 : 0) +
    entry.round * 10 +
    (entry.bracket === "losers" || entry.bracket === "thirdPlace" ? 1 : 0)
  );
}

/** Earliest first, then the server's own order inside a round. */
export function byPlayOrder(left: TourneyMatch, right: TourneyMatch): number {
  return matchRank(left) - matchRank(right) || left.index - right.index;
}

export interface Feeder {
  from: TourneyMatch;
  kind: "winner" | "loser";
}

/**
 * Which match feeds each empty slot: "Winner of R1 M2". Keyed by
 * `${matchId}:${slot}`, read off every match's `winnerTo` and `loserTo`.
 */
export function feedersOf(matches: TourneyMatch[]): Map<string, Feeder> {
  const feeders = new Map<string, Feeder>();
  for (const entry of matches) {
    if (entry.winnerTo !== null) {
      feeders.set(`${entry.winnerTo.matchId}:${entry.winnerTo.slot}`, { from: entry, kind: "winner" });
    }
    if (entry.loserTo !== null) {
      feeders.set(`${entry.loserTo.matchId}:${entry.loserTo.slot}`, { from: entry, kind: "loser" });
    }
  }
  return feeders;
}

/**
 * A round's name as the bracket itself would say it.
 *
 * "Semifinals" rather than "Winners round 3", because that is what an organiser
 * calls the round they are assigning maps to. Only the deepest rounds get a
 * name; anything earlier stays numbered, which is also what the website does.
 */
export function roundKeyLabel(
  t: Translate,
  bracket: string,
  round: number,
  lastRound: number,
): string {
  if (bracket === "grandFinal") return t("tournaments.pools.roundGrandFinal");
  if (bracket === "thirdPlace") return t("tournaments.bracket.thirdPlace");
  if (bracket === "swiss") return t("tournaments.pools.roundSwiss", { round });
  if (bracket === "losers") {
    return round === lastRound
      ? t("tournaments.pools.roundLosersFinal")
      : t("tournaments.pools.roundLosers", { round });
  }
  if (round === lastRound) return t("tournaments.pools.roundFinal");
  if (round === lastRound - 1) return t("tournaments.pools.roundSemi");
  if (round === lastRound - 2) return t("tournaments.pools.roundQuarter");
  return `${t(BRACKET_LABELS[bracket as keyof typeof BRACKET_LABELS])} ${t("tournaments.bracket.round", { round })}`;
}

const WIRE_BRACKETS: Record<string, BracketSide> = {
  wb: "winners",
  lb: "losers",
  gf: "grandFinal",
  "3p": "thirdPlace",
  sw: "swiss",
  ffa: "freeForAll",
};

/**
 * A service round key ("wb:2", "sw:3", "match:m1") as a round's name, for the
 * "used for" and "played in" lines of the Maps tab. A pool bound to one match
 * rather than a round says so.
 */
export function labelForRoundKey(event: Tourney, key: string, t: Translate): string {
  if (key.startsWith("match:")) return t("tournaments.maps.oneMatch");
  const [wire, number] = key.split(":");
  const bracket = WIRE_BRACKETS[wire];
  const round = Number(number);
  if (bracket === undefined || !Number.isFinite(round)) return key;
  const lastRound = roundPlan(event)
    .keys.filter((held) => held.bracket === bracket)
    .reduce((most, held) => Math.max(most, held.round), round);
  return roundKeyLabel(t, bracket, round, lastRound);
}
