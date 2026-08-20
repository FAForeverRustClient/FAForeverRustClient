import type { ChangelogEvent, ChangelogState } from "../../ipc/bindings";

/** Twin of `faf_domain::state::changelog::reduce`. */
export function reduceChangelog(state: ChangelogState, event: ChangelogEvent): ChangelogState {
  switch (event.type) {
    case "loading":
      return { ...state, status: { type: "loading" } };
    case "loaded":
      return { ...state, releases: event.payload.releases, status: { type: "ready" } };
    case "loadFailed":
      return { ...state, status: { type: "failed", payload: { reason: event.payload.reason } } };
    case "entryLoading":
      // The selection moves immediately, so the header and the highlighted row
      // track the click rather than the download.
      return {
        ...state,
        selected: event.payload.id,
        entryStatus: { type: "loading", payload: { id: event.payload.id } },
      };
    case "entryLoaded":
      return {
        ...state,
        selected: event.payload.entry.id,
        entries: { ...state.entries, [event.payload.entry.id]: event.payload.entry },
        entryStatus: { type: "ready" },
      };
    case "entryLoadFailed":
      return {
        ...state,
        entryStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
  }
}
