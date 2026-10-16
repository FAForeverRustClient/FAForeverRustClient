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

/** An overdue, installable release gates regardless of its notice's dismissal. */
export function updateRequiredRelease(state: ClientUpdateState): ClientRelease | null {
  const release = state.release;
  if (!state.overdue || release === null || release.downloadUrl === "") return null;
  const gated =
    state.status.type === "available" ||
    state.status.type === "downloading" ||
    state.status.type === "ready" ||
    state.status.type === "installing" ||
    // A download that failed keeps the gate up: the reason is shown and the
    // button retries. A failed *check* leaves `release` null and never gets
    // here, so an update server having a bad day locks nobody out.
    state.status.type === "failed";
  return gated ? release : null;
}

export function reduceClientUpdate(
  state: ClientUpdateState,
  event: ClientUpdateEvent,
): ClientUpdateState {
  switch (event.type) {
    // A new check also takes back "Not now": asking again is asking to be
    // told again. See the Rust arm.
    case "checkStarted":
      return {
        ...state,
        currentVersion: event.payload.currentVersion,
        status: { type: "checking" },
        dismissedVersion: "",
      };
    case "upToDate":
      // Drop the offer too: the user may have installed it out of band, and a
      // stale banner behind an up-to-date status is worse than no banner.
      return { ...state, overdue: false, release: null, status: { type: "upToDate" } };
    case "available":
      return { ...state, overdue: state.release?.version === event.payload.release.version && state.overdue, release: event.payload.release, status: { type: "available" } };
    case "overdue":
      return { ...state, overdue: true };
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
    // Only a download in progress is called off, and the offer comes back
    // rather than a failure, as in `faf_domain::state::client_update`.
    case "downloadCancelled":
      return state.status.type === "downloading"
        ? { ...state, status: state.release ? { type: "available" } : { type: "idle" } }
        : state;
    case "downloaded":
      return { ...state, status: { type: "ready", payload: { path: event.payload.path } } };
    case "installing":
      return { ...state, status: { type: "installing" } };
    case "failed":
      return { ...state, status: { type: "failed", payload: { reason: event.payload.reason } } };
    case "dismissed":
      return { ...state, dismissedVersion: event.payload.version };
    case "checkCompleted":
      return { ...state, lastChecked: event.payload.at };
    // A refresh of notes already on screen neither blanks them nor replaces
    // them with an error, as in `faf_domain::state::client_update`.
    case "notesLoading":
      return state.notesStatus.type === "ready"
        ? state
        : { ...state, notesStatus: { type: "loading" } };
    case "notesLoaded":
      return { ...state, notes: event.payload.notes, notesStatus: { type: "ready" } };
    case "notesFailed":
      return state.notesStatus.type === "ready"
        ? state
        : {
            ...state,
            notesStatus: { type: "failed", payload: { reason: event.payload.reason } },
          };
    case "whatsNewPending":
      return { ...state, whatsNew: event.payload.version };
    case "whatsNewDismissed":
      return { ...state, whatsNew: null };
  }
}
