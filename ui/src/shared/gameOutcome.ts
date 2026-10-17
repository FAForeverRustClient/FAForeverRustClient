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

/**
 * One team's result, by the priority Java's `calculateTeamOutcome` uses:
 * a victory anywhere in the team wins, then a draw, then a defeat, and only a
 * team where nobody has a recorded outcome is unknown.
 *
 * The server keeps an outcome per army, not per team: a team-mate whose
 * commander died, or who recalled, is stored as a defeat in a game their team
 * won. Taking the first player who happens to have one, or the reader's own,
 * is therefore not the same thing as the team's result (#589).
 */
export function teamOutcome(players: readonly { outcome: string }[]): OutcomeKind | "unknown" {
  const kinds = players.map((player) => parseOutcome(player.outcome)).filter(Boolean);
  if (kinds.includes("victory")) return "victory";
  if (kinds.includes("draw")) return "draw";
  if (kinds.includes("defeat")) return "defeat";
  return "unknown";
}
