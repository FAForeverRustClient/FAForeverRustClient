// How many players are in Galactic War right now, as the game itself counts
// them.

import type { GalacticWarStatistics } from "../../../ipc/bindings";

/**
 * Commanders online: the sum of every faction's online avatars.
 *
 * Not `season.numOnlinePlayers`. That counts connections to the gateway,
 * including players still creating their avatar and connections the server
 * has not noticed are gone, and it read 6 while the game's own faction bar
 * showed 1 + 0 + 0 + 0 (#498). The game's bar is what players compare the
 * client against, and per faction it is `numOnlineAvatars`, so the total is
 * their sum: the faction cards and the total cannot disagree.
 */
export function onlineCommanders(statistics: GalacticWarStatistics | null | undefined): number {
  return (statistics?.factions ?? []).reduce(
    (total, faction) => total + Math.max(0, faction.numOnlineAvatars ?? 0),
    0,
  );
}
