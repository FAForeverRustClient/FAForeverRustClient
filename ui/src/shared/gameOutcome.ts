// How a player's game ended, as the vault spells it and as the client says it.
//
// Shared because two features read it: the replay roster and the matchmaker
// tab's recent games.

import { t } from "../i18n";

export type OutcomeKind = "victory" | "defeat" | "draw" | "";

export function parseOutcome(outcome: string): OutcomeKind {
  switch (outcome.toLocaleUpperCase()) {
    case "VICTORY": return "victory";
    case "DEFEAT": return "defeat";
    case "DRAW":
    case "MUTUAL_DRAW": return "draw";
    default: return "";
  }
}

export function outcomeLabel(outcome: string): string {
  const kind = parseOutcome(outcome);
  switch (kind) {
    case "victory": return t("replays.roster.victory");
    case "defeat": return t("replays.roster.defeat");
    case "draw": return t("replays.roster.draw");
    default: return "";
  }
}
