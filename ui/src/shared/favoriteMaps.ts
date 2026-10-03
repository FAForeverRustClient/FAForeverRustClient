// The favourite maps, as one list wherever a map can be starred.
//
// The map vault and the host dialog each kept their own copy of "is this a
// favourite" and "star it" over the same browsing preference. Anything new
// that stars a map goes through here, so the three cannot drift apart.

import { ipc } from "../ipc/client";
import { useAppStore } from "../store/store";
import { findVaultMapByFolder, isGeneratedMap, isOfficialMap } from "./mapPresentation";

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
export function toggleFavoriteMap(folderName: string, downloadUrl?: string) {
  const key = folderName.trim().toLocaleLowerCase();
  const current = useAppStore.getState().state.settings.browsing;
  const starred = current.favoriteMaps.some((favorite) => favorite.toLocaleLowerCase() === key);
  const favoriteMaps = starred
    ? current.favoriteMaps.filter((favorite) => favorite.toLocaleLowerCase() !== key)
    : [...current.favoriteMaps, key];
  ipc.send({
    kind: "Settings",
    command: { type: "setBrowsing", payload: { preferences: { ...current, favoriteMaps } } },
  });
  if (!starred) installFavorite(folderName.trim(), downloadUrl);
}

/**
 * Put a newly starred map on disk, if it is a vault map that is not there.
 *
 * The host dialog lists the maps it can host, which are the installed ones, so
 * a star on a map nobody had downloaded was reported as done and then led to
 * an empty favourites list. A generated map needs no download (hosting
 * generates it), and a base-game map ships with the game.
 *
 * The URL is the vault record's when there is one, otherwise the content
 * server's own `maps/{folder}.zip`, which is how Java builds it for any map
 * by folder name (`MapService`, lower-cased).
 */
function installFavorite(folderName: string, downloadUrl?: string) {
  if (!folderName || isGeneratedMap(folderName) || isOfficialMap(folderName)) return;
  const maps = useAppStore.getState().state.maps;
  const key = folderName.toLocaleLowerCase();
  if (maps.installed.some((map) => map.folderName.toLocaleLowerCase() === key)) return;
  const vaultMap = downloadUrl ? undefined : findVaultMapByFolder(maps.vault, folderName);
  ipc.send({
    kind: "Maps",
    command: {
      type: "installMap",
      payload: {
        folderName: vaultMap?.folderName ?? folderName,
        downloadUrl:
          downloadUrl
          || vaultMap?.downloadUrl
          || `https://content.faforever.com/maps/${encodeURIComponent(key)}.zip`,
      },
    },
  });
}
