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

import type { BrowsingPreferences } from "../../ipc/bindings";
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
 * The list after starring or unstarring one mod.
 *
 * Pure, so the reasoning about it is testable: the stored form is always the
 * folded one, and un-starring has to match a stored entry that may have been
 * written in any case by an older client.
 */
export function withFavoriteToggled(
  favorites: readonly string[] | null | undefined,
  uid: string,
): string[] {
  const key = uid.trim().toLocaleLowerCase();
  const current = favorites ?? [];
  return current.some((favorite) => favorite.trim().toLocaleLowerCase() === key)
    ? current.filter((favorite) => favorite.trim().toLocaleLowerCase() !== key)
    : [...current, key];
}

/** Star or unstar a mod, and persist it. */
export function toggleFavoriteMod(browsing: BrowsingPreferences, uid: string): void {
  ipc.send({
    kind: "Settings",
    command: {
      type: "setBrowsing",
      payload: {
        preferences: { ...browsing, favoriteMods: withFavoriteToggled(browsing.favoriteMods, uid) },
      },
    },
  });
}
