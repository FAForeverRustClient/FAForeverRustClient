// Twin of `faf_domain::state::training::reduce`. Pinned by the conformance
// fixture (`reducer.conformance.test.ts`), so a transition that drifts from the
// Rust one fails a test rather than shipping.

import type { TrainingEvent, TrainingState } from "../../ipc/bindings";

export function reduceTraining(state: TrainingState, event: TrainingEvent): TrainingState {
  switch (event.type) {
    case "loading":
      return { ...state, status: { type: "loading" } };
    case "loaded": {
      const { resources, trainers, links, source } = event.payload;
      // A detail pane open on an entry the reload dropped would keep showing a
      // resource the catalogue no longer has.
      const stillPresent = resources.some((resource) => resource.id === state.selectedId);
      return {
        ...state,
        resources,
        trainers,
        links,
        source,
        status: { type: "ready" },
        selectedId: stillPresent ? state.selectedId : null,
      };
    }
    case "loadFailed":
      return { ...state, status: { type: "failed", payload: { reason: event.payload.reason } } };
    case "queryChanged":
      return { ...state, query: event.payload.query };
    case "selected": {
      // A document belongs to the entry it was opened from. Leaving the last
      // one in place would render one guide's text under the next one's title
      // for as long as the read takes.
      const resourceId = event.payload.resourceId;
      const document =
        state.document.resourceId === (resourceId ?? "")
          ? state.document
          : { resourceId: "", markdown: "", status: { type: "idle" as const } };
      return { ...state, selectedId: resourceId, document };
    }
    case "guideReading":
      return {
        ...state,
        document: {
          resourceId: event.payload.resourceId,
          markdown: "",
          status: { type: "loading" },
        },
      };
    // A reply for an entry the reader has already left is dropped rather than
    // shown: by the time it arrives the title above it belongs to something
    // else.
    case "guideRead":
      return state.document.resourceId === event.payload.resourceId
        ? {
            ...state,
            document: {
              ...state.document,
              markdown: event.payload.markdown,
              status: { type: "ready" },
            },
          }
        : state;
    case "guideFailed":
      return state.document.resourceId === event.payload.resourceId
        ? {
            ...state,
            document: {
              ...state.document,
              status: { type: "failed", payload: { reason: event.payload.reason } },
            },
          }
        : state;
    case "recommended":
      return {
        ...state,
        recommended: event.payload.resourceIds,
        profile: event.payload.profile,
      };
    // Opening and editing both clear the composed post: it names the previous
    // answer, and leaving it would let the player send a version they have
    // already changed away from.
    case "reviewOpened":
    case "reviewChanged":
      return { ...state, review: event.payload.draft, reviewPost: null };
    case "reviewComposed":
      return { ...state, reviewPost: event.payload.post };
    case "reviewClosed":
      return { ...state, review: null, reviewPost: null };
    case "contributionOpened":
    case "contributionChanged":
      return { ...state, contribution: event.payload.draft, contributionPost: null };
    case "contributionComposed":
      return { ...state, contributionPost: event.payload.post };
    case "contributionClosed":
      return { ...state, contribution: null, contributionPost: null };
  }
}
