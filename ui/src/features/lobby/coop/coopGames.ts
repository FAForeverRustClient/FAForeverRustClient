// The open co-op games list: why it is empty, and which game Join means.

import type { Game, LobbyStatus } from "../../../ipc/bindings";
import { isCoopGame } from "../../../shared/gameRules";

/**
 * Why there is nothing to show, which decides what the pane says and offers.
 *
 * "No open co-op games right now" with a Host button used to stand for all of
 * these, so a player who was offline was offered a Host button that could not
 * work, and one whose search hid every game was told nobody was playing.
 */
export type CoopEmptyReason = "disconnected" | "connecting" | "none" | "filtered";

/** A co-op game the lobby lists, as the play tab counts them. */
export function isOpenCoopGame(game: Game): boolean {
  const matchmaker =
    game.gameType.toLocaleLowerCase() === "matchmaker" ||
    game.visibility.toLocaleLowerCase() === "matchmaker";
  return isCoopGame(game) && !matchmaker;
}

/** `openGames` is every open co-op game, before the search and the filters. */
export function coopEmptyReason(status: LobbyStatus, openGames: number): CoopEmptyReason {
  if (status === "disconnected") return "disconnected";
  if (status === "connecting") return "connecting";
  return openGames === 0 ? "none" : "filtered";
}

/**
 * The game the Join button joins: the one the player picked, while it is still
 * on screen, and never a stand-in. Falling back to the first row would put a
 * different game under the button whenever the picked one closed or was
 * filtered away, which is how a misclick joins the wrong game.
 */
export function joinableCoopGame(games: Game[], selectedId: number | null): Game | null {
  if (selectedId === null) return null;
  return games.find((game) => game.id === selectedId) ?? null;
}
