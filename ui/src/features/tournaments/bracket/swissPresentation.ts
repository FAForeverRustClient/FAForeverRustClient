// The words and small rules around a Swiss stage's playoffs and its pick
// phase, as the website writes them (`playoffPickText`, `playoffOriginHTML`,
// `drawPickPhase`). Presentation only: the service decides everything these
// describe, so there is no Rust twin, only tests.

import type { MessageKey } from "../../../i18n";
import type { PickMode, PickPhase, SwissCuts, Tourney } from "../../../ipc/bindings";
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
