// Twin of `faf_domain::state::connectivity::reduce`. Pinned by the conformance
// fixture, so a transition that drifts from the Rust one fails a test rather
// than shipping.

import type { ConnectivityEvent, ConnectivityState } from "../../ipc/bindings";

export function reduceConnectivity(state: ConnectivityState, event: ConnectivityEvent): ConnectivityState {
  switch (event.type) {
    case "checkStarted":
      return {
        ...state,
        check: { status: { type: "running" }, steps: [], startedAt: event.payload.startedAt },
      };
    // A line belongs to a run. One arriving outside a run has nothing to be a
    // line of, and appending it would mix it into the last result.
    case "stepReported": {
      if (state.check.status.type !== "running") return state;
      const step = event.payload.step;
      const index = state.check.steps.findIndex((held) => held.id === step.id);
      const steps =
        index === -1
          ? [...state.check.steps, step]
          : state.check.steps.map((held, at) => (at === index ? step : held));
      return { ...state, check: { ...state.check, steps } };
    }
    case "checkFinished":
      if (state.check.status.type !== "running") return state;
      return {
        ...state,
        check: { ...state.check, status: { type: "finished", payload: { verdict: event.payload.verdict } } },
      };
    case "relayStatusUpdated":
      return { ...state, relay: event.payload.status };
  }
}
