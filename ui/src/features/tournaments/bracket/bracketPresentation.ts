// How the website draws an elimination bracket, as pure functions: which cards
// are not real games, what each column is called, how divisions are named,
// which matches an early finish left unplayed, and the preview drawn before
// the bracket exists.
//
// Kept apart from the view so each rule can be read and tested without
// rendering anything, and so the preview and the drawn bracket name their
// columns the same way.

import type { MessageKey, MessageValues } from "../../../i18n";
import type { BracketSide, PlanList, Tourney, TourneyMatch } from "../../../ipc/bindings";
import { thirdPlaceOn } from "../../../shared/rules/tourneyRules";

type Translate = (key: MessageKey, values?: MessageValues) => string;

/** The service's filler for an empty first-round slot. */
export const BYE = "BYE";

/**
 * A match that is not a game: a bye, or a losers-bracket match only a bye fed.
 * The website's `isPhantomMatch`. The service resolves these by itself (the
 * real side goes through, a bye goes on down the loser edge), so they are
 * never played and never drawn; whole early losers rounds can be nothing else.
 */
export function isPhantom(entry: TourneyMatch): boolean {
  return entry.team1 === BYE || entry.team2 === BYE;
}

/**
 * A column's heading, the website's `colLabel`: a single elimination names
 * its final and semi-final, a double elimination its winners final and its
 * losers rounds, and the grand final is what it is.
 */
export function columnLabel(
  event: Tourney,
  bracket: BracketSide,
  round: number,
  deepest: number,
  t: Translate,
): string {
  if (bracket === "grandFinal") return t("tournaments.bracket.colGrandFinal");
  if (bracket === "thirdPlace") return t("tournaments.bracket.colThirdPlace");
  if (bracket === "losers") {
    return round === deepest
      ? t("tournaments.bracket.colLbFinal")
      : t("tournaments.bracket.colLbRound", { round });
  }
  if (bracket === "winners") {
    if (event.bracketKind === "double" && event.stageTwoPlan === null && event.playoffs === null) {
      return round === deepest ? t("tournaments.bracket.colWbFinal") : t("tournaments.bracket.round", { round });
    }
    if (round === deepest) return t("tournaments.bracket.colFinal");
    if (round === deepest - 1) return t("tournaments.bracket.colSemi");
  }
  return t("tournaments.bracket.round", { round });
}

const DIVISION_KEYS: MessageKey[] = [
  "tournaments.bracket.divisionKing",
  "tournaments.bracket.divisionPrince",
  "tournaments.bracket.divisionDuke",
  "tournaments.bracket.divisionBaron",
  "tournaments.bracket.divisionKnight",
  "tournaments.bracket.divisionSquire",
];

/** "King division", "Prince division", ...: the website's names, in order. */
export function divisionLabel(division: number, t: Translate): string {
  const key = DIVISION_KEYS[division - 1];
  return key === undefined ? t("tournaments.bracket.divisionNumber", { number: division }) : t(key);
}

/**
 * Whether an early finish left this match unplayed: the website's
 * `neverPlayed`. An old record without the list counts every match that had
 * not finished.
 */
export function neverPlayed(event: Tourney, entry: TourneyMatch): boolean {
  const finish = event.earlyFinish;
  if (finish === null || entry.status === "done" || entry.status === "bye") return false;
  const unplayed = finish.unplayed ?? null;
  return unplayed === null ? true : unplayed.includes(entry.id);
}

// -- The preview -----------------------------------------------------------

/**
 * How many teams the bracket will be built from: the website's
 * `expectedTeamCount`. Only full teams enter, the cap holds, and before any
 * team forms the signups are the estimate.
 */
export function previewTeamCount(event: Tourney): number {
  const size = event.competition === "freeForAll" ? 1 : Math.max(event.teamSize, 1);
  const cap = event.maxTeams > 0 ? event.maxTeams : Number.POSITIVE_INFINITY;
  const projected = (() => {
    if (event.teams.length > 0) {
      if (event.status !== "signup") return Math.min(event.teams.length, cap);
      const full = event.teams.filter((team) => team.playerIds.length >= size).length;
      if (full > 0) return Math.min(full, cap);
    }
    if (event.maxTeams > 0) return event.maxTeams;
    return Math.min(Math.floor(event.players.length / size), cap);
  })();
  if (projected >= 2) return projected;
  if (event.competition === "freeForAll" || event.teamSize === 1) return Math.min(event.players.length, cap);
  return Math.min(Math.floor(event.players.length / Math.max(event.teamSize, 1)), cap);
}

