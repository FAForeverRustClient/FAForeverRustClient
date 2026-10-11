// Previews of installed generated maps, read from disk when a tile shows one.
//
// They used to arrive unasked: every scan of the maps folder sent the picture
// of every generated map in it, as base64, in one event, and the page ran out
// of memory after a few dozen generated maps (#402). Now a tile asks for its
// own map, the way the Java client reads a generated map's preview from its
// folder when the tile is shown (`MapService.getGeneratedMapPreview`).

import { useEffect } from "react";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { baseMapName } from "../mapPresentation";
import { installedBases } from "./useLocalMapPreview";

/// When each map was last asked for. Commands run concurrently, so the
/// backend's own "already held" check cannot see a sibling tile's request that
/// has not landed yet; and the cache holds a bounded number of previews, so a
/// map whose preview was dropped to make room has to be asked for again, just
/// not on every render while its answer is on the way.
const requestedAt = new Map<string, number>();
const RETRY_AFTER_MS = 10_000;

export function requestGeneratedMapPreview(mapName: string, now = Date.now()): boolean {
  const last = requestedAt.get(mapName);
  if (last !== undefined && now - last < RETRY_AFTER_MS) return false;
  requestedAt.set(mapName, now);
  ipc.send({ kind: "MapGenerator", command: { type: "loadPreviews", payload: { mapNames: [mapName] } } });
  return true;
}

/** Test seam: the module-level record would otherwise leak between cases. */
export function resetGeneratedMapPreviewRequests(): void {
  requestedAt.clear();
}

/**
 * Ask for a generated map's preview when it is installed, missing from the
 * cache, and `enabled`. A map that is not on disk has no preview to read.
 */
export function useGeneratedMapPreview(mapName: string, enabled: boolean, held: boolean): void {
  const installed = useAppStore((state) =>
    enabled ? installedBases(state.state.maps.installed).has(baseMapName(mapName)) : false,
  );
  useEffect(() => {
    if (!enabled || held || !installed) return;
    requestGeneratedMapPreview(mapName);
  }, [enabled, held, installed, mapName]);
}
