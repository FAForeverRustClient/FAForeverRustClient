// Twin of `faf_domain::state::guides::reduce`. Pinned by the conformance
// fixture, so a transition that drifts from the Rust one fails a test rather
// than shipping.

import type { GuidesEvent, GuidesState } from "../../ipc/bindings";

/** Twin of `settle`: drop a decided row and remember that it is decided. */
function settle(state: GuidesState, number: number): GuidesState {
  return {
    ...state,
    submissions: state.submissions.filter((held) => held.number !== number),
    settled: state.settled.includes(number) ? state.settled : [...state.settled, number],
  };
}

export function reduceGuides(state: GuidesState, event: GuidesEvent): GuidesState {
  switch (event.type) {
    case "configured": {
      const { repo, configured } = event.payload;
      // Only moves *into* unconfigured, and only from signed out: a restored
      // session must not be thrown away by a later configuration event.
      const auth =
        !configured && state.auth.type === "signedOut" ? ({ type: "unconfigured" } as const) : state.auth;
      return { ...state, repo, auth };
    }
    case "signInStarted":
      return { ...state, auth: { type: "waiting", payload: { login: event.payload.login } } };
    case "signedIn":
      return { ...state, auth: { type: "signedIn", payload: { identity: event.payload.identity } } };
    case "signInFailed":
      return { ...state, auth: { type: "failed", payload: { reason: event.payload.reason } } };
    case "signInCancelled":
    case "signedOut":
      return { ...state, auth: { type: "signedOut" } };
    case "queueLoading":
      return { ...state, status: { type: "loading" } };
    case "queueLoaded":
      return {
        ...state,
        // A submission this session already decided does not come back just
        // because GitHub's list has not caught up with the close.
        submissions: event.payload.submissions.filter(
          (submission) => !state.settled.includes(submission.number),
        ),
        status: { type: "ready" },
      };
    case "queueLoadFailed":
      return { ...state, status: { type: "failed", payload: { reason: event.payload.reason } } };
    case "accepting":
      return { ...state, write: { type: "accepting", payload: { number: event.payload.number } } };
    case "rejecting":
      return { ...state, write: { type: "rejecting", payload: { number: event.payload.number } } };
    // A settled verdict drops the row it settled. The queue is "what is still
    // open", and leaving a decided submission in it invites a second verdict.
    case "accepted":
      return {
        ...settle(state, event.payload.number),
        write: { type: "accepted", payload: { number: event.payload.number } },
      };
    case "rejected":
      return {
        ...settle(state, event.payload.number),
        write: { type: "rejected", payload: { number: event.payload.number } },
      };
    case "writeFailed":
      return {
        ...state,
        write: {
          type: "failed",
          payload: { number: event.payload.number, reason: event.payload.reason },
        },
      };
    // A fresh submission is being written, so the last one's result is no
    // longer the answer to anything on screen.
    case "submitReset":
      return { ...state, submit: { type: "idle" } };
    case "submitting":
      return { ...state, submit: { type: "sending" } };
    case "submitted":
      return { ...state, submit: { type: "sent", payload: { url: event.payload.url } } };
    case "submitFailed":
      return { ...state, submit: { type: "failed", payload: { reason: event.payload.reason } } };
  }
}
