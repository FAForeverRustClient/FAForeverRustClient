import type { ClientRelease, ClientUpdateEvent, ClientUpdateState } from "../../ipc/bindings";

/** Twin of `ClientUpdateStatus::is_busy`. */
export function isUpdateBusy(status: ClientUpdateState["status"]): boolean {
  return status.type === "checking" || status.type === "downloading";
}

/** Twin of `ClientUpdateStatus::percent`; `null` when the size is unknown. */
export function updatePercent(status: ClientUpdateState["status"]): number | null {
  if (status.type !== "downloading" || status.payload.totalBytes <= 0) return null;
  return Math.floor((status.payload.receivedBytes * 100) / status.payload.totalBytes);
}

/**
 * Twin of `ClientUpdateState::banner_release`, which determines what the update banner shows.
 *
 * Derived rather than stored so the banner needs no local `dismissed` flag of
 * its own, which is how a dismissal ends up disagreeing with the backend.
 */
export function updateBannerRelease(state: ClientUpdateState): ClientRelease | null {
  if (state.release === null) return null;
  const showing =
    state.status.type === "available" ||
    state.status.type === "downloading" ||
    state.status.type === "ready" ||
    state.status.type === "installing" ||
    // A failure during an update the user started is an answer they are
    // waiting for. A failed *background check* leaves `release` null, so it
    // never reaches this branch; nobody is greeted with an error box because
    // GitHub was briefly unreachable.
    state.status.type === "failed";
  return showing && state.release.version !== state.dismissedVersion ? state.release : null;
}

export function reduceClientUpdate(
  state: ClientUpdateState,
  event: ClientUpdateEvent,
): ClientUpdateState {
  switch (event.type) {
    case "checkStarted":
      return {
        ...state,
        currentVersion: event.payload.currentVersion,
        status: { type: "checking" },
      };
    case "upToDate":
      // Drop the offer too: the user may have installed it out of band, and a
      // stale banner behind an up-to-date status is worse than no banner.
      return { ...state, release: null, status: { type: "upToDate" } };
    case "available":
      return { ...state, release: event.payload.release, status: { type: "available" } };
    case "downloadProgressed":
      return {
        ...state,
        status: {
          type: "downloading",
          payload: {
            receivedBytes: event.payload.receivedBytes,
            totalBytes: event.payload.totalBytes,
          },
        },
      };
    case "downloaded":
      return { ...state, status: { type: "ready", payload: { path: event.payload.path } } };
    case "installing":
      return { ...state, status: { type: "installing" } };
    case "failed":
      return { ...state, status: { type: "failed", payload: { reason: event.payload.reason } } };
    case "dismissed":
      return { ...state, dismissedVersion: event.payload.version };
  }
}
