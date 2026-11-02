// The reactive mirror of the backend's AppState. Slices match faf-domain.
// Tabs read with `useAppStore(s => s.state.<slice>)` and never mutate directly,
// the only writes are `apply` (from events) and `hydrate` (initial snapshot).
// Until that snapshot arrives it holds `AppState::default()`, which
// `pnpm run bindings` generates into `ui/src/ipc/initialState.ts`.

import { create } from "zustand";
import type { AppEvent, AppState, AuthState } from "../ipc/bindings";
import { INITIAL_STATE } from "../ipc/initialState";
import { clearDrafts } from "../shared/chatDrafts";
import { applyEvent } from "./reducer";

interface AppStore {
  state: AppState;
  /** True only after the authoritative Rust snapshot has replaced defaults. */
  hydrated: boolean;
  /** Apply a backend event (the only state-changing path, mirrors the backend). */
  apply: (event: AppEvent) => void;
  /** Replace state with a backend snapshot (initial hydration). */
  hydrate: (state: AppState) => void;
}

function clearDraftsOnAuthChange(previous: AuthState, next: AuthState): void {
  if (previous.status !== next.status || previous.mode !== next.mode || previous.player?.id !== next.player?.id) {
    clearDrafts();
  }
}

export const useAppStore = create<AppStore>((set) => ({
  state: INITIAL_STATE,
  hydrated: false,
  apply: (event) => set((s) => {
    const state = applyEvent(s.state, event);
    clearDraftsOnAuthChange(s.state.auth, state.auth);
    return { state };
  }),
  hydrate: (state) => set((s) => {
    clearDraftsOnAuthChange(s.state.auth, state.auth);
    return { state, hydrated: true };
  }),
}));
