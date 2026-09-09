import type { Game } from "../../ipc/bindings";

/**
 * Who on your friends list is sitting in this lobby.
 *
 * The browser lists every open game on the server, a hundred of them on a busy
 * evening, and the only thing that ever said "somebody you know is in this one"
 * was the host's name being drawn in the friend colour. That misses the more
 * common case entirely: a friend who joined a stranger's lobby is invisible,
 * and the host colour is a chat setting that can be turned off.
 *
 * Returns the game's own spelling of each name, host first and the rest in the
 * order the lobby reported them, with duplicates removed. Matching is
 * case-insensitive because a login's case is not stable across the two places
 * these names come from.
 */
export function friendsInGame(game: Game, friends: string[]): string[] {
  if (friends.length === 0) return [];
  const wanted = new Set(friends.map((friend) => friend.toLocaleLowerCase()));
  const found: string[] = [];
  const seen = new Set<string>();
  const consider = (name: string) => {
    const key = name.toLocaleLowerCase();
    if (!wanted.has(key) || seen.has(key)) return;
    seen.add(key);
    found.push(name);
  };
  consider(game.host);
  for (const team of Object.values(game.teams)) {
    for (const player of team) consider(player);
  }
  return found;
}