/** The standard seed layout of a bracket of `size`: 1, 4, 3, 2 for four. */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const next: number[] = [];
    const width = order.length * 2;
    for (const seed of order) next.push(seed, width + 1 - seed);
    order = next;
  }
  return order;
}

export interface PreviewSlot {
  text: string;
  seed: number | null;
  /** A team already in that seed, rather than a placeholder. */
  real: boolean;
}

export interface PreviewCard {
  tag: string;
  bestOf: number;
  one: PreviewSlot;
  two: PreviewSlot;
}

export interface PreviewColumn {
  bracket: "winners" | "losers" | "grandFinal";
  round: number;
  label: string;
  bestOf: number;
  /** Where its best-of lives in the plan, for the organiser's select. */
  list: PlanList;
  index: number;
  /** In bracket order; `null` where a bye means no game, kept for spacing. */
  cards: (PreviewCard | null)[];
}

export interface BracketPreview {
  teams: number;
  winners: PreviewColumn[];
  losers: PreviewColumn[];
  third: PreviewCard | null;
}

interface VirtualMatch {
  id: string;
  bracket: "wb" | "lb" | "gf";
  round: number;
  index: number;
  winnerTo: { id: string; slot: number } | null;
  loserTo: { id: string; slot: number } | null;
}

/**
 * The topology `buildSingle` and `buildDouble` would produce for a bracket of
 * `size`: the website's `virtualBracket`, link for link, keyed by
 * `bracket:round:index`.
 */
function virtualBracket(size: number, double: boolean) {
  const rounds = Math.round(Math.log2(size));
  const make = (bracket: VirtualMatch["bracket"], round: number, index: number): VirtualMatch => ({
    id: `${bracket}:${round}:${index}`,
    bracket,
    round,
    index,
    winnerTo: null,
    loserTo: null,
  });
  const all: VirtualMatch[] = [];
  const wb: VirtualMatch[][] = [];
  const lb: VirtualMatch[][] = [];
  for (let round = 1; round <= rounds; round += 1) {
    wb[round] = [];
    for (let index = 0; index < size / 2 ** round; index += 1) {
      const held = make("wb", round, index);
      wb[round].push(held);
      all.push(held);
    }
  }
  if (double) {
    const lbRounds = 2 * rounds - 2;
    for (let q = 1; q <= lbRounds; q += 1) {
      lb[q] = [];
      const k = q % 2 === 1 ? (q + 3) / 2 : (q + 2) / 2;
      for (let index = 0; index < size / 2 ** k; index += 1) {
        const held = make("lb", q, index);
        lb[q].push(held);
        all.push(held);
      }
    }
    const gf = make("gf", 1, 0);
    all.push(gf);
    for (let round = 1; round <= rounds; round += 1) {
      wb[round].forEach((held, index) => {
        held.winnerTo =
          round < rounds ? { id: wb[round + 1][Math.floor(index / 2)].id, slot: (index % 2) + 1 } : { id: gf.id, slot: 1 };
        if (lbRounds === 0) return;
        if (round === 1) {
          held.loserTo = { id: lb[1][Math.floor(index / 2)].id, slot: (index % 2) + 1 };
        } else {
          const q = 2 * round - 2;
          const count = lb[q].length;
          const at = round % 2 === 0 ? count - 1 - index : index;
          held.loserTo = { id: lb[q][at].id, slot: 1 };
        }
      });
    }
    for (let q = 1; q <= lbRounds; q += 1) {
      lb[q].forEach((held, index) => {
        if (q === lbRounds) held.winnerTo = { id: gf.id, slot: 2 };
        else if (q % 2 === 1) held.winnerTo = { id: lb[q + 1][index].id, slot: 2 };
        else held.winnerTo = { id: lb[q + 1][Math.floor(index / 2)].id, slot: (index % 2) + 1 };
      });
    }
  } else {
    for (let round = 1; round < rounds; round += 1) {
      wb[round].forEach((held, index) => {
        held.winnerTo = { id: wb[round + 1][Math.floor(index / 2)].id, slot: (index % 2) + 1 };
      });
    }
  }
  const feeders = new Map<string, { kind: "winner" | "loser"; from: VirtualMatch }>();
  for (const held of all) {
    if (held.winnerTo !== null) feeders.set(`${held.winnerTo.id}:${held.winnerTo.slot}`, { kind: "winner", from: held });
    if (held.loserTo !== null) feeders.set(`${held.loserTo.id}:${held.loserTo.slot}`, { kind: "loser", from: held });
  }
  return { rounds, wb, lb, feeders };
}

