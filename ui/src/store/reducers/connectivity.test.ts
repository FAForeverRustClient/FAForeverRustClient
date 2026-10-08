// Tests for the frontend connectivity reducer, the twin of
// `faf_domain::state::connectivity::reduce`.
//
// The conformance fixture replays the Rust cases through this twin; these pin
// the two rules the settings page leans on directly: a relay's line replaces
// itself rather than appearing twice, and nothing lands outside a run.

import { describe, expect, it } from "vitest";
import type { CheckStep, ConnectivityEvent, ConnectivityState } from "../../ipc/bindings";
import { useAppStore } from "../store";
import { reduceConnectivity } from "./connectivity";

const initial = (): ConnectivityState => useAppStore.getState().state.connectivity;

function apply(state: ConnectivityState, events: ConnectivityEvent[]): ConnectivityState {
  return events.reduce(reduceConnectivity, state);
}

const started: ConnectivityEvent = { type: "checkStarted", payload: { startedAt: "2026-10-08T18:00:00+00:00" } };

function reported(step: CheckStep): ConnectivityEvent {
  return { type: "stepReported", payload: { step } };
}

const probing: CheckStep = {
  id: "server:0",
  outcome: "running",
  finding: { type: "serverProbing", payload: { url: "stun:eu.relay.example.org", transport: "udp" } },
};

const answered: CheckStep = {
  id: "server:0",
  outcome: "pass",
  finding: {
    type: "serverReachable",
    payload: { url: "stun:eu.relay.example.org", transport: "udp", roundTripMs: 23, publicAddress: "203.0.113.7:51234" },
  },
};

describe("reduceConnectivity", () => {
  it("starts idle with no lines, as the Rust default does", () => {
    expect(initial()).toEqual({
      check: { status: { type: "idle" }, steps: [], startedAt: "" },
      relay: { type: "idle" },
    });
  });

  it("replaces a relay's line in place when it answers", () => {
    const next = apply(initial(), [
      started,
      reported(probing),
      reported({ id: "reachability", outcome: "info", finding: { type: "noAdapterLog" } }),
      reported(answered),
    ]);
    expect(next.check.steps.map((step) => step.id)).toEqual(["server:0", "reachability"]);
    expect(next.check.steps[0]).toEqual(answered);
  });

  it("ignores lines and verdicts outside a run, and a new run starts empty", () => {
    const idle = initial();
    expect(apply(idle, [reported(answered), { type: "checkFinished", payload: { verdict: "fail" } }])).toBe(idle);

    const finished = apply(idle, [started, reported(answered), { type: "checkFinished", payload: { verdict: "pass" } }]);
    expect(finished.check.status).toEqual({ type: "finished", payload: { verdict: "pass" } });
    expect(apply(finished, [reported(probing)])).toBe(finished);

    const again = apply(finished, [{ type: "checkStarted", payload: { startedAt: "2026-10-08T18:05:00+00:00" } }]);
    expect(again.check).toEqual({ status: { type: "running" }, steps: [], startedAt: "2026-10-08T18:05:00+00:00" });
  });

  it("replaces the relay status whole", () => {
    const next = apply(initial(), [
      { type: "relayStatusUpdated", payload: { status: { type: "unsupported", payload: { adapter: "go" } } } },
    ]);
    expect(next.relay).toEqual({ type: "unsupported", payload: { adapter: "go" } });
  });
});
