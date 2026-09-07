import type { Game } from "../ipc/bindings";

/** Direct replay-vault URL copied by both reference clients. */
export function onlineReplayLink(uid: number): string {
  return `https://replay.faforever.com/${uid}`;
}

/**
 * The vault game id in a replay link, if the address is one.
 *
 * The inverse of [`onlineReplayLink`], and the reason it exists: a build order
 * cites its replays by that address, and a client that opens a browser there
 * is a client that forgot it can play them. Deliberately strict about the
 * host, so that a link to some other page on some other site is still a link.
 */
export function replayUidFromLink(url: string): number | null {
  const match = /^https?:\/\/replay\.faforever\.com\/(\d+)\/?$/.exec(url.trim());
  if (!match) return null;
  const uid = Number(match[1]);
  return Number.isSafeInteger(uid) && uid > 0 ? uid : null;
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