/**
 * The bracket as it will be drawn, before it is: the website's
 * `drawBracketPreview`. Byes are not games and are left out, and so are the
 * losers matches only a bye would feed; a slot a bye passes straight through
 * names the seed that goes through rather than a match that is never played.
 */
export function bracketPreview(event: Tourney, t: Translate): BracketPreview {
  const teams = previewTeamCount(event);
  const empty: BracketPreview = { teams, winners: [], losers: [], third: null };
  if (teams < 2) return empty;
  const double = event.bracketKind === "double";
  let size = 1;
  while (size < teams) size *= 2;
  const order = seedOrder(size);
  const vb = virtualBracket(size, double);
  const rounds = vb.rounds;
  const names = new Map(event.teams.filter((team) => team.seed > 0).map((team) => [team.seed, team.name]));
  const plan = event.plan;
  const lists = event.planLists;

  const seedSlot = (seed: number): PreviewSlot => {
    const name = names.get(seed);
    return name === undefined
      ? { text: t("tournaments.preview.seed", { seed }), seed, real: false }
      : { text: name, seed, real: true };
  };
  const tbd = (text: string): PreviewSlot => ({ text, seed: null, real: false });
  const vLabel = (held: VirtualMatch) =>
    held.bracket === "gf"
      ? t("tournaments.bracket.grandFinal")
      : `${held.bracket === "lb" ? "LB " : double ? "WB " : ""}R${held.round} M${held.index + 1}`;

  const listed = (list: (number | null)[], index: number, fallback: number) =>
    event.perRoundBo ? (list[index] ?? fallback) : fallback;
  const boForRound = (round: number): number => {
    if (plan?.type === "double") {
      const fallback = round === rounds ? plan.payload.wbFinal : plan.payload.wb;
      return listed(lists.winners, round - 1, fallback);
    }
    const single = plan?.type === "single" ? plan.payload : null;
    const fallback =
      round === rounds ? (single?.finalBo ?? 5) : round === rounds - 1 ? (single?.semi ?? 3) : (single?.early ?? 3);
    return listed(lists.rounds, round - 1, fallback);
  };

  // Which virtual matches are real games, and what a slot they feed reads.
  const cache = new Map<string, { winnerExists: boolean; realGame: boolean; loserExists: boolean; label: PreviewSlot }>();
  const firstPair = (index: number) => [order[index * 2], order[index * 2 + 1]] as const;
  const liveOf = (id: string): { winnerExists: boolean; realGame: boolean; loserExists: boolean; label: PreviewSlot } => {
    const held = cache.get(id);
    if (held !== undefined) return held;
    const [bracket, roundText, indexText] = id.split(":");
    const round = Number(roundText);
    const index = Number(indexText);
    let result;
    if (bracket === "wb" && round === 1) {
      const [one, two] = firstPair(index);
      const real = (one <= teams ? 1 : 0) + (two <= teams ? 1 : 0);
      result = {
        winnerExists: real >= 1,
        realGame: real === 2,
        loserExists: real === 2,
        label:
          real === 2
            ? tbd(t("tournaments.matches.winnerOf", { match: vLabel(vb.wb[1][index]) }))
            : seedSlot(one <= teams ? one : two),
      };
    } else {
      const feed = (slot: number) => {
        const feeder = vb.feeders.get(`${id}:${slot}`);
        if (feeder === undefined) return { exists: false, label: null as PreviewSlot | null };
        const info = liveOf(feeder.from.id);
        return feeder.kind === "winner"
          ? { exists: info.winnerExists, label: info.label }
          : { exists: info.loserExists, label: tbd(t("tournaments.matches.loserOf", { match: vLabel(feeder.from) })) };
      };
      const a = feed(1);
      const b = feed(2);
      const real = (a.exists ? 1 : 0) + (b.exists ? 1 : 0);
      const selfMatch =
        bracket === "lb" ? vb.lb[round][index] : bracket === "gf" ? null : vb.wb[round][index];
      result = {
        winnerExists: real >= 1,
        realGame: real === 2,
        loserExists: real === 2,
        label:
          real === 2
            ? tbd(
                t("tournaments.matches.winnerOf", {
                  match: selfMatch === null ? t("tournaments.bracket.grandFinal") : vLabel(selfMatch),
                }),
              )
            : ((a.exists ? a.label : b.label) ?? tbd(t("tournaments.bracket.tbd"))),
      };
    }
    cache.set(id, result);
    return result;
  };
  const slotLabel = (id: string, slot: number): PreviewSlot => {
    const feeder = vb.feeders.get(`${id}:${slot}`);
    if (feeder === undefined) return tbd(t("tournaments.bracket.tbd"));
    const info = liveOf(feeder.from.id);
    if (feeder.kind === "winner") return info.winnerExists ? info.label : tbd(t("tournaments.bracket.tbd"));
    return info.loserExists
      ? tbd(t("tournaments.matches.loserOf", { match: vLabel(feeder.from) }))
      : tbd(t("tournaments.bracket.tbd"));
  };

  const winners: PreviewColumn[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const bestOf = boForRound(round);
    const cards = vb.wb[round].map((held, index): PreviewCard | null => {
      if (round === 1) {
        const [one, two] = firstPair(index);
        if (one > teams || two > teams) return null;
        return { tag: vLabel(held), bestOf, one: seedSlot(one), two: seedSlot(two) };
      }
      if (!liveOf(held.id).realGame) return null;
      return { tag: vLabel(held), bestOf, one: slotLabel(held.id, 1), two: slotLabel(held.id, 2) };
    });
    winners.push({
      bracket: "winners",
      round,
      label: columnLabel(event, "winners", round, rounds, t),
      bestOf,
      list: double ? "winners" : "rounds",
      index: round - 1,
      cards,
    });
  }
  const losers: PreviewColumn[] = [];
  if (double) {
    const lbRounds = 2 * rounds - 2;
    for (let q = 1; q <= lbRounds; q += 1) {
      const fallback = plan?.type === "double" ? (q === lbRounds ? plan.payload.lbFinal : plan.payload.lb) : 3;
      const bestOf = listed(lists.losers, q - 1, fallback);
      const cards = vb.lb[q].map((held): PreviewCard | null =>
        liveOf(held.id).realGame
          ? { tag: vLabel(held), bestOf, one: slotLabel(held.id, 1), two: slotLabel(held.id, 2) }
          : null,
      );
      losers.push({
        bracket: "losers",
        round: q,
        label: columnLabel(event, "losers", q, lbRounds, t),
        bestOf,
        list: "losers",
        index: q - 1,
        cards,
      });
    }
    const gfBo = plan?.type === "double" ? plan.payload.gf : 5;
    winners.push({
      bracket: "grandFinal",
      round: 1,
      label: t("tournaments.bracket.colGrandFinal"),
      bestOf: gfBo,
      list: "grandFinal",
      index: 0,
      cards: [
        {
          tag: t("tournaments.bracket.grandFinal"),
          bestOf: gfBo,
          one: slotLabel("gf:1:0", 1),
          two: slotLabel("gf:1:0", 2),
        },
      ],
    });
  }
  const third =
    !double && rounds >= 2 && teams >= 4 && thirdPlaceOn(event) && event.divisions <= 1
      ? {
          tag: t("tournaments.bracket.thirdPlace"),
          bestOf: boForRound(rounds - 1),
          one: tbd(t("tournaments.matches.loserOf", { match: vLabel(vb.wb[rounds - 1][0]) })),
          two: tbd(t("tournaments.matches.loserOf", { match: vLabel(vb.wb[rounds - 1][1]) })),
        }
      : null;
  return { teams, winners, losers, third };
}
