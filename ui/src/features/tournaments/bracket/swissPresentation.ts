// The words and small rules around a Swiss stage's playoffs and its pick
// phase, as the website writes them (`playoffPickText`, `playoffOriginHTML`,
// `drawPickPhase`). Presentation only: the service decides everything these
// describe, so there is no Rust twin, only tests.

import type { MessageKey } from "../../../i18n";
import type { PickMode, PickPhase, SwissCuts, Tourney } from "../../../ipc/bindings";
import { standings } from "../../../shared/rules/tourneyRules";
import { teamNameOf } from "./matchParts";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

/** A seed's place in the phase's field, from 1. */
export function pickSeed(picks: PickPhase, teamId: string): number | null {
  const at = picks.field.indexOf(teamId);
  return at === -1 ? null : at + 1;
}

/** A team's Swiss record as the phase states it, `3-0`. */
export function pickRecord(picks: PickPhase, teamId: string): string | null {
  return picks.records.find((held) => held.teamId === teamId)?.record ?? null;
}

/** Seconds as `m:ss`. */
export function clockText(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** A playoff of 4, 8, 16, 32 or more: what picking needs. */
export function isFullBracket(size: number): boolean {
  return size >= 4 && (size & (size - 1)) === 0;
}

/** The unbeaten record (`3-0`), or null without a win cut. */
function unbeaten(cuts: SwissCuts): string | null {
  return cuts.wins > 0 ? `${cuts.wins}-0` : null;
}

/** The lowest record through (`3-2`), or null without both cuts. */
function lowest(cuts: SwissCuts): string | null {
  return cuts.wins > 0 && cuts.losses > 0 ? `${cuts.wins}-${cuts.losses - 1}` : null;
}

/** Who picks, as one option of the setup's select: `playoffPickText`. */
export function pickOptionText(pick: PickMode | null, cuts: SwissCuts, t: Translate): string {
  const record = unbeaten(cuts) ?? t("tournaments.playoffs.noLosses");
  if (pick === null) return t("tournaments.playoffs.pickOff");
  if (pick === "half") return t("tournaments.playoffs.pickHalf");
  if (pick === "unbeaten") return t("tournaments.playoffs.pickUnbeaten", { record });
  return t("tournaments.playoffs.pickBottom", { record, lowest: lowest(cuts) ?? t("tournaments.playoffs.lowestThrough") });
}

/** What a choice of who picks means, with the full-bracket caveat. */
export function pickHelpText(pick: PickMode | null, cutTo: number, cuts: SwissCuts, t: Translate): string {
  const half = Math.floor(cutTo / 2);
  const text =
    pick === null
      ? t("tournaments.playoffs.helpOff")
      : pick === "half"
        ? t("tournaments.playoffs.helpHalf", { top: half, from: half + 1, to: cutTo })
        : pick === "unbeaten"
          ? t("tournaments.playoffs.helpUnbeaten")
          : t("tournaments.playoffs.helpBottom", { lowest: lowest(cuts) ?? t("tournaments.playoffs.lowestThrough") });
  return pick !== null && !isFullBracket(cutTo)
    ? `${text} ${t("tournaments.playoffs.notFull", { count: cutTo })}`
    : text;
}

/** How equal records are ordered, in a sentence. */
export function tiebreakText(event: Tourney, t: Translate): string {
  return t(event.swissTiebreak === "beaten" ? "tournaments.playoffs.tiebreakBeaten" : "tournaments.playoffs.tiebreakGd");
}

/**
 * Whether a Swiss event's Bracket section is its bracket rather than its
 * rounds: once the playoffs exist, the website's tab and stepper say Bracket.
 */
export function swissShowsBracket(event: Tourney): boolean {
  return event.playoffs !== null && (event.playoffs.made || event.playoffs.built);
}

/** Where the playoff bracket came from, once it is built: `playoffOriginHTML`. */
export function playoffOrigin(event: Tourney, t: Translate): string {
  const picks = event.picks;
  const name = (teamId: string) => teamNameOf(event, teamId) ?? teamId;
  const pairs = (list: [string, string][]) => list.map(([one, two]) => `${name(one)} vs ${name(two)}`).join(" · ");
  if (picks === null || !picks.stageTwo) return t("tournaments.playoffs.originSeeded");
  const chosen = picks.picks.map((made) => [made.picker, made.target] as [string, string]);
  if (picks.unbeaten) {
    const rest = pairs(picks.drawn);
    const restLine =
      rest === ""
        ? ""
        : ` ${t(picks.restSeeded ? "tournaments.playoffs.originRestSeeded" : "tournaments.playoffs.originRestDrawn", { pairs: rest })}`;
    return chosen.length === 0
      ? `${t("tournaments.playoffs.originNobody")}${restLine}`
      : `${t("tournaments.playoffs.originUnbeaten", { pairs: pairs(chosen) })}${restLine}`;
  }
  return t("tournaments.playoffs.originHalf", { pairs: pairs(chosen) });
}

/**
 * The divisions of a Swiss played in divisions (King, Prince ...: #773), from
 * 1; empty for every other event.
 *
 * Since faf-tournaments#17 a team Swiss can be split like an elimination
 * bracket. Every division then plays its own Swiss with the event's settings:
 * its own rounds, records, table and final. No playoffs follow one, which the
 * service refuses.
 */
export function swissDivisions(event: Tourney): number[] {
  if (event.bracketKind !== "swiss" || event.competition !== "team" || event.divisions < 2) return [];
  return Array.from({ length: event.divisions }, (_, index) => index + 1);
}

/**
 * One division of such a Swiss, shaped as if it were the whole event: its own
 * teams and matches, so the rounds, the records and the table of a plain Swiss
 * all read it unchanged. The service's `swissOrder` lists each division's
 * table one after the other, and filtered to this division's teams it is that
 * division's order.
 *
 * Its champion is the winner of its own final. A division without a final is
 * won by the top of its table once the event is over, which is when every
 * division is (`swissDivisionChampion` on the service). The event's own
 * champion is the top division's.
 */
export function swissDivisionEvent(event: Tourney, division: number): Tourney {
  const teams = event.teams.filter((team) => team.division === division);
  const matches = event.matches.filter((entry) => entry.division === division);
  const view: Tourney = { ...event, teams, matches, championTeamId: null };
  const final = matches.find((entry) => entry.bracket === "grandFinal");
  if (final !== undefined) {
    return { ...view, championTeamId: final.status === "done" ? final.winner : null };
  }
  if (event.status !== "finished") return view;
  if (division === 1 && event.championTeamId !== null) return { ...view, championTeamId: event.championTeamId };
  return { ...view, championTeamId: standings(view)[0]?.teamId ?? null };
}
