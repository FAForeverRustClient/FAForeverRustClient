// Conformance: the frontend reducer must agree with the Rust one.
//
// `reducers/*.ts` are hand-written twins of `crates/faf-domain/src/state/`.
// TypeScript's exhaustive switch catches a *missing* event variant; nothing
// catches the same variant taking a different transition, and nothing
// reconciles the two at runtime: `src-tauri` re-sends a full snapshot only
// when the event broadcast lags. A divergence therefore persists silently.
//
// The fixture is written by `crates/faf-domain/tests/conformance_fixtures.rs`
// on every `cargo test`, and records what `faf_domain::reduce` *actually*
// does. That matters: a hand-written expectation here would only encode
// someone's reading of the Rust: the same reading that produced the one
// divergence already found (`userLeft` creating a chat channel).
//
// If this fails after a Rust change, the twin has not kept up. Fix the twin,
// not the fixture.

import { describe, expect, it } from "vitest";
import type {
  AppEvent,
  AppState,
  GalacticWarState,
  Review,
  ReviewSummary,
  UploadsState,
} from "../ipc/bindings";
import fixture from "./__fixtures__/reducer-conformance.json";
import { canLaunch, installTarget, updateAvailable } from "../shared/galacticWarActions";
import { noteForPlayer } from "../shared/playerNotes";
import { applyEvent } from "./reducer";
import { summarize } from "./reducers/reviews";
import { isUploadBusy } from "./reducers/uploads";
import { useAppStore } from "./store";

interface Step {
  event: AppEvent;
  expected: unknown;
}

interface Case {
  name: string;
  steps: Step[];
}

interface HelperFixture {
  reviewSummaries: Array<{ reviews: Review[]; expected: ReviewSummary }>;
  uploadBusy: Array<{ status: UploadsState["status"]; expected: boolean }>;
  playerNoteLookups: Array<{
    notes: AppState["settings"]["social"]["playerNotes"];
    playerId: number;
    expected: string;
  }>;
  galacticWarActions: Array<{
    state: GalacticWarState;
    installTarget: string;
    updateAvailable: boolean;
    canLaunch: boolean;
  }>;
}

const cases = fixture.cases as unknown as Case[];
const initial = fixture.initial as unknown as AppState;
const helpers = fixture.helpers as unknown as HelperFixture;

describe("the frontend reducer matches the Rust one", () => {
  it("has cases to run", () => {
    // Guards against an empty or half-written fixture quietly passing.
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((testCase) => testCase.steps.length > 0)).toBe(true);
  });

  it.each(cases.map((testCase) => [testCase.name, testCase] as const))(
    "%s",
    (_name, testCase) => {
      let state = initial;
      testCase.steps.forEach((step, index) => {
        const before = state;
        state = applyEvent(state, step.event);
        const slice = `${step.event.kind[0].toLowerCase()}${step.event.kind.slice(1)}` as keyof AppState;
        const context = `after step ${index + 1}: ${JSON.stringify(step.event)}`;
        expect(state[slice], context).toEqual(step.expected);
        for (const otherSlice of Object.keys(before) as Array<keyof AppState>) {
          if (otherSlice !== slice) {
            expect(state[otherSlice], `${context}; unexpected change in ${otherSlice}`).toEqual(
              before[otherSlice],
            );
          }
        }
      });
    },
  );
});

describe("the store's initial state", () => {
  it("matches `AppState::default()` exactly", () => {
    // The frontend's INITIAL is hand-maintained alongside every new slice. If
    // it drifts, the client renders from a state the backend has never been
    // in: until the first event for that slice arrives, which for a slice
    // nobody touches may be never.
    expect(useAppStore.getState().state).toEqual(initial);
  });
});

describe("derived helper twins match Rust", () => {
  it.each(helpers.reviewSummaries)("summarizes reviews", ({ reviews, expected }) => {
    expect(summarize(reviews)).toEqual(expected);
  });

  it.each(helpers.uploadBusy)("classifies upload status $status.type", ({ status, expected }) => {
    expect(isUploadBusy(status)).toBe(expected);
  });

  it.each(helpers.playerNoteLookups)("finds player note $playerId", ({ notes, playerId, expected }) => {
    expect(noteForPlayer(notes, playerId)).toBe(expected);
  });

  it.each(helpers.galacticWarActions)(
    "decides the galactic war action for $state.installedVersion / $state.status.type",
    ({ state, ...expected }) => {
      expect({
        installTarget: installTarget(state),
        updateAvailable: updateAvailable(state),
        canLaunch: canLaunch(state),
      }).toEqual(expected);
    },
  );
});
