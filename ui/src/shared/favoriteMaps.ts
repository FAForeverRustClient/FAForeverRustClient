// The favourite maps, as one list wherever a map can be starred.
//
// The map vault and the host dialog each kept their own copy of "is this a
// favourite" and "star it" over the same browsing preference. Anything new
// that stars a map goes through here, so the three cannot drift apart.

import { ipc } from "../ipc/client";
import { useAppStore } from "../store/store";

/** Is this folder name among the favourites? Case-insensitive, like the list. */
export function useIsFavoriteMap(folderName: string): boolean {
  const key = folderName.toLocaleLowerCase();
  return useAppStore((state) =>
    state.state.settings.browsing.favoriteMaps.some((favorite) => favorite.toLocaleLowerCase() === key),
  );
}

/**
 * Star or unstar a map by folder name.
 *
 * Reads the newest copy of the preferences, because `setBrowsing` replaces the
 * whole block and a copy captured at render time would put back whatever
 * changed since.
 */
export function toggleFavoriteMap(folderName: string) {
  const key = folderName.toLocaleLowerCase();
  const current = useAppStore.getState().state.settings.browsing;
  const starred = current.favoriteMaps.some((favorite) => favorite.toLocaleLowerCase() === key);
  const favoriteMaps = starred
    ? current.favoriteMaps.filter((favorite) => favorite.toLocaleLowerCase() !== key)
    : [...current.favoriteMaps, key];
  ipc.send({
    kind: "Settings",
    command: { type: "setBrowsing", payload: { preferences: { ...current, favoriteMaps } } },
  });
}
