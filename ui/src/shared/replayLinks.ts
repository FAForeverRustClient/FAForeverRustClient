import type { Game } from "../ipc/bindings";

/** Direct replay-vault URL copied by both reference clients. */
export function onlineReplayLink(uid: number): string {
  return `https://replay.faforever.com/${uid}`;
}

/**
 * Python-client `GameUrl` format for a live replay shared in chat.
 *
 * The loopback authority is an identifier, not a connection destination when
 * clicked in this client: chat resolves the UID against authoritative lobby
 * state before it dispatches a watch command.
 */
export function liveReplayLink(game: Game, player: string): string {
  const safePlayer = player.trim() || "spectator";
  const query = new URLSearchParams({
    map: game.map,
    mod: game.modName || "faf",
  });
  return `faflive://127.0.0.1/${game.id}/${encodeURIComponent(safePlayer)}.SCFAreplay?${query}`;
}
