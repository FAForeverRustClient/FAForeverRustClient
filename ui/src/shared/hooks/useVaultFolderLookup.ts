// Asks the vault for a map the catalogue does not hold (#323).
//
// The catalogue leaves out every map withdrawn from the vault, and a withdrawn
// map is still hosted, joined and downloaded like any other. Its preview cannot
// be guessed from the folder name either: the preview service names files
// after the version's zip. So once a tile has run out of art, it asks for the
// map's record by folder, and the answer joins `maps.vault`, where every lookup
// that resolves a map by folder already reads.

import { useEffect } from "react";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { findVaultMapByFolder, isGeneratedMap, normalizeMapName } from "../mapPresentation";

/// Folders already asked about, for the whole session. A folder the vault has
/// no record of stays unknown, and asking again on every render would be a
/// request per tile per event.
const requested = new Set<string>();

/** Test seam: the module-level guard would otherwise leak between cases. */
export function resetVaultFolderLookups(): void {
  requested.clear();
}

/**
 * Look the map's folder up in the vault once, when `enabled` and the loaded
 * catalogue has no record for it.
 */
export function useVaultFolderLookup(mapName: string, enabled: boolean): void {
  const folder = normalizeMapName(mapName);
  const missing = useAppStore(
    (state) =>
      state.state.maps.vaultStatus.type === "ready" &&
      findVaultMapByFolder(state.state.maps.vault, folder) === undefined,
  );

  useEffect(() => {
    if (!enabled || !missing || !folder || isGeneratedMap(folder) || requested.has(folder)) return;
    requested.add(folder);
    ipc.send({
      kind: "Maps",
      command: { type: "resolveVaultFolders", payload: { folderNames: [folder] } },
    });
  }, [enabled, folder, missing]);
}
