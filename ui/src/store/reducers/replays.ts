import type { ReplayDownloadStatus, ReplayEvent, ReplayState } from "../../ipc/bindings";

/** Mirrors the same guard in `faf_domain::state::replays::reduce`. */
function clearTransientDownload(status: ReplayDownloadStatus): ReplayDownloadStatus {
  return status.type === "downloading" ? { type: "idle" } : status;
}

export function reduceReplays(state: ReplayState, event: ReplayEvent): ReplayState {
  switch (event.type) {
    case "connecting":
      return { ...state, status: { type: "connecting" }, lastWarning: null };
    // Both of these clear a *transient* download. Watching a vault replay
    // downloads it into the cache as part of playback, so its completion has no
    // `vaultDownloaded` event to end the status bar's task; leaving it running
    // is what pinned "Downloading <uid>" to the bottom of the client forever.
    // An explicit save-to-library download still finishes through
    // `vaultDownloaded`, whose terminal state must survive.
    case "playing":
      return {
        ...state,
        status: { type: "playing", payload: { uid: event.payload.uid } },
        lastWarning: event.payload.warning,
        downloadStatus: clearTransientDownload(state.downloadStatus),
      };
    case "failed":
      return {
        ...state,
        status: { type: "failed", payload: { reason: event.payload.reason } },
        downloadStatus: clearTransientDownload(state.downloadStatus),
      };
    case "closed":
      return { ...state, status: { type: "idle" } };
    case "liveTrackingScheduled":
      return { ...state, liveTracking: event.payload.tracking };
    case "liveTrackingCleared":
      return { ...state, liveTracking: null };
    case "vaultLoading":
      return { ...state, vaultStatus: { type: "loading" } };
    case "vaultLoaded":
      return {
        ...state,
        vault: event.payload.replays,
        vaultQuery: event.payload.query,
        vaultHasMore: event.payload.hasMore,
        // Dropping these is what left the pager in its unknown-total mode,
        // showing `Page 4` instead of numbered pages: the server reported the
        // count, the Rust reducer stored it, and this twin threw it away.
        vaultTotalPages: event.payload.totalPages ?? null,
        vaultTotalRecords: event.payload.totalRecords ?? null,
        vaultStatus: { type: "ready" },
      };
    case "vaultLoadFailed":
      return {
        ...state,
        vaultStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
    case "featuredModsLoaded":
      return { ...state, featuredMods: event.payload.mods };
    case "localLoading":
      return { ...state, localStatus: { type: "loading" } };
    case "localLoaded":
      return { ...state, local: event.payload.replays, localStatus: { type: "ready" } };
    case "localDeleted":
      return {
        ...state,
        local: state.local.filter((replay) => replay.path !== event.payload.path),
        localStatus: { type: "ready" },
      };
    case "vaultDownloadStarted":
      return {
        ...state,
        downloadStatus: { type: "downloading", payload: { uid: event.payload.uid } },
      };
    case "vaultDownloaded":
      return {
        ...state,
        local: [
          event.payload.replay,
          ...state.local.filter((replay) => replay.path !== event.payload.replay.path),
        ],
        downloadStatus: {
          type: "downloaded",
          payload: { uid: event.payload.uid, path: event.payload.replay.path },
        },
      };
    case "vaultDownloadFailed":
      return {
        ...state,
        downloadStatus: {
          type: "failed",
          payload: { uid: event.payload.uid, reason: event.payload.reason },
        },
      };
    case "localLoadFailed":
      return {
        ...state,
        localStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
    case "detailsLoading":
      return {
        ...state,
        detailsLoading: event.payload.uid,
        detailsError: null,
      };
    case "detailsLoaded":
      return {
        ...state,
        detailsLoading: state.detailsLoading === event.payload.uid ? null : state.detailsLoading,
        replayDetails: {
          ...state.replayDetails,
          [event.payload.uid]: event.payload.details,
        },
        detailsError: null,
      };
    case "detailsFailed":
      return {
        ...state,
        detailsLoading: state.detailsLoading === event.payload.uid ? null : state.detailsLoading,
        detailsError: event.payload.reason,
      };
  }
}
