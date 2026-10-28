import type { MapsEvent, MapsState } from "../../ipc/bindings";

/**
 * Twin of `MAX_LOCAL_PREVIEWS` in crates/faf-domain/src/state/maps.rs, where
 * the number is justified against measured preview sizes.
 */
const MAX_LOCAL_PREVIEWS = 128;
const MAX_LOCAL_PREVIEW_BYTES = 16 * 1024 * 1024;

export function reduceMaps(state: MapsState, event: MapsEvent): MapsState {
  switch (event.type) {
    case "vaultProgress":
      return { ...state, vaultProgress: event.payload.progress };
    case "vaultCancelled":
      return { ...state, vaultStatus: { type: "cancelled" }, vaultProgress: null };
    case "vaultLoading":
      return { ...state, vaultStatus: { type: "loading" }, vaultProgress: null };
    // Merged with what folder lookups already added: see the Rust twin.
    case "vaultLoaded": {
      const loaded = new Set(event.payload.maps.map((map) => map.versionId));
      const resolvedIds = new Set(state.resolvedVaultVersions ?? []);
      const resolved = state.vault.filter((map) => resolvedIds.has(map.versionId) && !loaded.has(map.versionId));
      return {
        ...state,
        vault: [...event.payload.maps, ...resolved],
        vaultStatus: { type: "ready" },
        vaultProgress: null,
      };
    }
    case "vaultLoadFailed":
      return { ...state, vaultStatus: { type: "failed", payload: { reason: event.payload.reason } } };
    // Appended, never replacing: these are records the catalogue leaves out
    // (withdrawn versions), looked up one folder at a time.
    case "vaultFoldersResolved": {
      const known = new Set(state.vault.map((map) => map.versionId));
      const added = event.payload.maps.filter((map) => {
        if (known.has(map.versionId)) return false;
        known.add(map.versionId);
        return true;
      });
      return {
        ...state,
        vault: [...state.vault, ...added],
        resolvedVaultVersions: [...new Set([
          ...(state.resolvedVaultVersions ?? []),
          ...event.payload.maps.map((map) => map.versionId),
        ])],
      };
    }
    // `browse` is one page of a server-side search and is separate from
    // `vault`, which stays the whole catalogue used as a folder-name index.
    // Twin of the Rust arm: a changed map's entries go, except versions
    // looked up by folder, and every version is held once.
    case "vaultUpdated": {
      const changed = new Set(event.payload.maps.map((map) => map.mapId));
      const resolved = new Set(state.resolvedVaultVersions ?? []);
      const vault = state.vault.filter((map) => !changed.has(map.mapId) || resolved.has(map.versionId));
      for (const map of event.payload.maps) {
        if (map.hidden) continue;
        const at = vault.findIndex((known) => known.versionId === map.versionId);
        if (at >= 0) vault[at] = map;
        else vault.push(map);
      }
      return {
        ...state,
        vault,
        vaultStatus: { type: "ready" },
        vaultProgress: null,
      };
    }
    case "vaultSearching":
      return {
        ...state,
        browseStatus: { type: "loading" },
        // A refusal belongs to the page it happened on: without this it would
        // sit above every later search for the rest of the session.
        visibilityStatus:
          state.visibilityStatus.type === "failed" ? { type: "idle" } : state.visibilityStatus,
      };
    case "vaultSearched":
      return {
        ...state,
        browse: event.payload.maps,
        browseQuery: event.payload.query,
        browseTotalPages: event.payload.totalPages,
        browseTotalRecords: event.payload.totalRecords,
        browseStatus: { type: "ready" },
      };
    case "vaultSearchFailed":
      return {
        ...state,
        browseStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
    case "installedLoading":
      return { ...state, installedStatus: { type: "loading" } };
    case "installedLoaded":
      return { ...state, installed: event.payload.maps, installedStatus: { type: "ready" } };
    case "installedLoadFailed":
      return {
        ...state,
        installedStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
    // Merge per size: a later read must not drop art an earlier one paid for.
    // An entry with both sides null is the "looked, found nothing" marker that
    // stops the image error handler asking again.
    case "localPreviewsLoaded": {
      const localPreviews = { ...state.localPreviews };
      const localPreviewOrder = [...state.localPreviewOrder];
      // Sorted, because the twin reads a `BTreeMap` and the eviction queue has
      // to end up in the same order on both sides. Object key order would
      // agree for every real folder name and quietly disagree for a numeric
      // one, which JavaScript hoists to the front.
      for (const folder of Object.keys(event.payload.previews).sort()) {
        const preview = event.payload.previews[folder];
        const known = Object.prototype.hasOwnProperty.call(localPreviews, folder) ? localPreviews[folder] : undefined;
        Object.defineProperty(localPreviews, folder, { value: {
          small: preview.small ?? known?.small ?? null,
          large: preview.large ?? known?.large ?? null,
        }, enumerable: true, configurable: true, writable: true });
        if (!known) localPreviewOrder.push(folder);
      }
      // Oldest first, so what the user is looking at now survives. See
      // `MAX_LOCAL_PREVIEWS`: this art is held as `data:` URLs and an
      // unbounded cache of it reached tens of megabytes on each side.
      // Native previews are ASCII data URLs, so length equals encoded bytes.
      const size = (preview: (typeof localPreviews)[string]) =>
        (preview.small?.length ?? 0) + (preview.large?.length ?? 0);
      let bytes = Object.values(localPreviews).reduce((total, preview) => total + size(preview), 0);
      while ((Object.keys(localPreviews).length > MAX_LOCAL_PREVIEWS || bytes > MAX_LOCAL_PREVIEW_BYTES)
        && localPreviewOrder.length > 0) {
        const evicted = localPreviewOrder.shift();
        if (evicted !== undefined && Object.prototype.hasOwnProperty.call(localPreviews, evicted)) {
          bytes -= size(localPreviews[evicted]);
          delete localPreviews[evicted];
        }
      }
      return { ...state, localPreviews, localPreviewOrder };
    }
    case "matchmakerPoolsLoading":
      return { ...state, matchmakerPoolsStatus: { type: "loading" } };
    case "matchmakerPoolsLoaded":
      return {
        ...state,
        matchmakerPools: { ...state.matchmakerPools, [event.payload.queueName]: event.payload.pools },
        matchmakerPoolsStatus: { type: "ready" },
      };
    case "matchmakerPoolsLoadFailed":
      return {
        ...state,
        matchmakerPoolsStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
    case "installing":
      return {
        ...state,
        installStatus: {
          type: "installing",
          payload: { folderName: event.payload.folderName, progress: null },
        },
      };
    // Only onto the install it measures, as in
    // `faf_domain::state::maps::reduce`: a step after that install ended, or
    // for another folder, describes nothing.
    case "installProgressed":
      return state.installStatus.type === "installing"
        && state.installStatus.payload.folderName === event.payload.folderName
        ? {
          ...state,
          installStatus: {
            type: "installing",
            payload: { folderName: event.payload.folderName, progress: event.payload.progress },
          },
        }
        : state;
    // Called off: back to idle without a failure, and only for the install it
    // names. Nothing reached the disk, so the installed list stays.
    case "installCancelled":
      return state.installStatus.type === "installing"
        && state.installStatus.payload.folderName === event.payload.folderName
        ? { ...state, installStatus: { type: "idle" } }
        : state;
    // A map that had no art a moment ago may have some now, and the empty
    // "looked, found nothing" markers would otherwise outlive the folder they
    // describe.
    case "installed":
      return {
        ...state,
        installed: event.payload.installed,
        installedStatus: { type: "ready" },
        installStatus: { type: "idle" },
        localPreviews: {},
        localPreviewOrder: [],
      };
    case "installFailed":
      return { ...state, installStatus: { type: "failed", payload: { reason: event.payload.reason } } };
    case "uninstalled":
      return {
        ...state,
        installed: event.payload.installed,
        installedStatus: { type: "ready" },
        installStatus: { type: "idle" },
        localPreviews: {},
        localPreviewOrder: [],
      };
    case "uninstallFailed":
      return { ...state, installStatus: { type: "failed", payload: { reason: event.payload.reason } } };
    case "mapVisibilityChanging":
      return {
        ...state,
        visibilityStatus: { type: "working", payload: { versionId: event.payload.versionId } },
      };
    // Corrected in place rather than refetched: a refetch would move the page
    // under the user, and a freshly hidden version leaves every view but
    // "my maps". Both lists, because `vault` is the folder-name index nine
    // other features read and a stale flag there outlives this page.
    case "mapVisibilityChanged": {
      const { versionId, hidden } = event.payload;
      const mark = (map: MapsState["browse"][number]) =>
        map.versionId === versionId ? { ...map, hidden } : map;
      return {
        ...state,
        browse: state.browse.map(mark),
        vault: state.vault.map(mark),
        visibilityStatus: { type: "idle" },
      };
    }
    case "mapVisibilityFailed":
      return {
        ...state,
        visibilityStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
  }
}
