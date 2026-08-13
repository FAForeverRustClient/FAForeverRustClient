import type { ReplayEvent, ReplayState } from "../../ipc/bindings";

export function reduceReplays(state: ReplayState, event: ReplayEvent): ReplayState {
  switch (event.type) {
    case "connecting":
      return { ...state, status: { type: "connecting" }, lastWarning: null };
    case "playing":
      return {
        ...state,
        status: { type: "playing", payload: { uid: event.payload.uid } },
        lastWarning: event.payload.warning,
      };
    case "failed":
      return { ...state, status: { type: "failed", payload: { reason: event.payload.reason } } };
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
  }
}
