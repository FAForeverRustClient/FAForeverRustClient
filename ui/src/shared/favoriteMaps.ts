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
 * Sends the one folder and the direction, which the backend applies to the
 * list it holds. Sending the whole list, even one read fresh from the store,
 * lost a star whenever two were clicked inside one round trip: both clicks
 * started from the same list, so the second write did not hold the first.
 */
export function toggleFavoriteMap(folderName: string, downloadUrl?: string) {
  const key = folderName.trim().toLocaleLowerCase();
  const current = useAppStore.getState().state.settings.browsing;
  const starred = current.favoriteMaps.some((favorite) => favorite.toLocaleLowerCase() === key);
  ipc.send({
    kind: "Settings",
    command: {
      type: "setListMember",
      payload: { list: "favoriteMaps", value: key, member: !starred },
    },
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
