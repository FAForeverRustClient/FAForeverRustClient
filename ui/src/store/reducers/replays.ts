import type {
  OnlineLookup,
  ReplayDetails,
  ReplayDownloadStatus,
  ReplayEvent,
  ReplayState,
  ResolvedReplayMap,
} from "../../ipc/bindings";

/**
 * How many replays' details the store keeps: twin of
 * `faf_domain::state::replays::REPLAY_DETAILS_KEPT`, which says why fifty. The
 * conformance fixture records the Rust value and holds this one to it.
 */
export const REPLAY_DETAILS_KEPT = 50;

/**
 * Store one read's details as the newest and drop the oldest past the cap.
 * Twin of `store_replay_details`: a read answered again moves to the newest
 * place rather than keeping the place of its first answer.
 */
function storeReplayDetails(
  state: ReplayState,
  key: string,
  details: ReplayDetails,
): Pick<ReplayState, "replayDetails" | "replayDetailsOrder"> {
  const replayDetails = { ...state.replayDetails, [key]: details };
  const order = [...(state.replayDetailsOrder ?? []).filter((stored) => stored !== key), key];
  const overflow = Math.max(0, order.length - REPLAY_DETAILS_KEPT);
  for (const oldest of order.slice(0, overflow)) delete replayDetails[oldest];
  return { replayDetails, replayDetailsOrder: order.slice(overflow) };
}

/**
 * How many games' vault lookups the store keeps: twin of
 * `faf_domain::state::replays::ONLINE_LOOKUPS_KEPT`, which says why a thousand.
 */
export const ONLINE_LOOKUPS_KEPT = 1000;

/**
 * How many games' resolved maps the store keeps: twin of
 * `faf_domain::state::replays::RESOLVED_MAPS_KEPT`.
 */
export const RESOLVED_MAPS_KEPT = 500;

/** `order` with `uid` moved to its newest end. Twin of `stored_last`. */
function storedLast(order: number[] | undefined, uid: number): number[] {
  return [...(order ?? []).filter((stored) => stored !== uid), uid];
}

/**
 * Store one game's lookup as the newest and drop the oldest past the cap.
 * Twin of `store_online_lookup`.
 */
function withLookup(state: ReplayState, uid: number, lookup: OnlineLookup): ReplayState {
  const onlineLookups = { ...state.onlineLookups, [uid]: lookup };
  const order = storedLast(state.onlineLookupsOrder, uid);
  const overflow = Math.max(0, order.length - ONLINE_LOOKUPS_KEPT);
  for (const oldest of order.slice(0, overflow)) delete onlineLookups[oldest];
  return { ...state, onlineLookups, onlineLookupsOrder: order.slice(overflow) };
}

/**
 * Store a batch of resolved maps as the newest and drop the oldest past the
 * cap, never a game of the vault page on screen: that page asks again for any
 * of its games it finds missing. Twin of `store_resolved_maps`.
 */
function withResolvedMaps(state: ReplayState, maps: ResolvedReplayMap[]): ReplayState {
  const resolvedMaps = { ...state.resolvedMaps };
  let order = state.resolvedMapsOrder ?? [];
  for (const resolved of maps) {
    resolvedMaps[resolved.uid] = resolved.map;
    order = storedLast(order, resolved.uid);
  }
  let overflow = Math.max(0, order.length - RESOLVED_MAPS_KEPT);
  if (overflow > 0) {
    const onPage = new Set(state.vault.map((replay) => replay.uid));
    order = order.filter((uid) => {
      if (overflow === 0 || onPage.has(uid)) return true;
      delete resolvedMaps[uid];
      overflow -= 1;
      return false;
    });
  }
  return { ...state, resolvedMaps, resolvedMapsOrder: order };
}

/** Whether `status` is the library download of `uid`, still running. */
function isDownloading(status: ReplayDownloadStatus, uid: number): boolean {
  return status.type === "downloading" && status.payload.uid === uid;
}

