// Preview art read out of an installed map's own folder.
//
// The last resort behind the remote thumbnails, and for the co-op campaign the
// only source there is: the FAF API builds a mission's `thumbnailUrl` from its
// folder name without checking, and `content.faforever.com/maps/previews/`
// holds no image for any campaign mission, which is why the Java client shows
// nothing there either. The map folder itself does carry `*.small.png` and
// `*.large.png`, so once the mission is installed the art is already on disk.

import { useEffect } from "react";
import { ipc } from "../ipc/client";
import { useAppStore } from "../store/store";
import { baseMapName } from "./mapPresentation";

/// Names already sent. Commands are dispatched concurrently, so the service's
/// own "already known" check cannot see a sibling that has not landed yet:
/// without this, a grid of tiles all failing at once would each fire.
const requested = new Set<string>();

/// The installed list the guard above was built against. Installing a map can
/// give it art it did not have, and the reducer drops the cache for that
/// reason; the guard has to let go at the same moment or nothing asks again.
let guardedList: unknown = null;

/** Ask for the folders' art. Names may carry a `.vNNNN` suffix or not. */
export function loadLocalMapPreviews(mapNames: string[]): void {
  const installed = useAppStore.getState().state.maps.installed;
  if (installed !== guardedList) {
    guardedList = installed;
    requested.clear();
  }
  const wanted = [...new Set(mapNames.map(baseMapName).filter(Boolean))].filter((name) => {
    if (requested.has(name)) return false;
    requested.add(name);
    return true;
  });
  if (wanted.length === 0) return;
  ipc.send({
    kind: "Maps",
    command: { type: "loadLocalPreviews", payload: { folderNames: wanted } },
  });
}

/** Test seam: the module-level guard would otherwise leak between cases. */
export function resetLocalMapPreviewRequests(): void {
  requested.clear();
  guardedList = null;
}

/**
 * The map's local preview, requesting it once when `enabled`.
 *
 * `enabled` is what keeps this off the hot path: a tile only turns it on after
 * every remote candidate has failed, while the co-op panes ask straight away
 * because there the remote ones are known to be missing.
 */
export function useLocalMapPreview(mapName: string, enabled: boolean, large = false): string | null {
  const base = baseMapName(mapName);
  const preview = useAppStore((state) => state.state.maps.localPreviews[base]);
  // Only for maps that are actually here: asking about one that is not costs a
  // scan of a maps folder several hundred entries deep, for a certain miss.
  const installed = useAppStore((state) =>
    state.state.maps.installed.some((map) => baseMapName(map.folderName) === base),
  );

  useEffect(() => {
    if (!enabled || !base || preview !== undefined || !installed) return;
    loadLocalMapPreviews([base]);
  }, [base, enabled, installed, preview]);

  if (!preview) return null;
  return (large ? preview.large ?? preview.small : preview.small ?? preview.large) ?? null;
}
