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

/**
 * Every team's result in one game, in the order given, observers (a negative
 * team) always `"unknown"`.
 *
 * Mostly `teamOutcome` per team, with the one rule that needs the whole game:
 * when every seated player is recorded as defeated, the game was a draw
 * (#776). That is how a drawn game is stored. Both commanders die, each army
 * reports its own defeat, and the server's `resolve_game`
 * (server/games/game_results.py) rates "everyone is DEFEAT" as a draw while
 * the per-player rows keep the DEFEAT they were reported with. Read team by
 * team, a drawn ladder game said Defeat beside a rating that went up.
 *
 * Only for two or more teams, and only when no seated player has anything but
 * a defeat: an unknown result next to the defeats is a game the server refused
 * to rate, not a draw.
 */
export function gameTeamOutcomes(
  teams: readonly { team: number; players: readonly { outcome: string }[] }[],
): (OutcomeKind | "unknown")[] {
  const seated = teams.filter((team) => team.team >= 0);
  const allDefeated =
    seated.length >= 2 &&
    seated.every(
      (team) => team.players.length > 0 && team.players.every((player) => parseOutcome(player.outcome) === "defeat"),
    );
  return teams.map((team) => {
    if (team.team < 0) return "unknown";
    return allDefeated ? "draw" : teamOutcome(team.players);
  });
}
