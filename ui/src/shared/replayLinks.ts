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
