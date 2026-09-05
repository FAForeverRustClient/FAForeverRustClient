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
    case "selected":
      return { ...state, selectedId: event.payload.resourceId };
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
