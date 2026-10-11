// The harness for mounted component tests: a test file that imports this runs
// against a DOM (it must also say `// @vitest-environment happy-dom` at the
// top) with the IPC boundary mocked (`vi.mock(".../ipc/client")`).
//
// The store is seeded the way the app seeds it, by hydrating a snapshot, and
// answered the way the backend answers, by applying an event through the same
// root reducer. After each test the tree is unmounted, the store is put back
// to the state it started in and the recorded commands are cleared, so the
// tests in a file do not see each other.
//
// Kept out of the node-environment tests on purpose: those are the reducer
// and presentation layer and must stay fast; only a file that mounts a
// component pays for a DOM.

import { act, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import type { AppEvent, AppState } from "../ipc/bindings";
import { useAppStore } from "../store/store";
import { clearSentCommands } from "./sentCommands";

export { clearSentCommands, sentCommands } from "./sentCommands";

const pristine = useAppStore.getState();

afterEach(() => {
  cleanup();
  useAppStore.setState(pristine, true);
  clearSentCommands();
});

/** The store's state before any test touched it: the app's own defaults. */
export function initialState(): AppState {
  return pristine.state;
}

/**
 * Hydrate the store from a snapshot derived from the defaults, as the app does
 * with the backend's first snapshot. Call before rendering.
 */
export function seedStore(build: (state: AppState) => AppState): void {
  useAppStore.getState().hydrate(build(pristine.state));
}

/**
 * Apply one backend event through the root reducer, inside `act` so whatever
 * subscribed to the store has redrawn by the time this returns.
 */
export function applyEvent(event: AppEvent): void {
  act(() => {
    useAppStore.getState().apply(event);
  });
}
