import type { EventsEvent, EventsState } from "../../ipc/bindings";

/** Twin of `faf_domain::state::events::reduce`. */
export function reduceEvents(state: EventsState, event: EventsEvent): EventsState {
  switch (event.type) {
    case "loading":
      return { ...state, status: { type: "loading" } };
    case "loaded":
      // The catalogue replaces rather than merges: a cancelled event is removed
      // from the document, and merging would keep showing it forever.
      return {
        ...state,
        catalogue: event.payload.catalogue.events,
        source: event.payload.catalogue.source,
        submitUrl: event.payload.catalogue.submitUrl,
        status: { type: "ready" },
      };
    case "loadFailed":
      // The entries stay. A calendar that emptied itself on a dropped
      // connection would be worse than a stale one, and the status says which.
      return { ...state, status: { type: "failed", payload: { reason: event.payload.reason } } };
    case "viewChanged":
      return { ...state, view: event.payload.view };
    case "anchorChanged":
      return { ...state, anchor: event.payload.day };
    case "queryChanged":
      return { ...state, query: event.payload.query };
    case "selected":
      return { ...state, selected: event.payload.occurrenceId };
  }
}
