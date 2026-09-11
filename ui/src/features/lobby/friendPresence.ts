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
/**
 * The friend list as this function wants it: lower-cased once, for the whole
 * browser, instead of once per game.
 *
 * The browser lists a hundred games and rebuilds every row whenever the lobby
 * sends a snapshot, which is several times a second. Building the same set of
 * a few dozen names inside each of those rows was a measurable part of what
 * that cost.
 */
export function friendKeys(friends: string[]): ReadonlySet<string> {
  return new Set(friends.map((friend) => friend.toLocaleLowerCase()));
}

export function friendsInGame(game: Game, wanted: ReadonlySet<string>): string[] {
  if (wanted.size === 0) return [];
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
