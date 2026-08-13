// Resolves a game's raw map id (the wire `mapname`, e.g. "scmp_007") against
// the map vault for a real thumbnail + pretty display name. Shared by
// CustomGamesView and CoOpView so both get real map art/names instead of a
// technical id and a hashed-gradient placeholder wherever the vault has the
// map. Requires a *real* (not fake-auth) session to ever return anything —
// maps/mods use the real client whenever auth is real, independent of
// FAF_REAL_LOBBY/FAF_REAL_LAUNCH (see infra/mod.rs's `real_ports`) — so this
// works even with a fake/offline lobby, as long as login itself is real.

import { useEffect, useMemo } from "react";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";

export interface MapInfo {
  thumbnailUrl?: string;
  displayName: string;
}

export function useMapInfo(): Map<string, MapInfo> {
  const vault = useAppStore((s) => s.state.maps.vault);

  useEffect(() => {
    if (useAppStore.getState().state.maps.vaultStatus.type === "idle") {
      ipc.dispatch({ kind: "Maps", command: { type: "loadVault" } });
    }
  }, []);

  return useMemo(() => {
    const lookup = new Map<string, MapInfo>();
    for (const m of vault) {
      // Game.map (from `game_info`) is the bare scenario id; VaultMap.folderName
      // carries a version suffix ("scmp_007.v0001") — strip it to match.
      const base = m.folderName.replace(/\.v\d+$/i, "").toLowerCase();
      if (!lookup.has(base)) {
        lookup.set(base, { thumbnailUrl: m.thumbnailUrl || undefined, displayName: m.displayName });
      }
    }
    return lookup;
  }, [vault]);
}

/** The vault's pretty display name for a map id, falling back to the raw id
 * itself (e.g. "scmp_007") when the map isn't in the vault or it hasn't
 * loaded yet. */
export function mapLabel(rawMap: string, info: Map<string, MapInfo>): string {
  return info.get(rawMap.toLowerCase())?.displayName ?? rawMap;
}