export function reduceReplays(state: ReplayState, event: ReplayEvent): ReplayState {
  switch (event.type) {
    case "connecting":
      return { ...state, status: { type: "connecting" }, lastWarning: null, preparing: null };
    case "preparing":
      return state.status.type === "connecting" ? { ...state, preparing: event.payload.step } : state;
    // None of the three touches `downloadStatus`, as in the Rust reducer. A
    // watch's download is a step of its launch (`preparing`), and these used
    // to clear the library download's status, which also ended a real
    // library download running beside the watch.
    case "playing":
      return {
        ...state,
        status: { type: "playing", payload: { uid: event.payload.uid } },
        lastWarning: event.payload.warning,
        preparing: null,
      };
    case "failed":
      return {
        ...state,
        status: { type: "failed", payload: { reason: event.payload.reason } },
        preparing: null,
      };
    case "closed":
      return { ...state, status: { type: "idle" }, preparing: null };
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
    // The matchmaker tab's own list: never touches the vault search above.
    case "recentMatchmakerLoading":
      return { ...state, recentMatchmakerStatus: { type: "loading" } };
    case "recentMatchmakerLoaded":
      return { ...state, recentMatchmaker: event.payload.replays, recentMatchmakerStatus: { type: "ready" } };
    case "recentMatchmakerFailed":
      return {
        ...state,
        recentMatchmakerStatus: { type: "failed", payload: { reason: event.payload.reason } },
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
        downloadStatus: { type: "downloading", payload: { uid: event.payload.uid, progress: null } },
      };
    // Both only for the download they name, as in the Rust reducer.
    case "vaultDownloadProgressed":
      return isDownloading(state.downloadStatus, event.payload.uid)
        ? {
          ...state,
          downloadStatus: {
            type: "downloading",
            payload: { uid: event.payload.uid, progress: event.payload.progress },
          },
        }
        : state;
    case "vaultDownloadCancelled":
      return isDownloading(state.downloadStatus, event.payload.uid)
        ? { ...state, downloadStatus: { type: "idle" } }
        : state;
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
    // Every details and analysis read is named by its read key (see
    // `replayReadKey`), not by the game id: two files without one are both
    // uid 0, and only the key keeps their answers apart.
    case "detailsLoading":
      return {
        ...state,
        detailsLoading: event.payload.key,
        detailsError: null,
      };
    // Details are kept per read, so a late answer fills in its own entry, up
    // to the newest `REPLAY_DETAILS_KEPT` of them. Only the newest request's
    // failure is recorded, and an answer clears only its own: mirrors
    // `faf_domain::state::replays::reduce`.
    case "detailsLoaded":
      return {
        ...state,
        ...storeReplayDetails(state, event.payload.key, event.payload.details),
        detailsLoading: state.detailsLoading === event.payload.key ? null : state.detailsLoading,
        detailsError: state.detailsError?.key === event.payload.key ? null : (state.detailsError ?? null),
      };
    case "detailsFailed":
      return state.detailsLoading === event.payload.key
        ? {
          ...state,
          detailsLoading: null,
          detailsError: { key: event.payload.key, reason: event.payload.reason },
        }
        : state;
    case "analysisLoading":
      return {
        ...state,
        analysisLoading: event.payload.key,
        analysisError: null,
        // The panel being opened is not the one the held analysis is of.
        analysis: state.analysis && state.analysis.key !== event.payload.key
          ? null
          : state.analysis,
      };
    // One analysis is held, so only the newest request's answer or failure
    // may land. An older read finishing last would replace the newer answer,
    // and the open panel would reject it and wait on "reading" for nothing.
    case "analysisLoaded":
      return state.analysisLoading === event.payload.analysis.key
        ? { ...state, analysis: event.payload.analysis, analysisLoading: null, analysisError: null }
        : state;
    case "analysisFailed":
      return state.analysisLoading === event.payload.key
        ? {
          ...state,
          analysisLoading: null,
          analysisError: { key: event.payload.key, reason: event.payload.reason },
        }
        : state;
    // The panel that asked closed and its reads were called off: neither is
    // loading any more, and only that panel's lines change.
    case "readsCancelled":
      return {
        ...state,
        detailsLoading: state.detailsLoading === event.payload.key ? null : state.detailsLoading,
        analysisLoading: state.analysisLoading === event.payload.key ? null : state.analysisLoading,
      };
    // An empty map is an answer, so it is written like any other and the view
    // stops asking about that game.
    case "mapsResolved":
      return withResolvedMaps(state, event.payload.maps);
    case "onlineLookupStarted":
      return withLookup(state, event.payload.uid, { type: "loading" });
    case "onlineLookupFinished":
      return withLookup(
        state,
        event.payload.uid,
        event.payload.replay
          ? { type: "found", payload: event.payload.replay }
          : { type: "missing" },
      );
    case "onlineLookupFailed":
      return withLookup(state, event.payload.uid, {
        type: "failed",
        payload: { reason: event.payload.reason },
      });
  }
}
