// Starred mods, shared by the vault and the installed list.
//
// One list, `browsing.favoriteMods`, holding mod uids folded to lower case.
// The vault has had the star since it had presets; the installed list is where
// the star is actually worth something, because that is the screen on which a
// player turns their usual set on before a game.
//
// Both halves live here rather than beside either screen, so the two cannot
// drift on the one thing that would break silently: which spelling of a uid
// counts as the same mod.

import type { BrowsingPreferences, SettingsCommand } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";

/** The stored favourites as a set that can be asked about a uid. */
export function favoriteModKeys(favorites: readonly string[] | null | undefined): Set<string> {
  return new Set((favorites ?? []).map((uid) => uid.trim().toLocaleLowerCase()));
}

/** Whether this mod is starred, given that set. */
export function isFavoriteMod(favorites: ReadonlySet<string>, uid: string): boolean {
  return favorites.has(uid.trim().toLocaleLowerCase());
}

/**
 * The command that stars or unstars one mod.
 *
 * Names the one uid and the direction, never the resulting list: the backend
 * applies it to the list it holds. Sending the toggled list instead lost a
 * star, because two clicks inside one round trip each started from the same
 * snapshot, so the second list did not hold the first star. The backend folds
 * the uid and matches an entry an older client stored in any case.
 */
export function favoriteModToggle(
  favorites: readonly string[] | null | undefined,
  uid: string,
): SettingsCommand {
  return {
    type: "setListMember",
    payload: {
      list: "favoriteMods",
      value: uid,
      member: !isFavoriteMod(favoriteModKeys(favorites), uid),
    },
  };
}

/** Star or unstar a mod, and persist it. */
export function toggleFavoriteMod(browsing: BrowsingPreferences, uid: string): void {
  ipc.send({ kind: "Settings", command: favoriteModToggle(browsing.favoriteMods, uid) });
}
