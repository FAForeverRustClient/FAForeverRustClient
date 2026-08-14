import type { Game, LiveReplayFilters } from "../../ipc/bindings";
import {
  DEFAULT_LIVE_REPLAY_FILTERS,
  parseLiveReplayFilters,
} from "../../shared/browsingPreferences";

export const DEFAULT_LIVE_FILTERS = DEFAULT_LIVE_REPLAY_FILTERS;
export const parseLiveFilters = parseLiveReplayFilters;
/**
 * Anti-ghosting: a live stream is withheld for five minutes so nobody can watch
 * an ongoing game for an advantage. This drives the countdown on the Watch
 * button; the rule itself is enforced in the backend
 * (`faf_domain::state::replays::LIVE_REPLAY_DELAY_SECONDS`, checked in the
 * replay service), because the button is not the only route to a live watch, 
 * a Discord spectate click is another. Keep the two figures in step.
 */
export const LIVE_REPLAY_DELAY_SECONDS = 5 * 60;
export const LIVE_REPLAY_BATCH_SIZE = 75;

export type LiveSortKey = "started" | "title" | "players" | "rating" | "host" | "mods";
export type SortDirection = "ascending" | "descending";
export type LiveFilters = LiveReplayFilters;

export type IndexedLiveGame = {
  game: Game;
  players: string[];
  searchText: string;
  simModCount: number;
};

export function allGamePlayers(game: Game): string[] {
  return Object.values(game.teams).flat();
}

export function gameStartedAt(game: Game): Date | null {
  if (game.launchedAt === null || game.launchedAt <= 0) return null;
  const date = new Date(game.launchedAt * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function replayDelayRemaining(game: Game, now: number): number {
  const started = gameStartedAt(game);
  if (!started) return 0;
  return Math.max(0, Math.ceil(LIVE_REPLAY_DELAY_SECONDS - (now - started.getTime()) / 1000));
}

export function liveSortValue(game: Game, key: LiveSortKey): string | number {
  switch (key) {
    case "started": return game.launchedAt ?? 0;
    case "title": return game.title.toLocaleLowerCase();
    case "players": return game.players;
    case "rating": return game.averageRating;
    case "host": return game.host.toLocaleLowerCase();
    case "mods": return Object.keys(game.simMods).length;
  }
}

export function prettyGameType(gameType: string): string {
  if (!gameType) return "Custom";
  if (gameType.toLocaleLowerCase() === "matchmaker") return "Matchmaker";
  if (gameType.toLocaleLowerCase() === "coop") return "Co-op";
  return gameType.charAt(0).toLocaleUpperCase() + gameType.slice(1);
}
