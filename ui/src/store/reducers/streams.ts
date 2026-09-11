// Twin of `faf_domain::state::streams::reduce`. Pinned by the conformance
// fixture, so a transition that drifts from the Rust one fails a test rather
// than shipping.

import type { StreamsEvent, StreamsState } from "../../ipc/bindings";

/** Twin of `MAX_ANNOUNCED`. */
const MAX_ANNOUNCED = 64;

export function reduceStreams(state: StreamsState, event: StreamsEvent): StreamsState {
  switch (event.type) {
    case "checking":
      return { ...state, status: { type: "checking" } };
    case "loaded":
      return { ...state, live: event.payload.streams, status: { type: "ready" } };
    // The list is kept: a failed check is "we do not know any more", and
    // dropping a stream that is almost certainly still running would take the
    // badge off a live channel on one bad request.
    case "loadFailed":
      return { ...state, status: { type: "failed", payload: { reason: event.payload.reason } } };
    case "announced": {
      const announced = [...state.announced];
      for (const id of event.payload.streamIds) {
        if (!announced.includes(id)) announced.push(id);
      }
      return {
        ...state,
        announced:
          announced.length > MAX_ANNOUNCED ? announced.slice(announced.length - MAX_ANNOUNCED) : announced,
      };
    }
  }
}
