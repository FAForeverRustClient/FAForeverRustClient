// The reactive mirror of the backend's AppState. Slices match faf-domain.
// Tabs read with `useAppStore(s => s.state.<slice>)` and never mutate directly —
// the only writes are `apply` (from events) and `hydrate` (initial snapshot).

import { create } from "zustand";
import type { AppEvent, AppState } from "../ipc/bindings";
import { applyEvent } from "./reducer";

const INITIAL: AppState = {
  session: { backendVersion: "", status: "disconnected" },
  auth: { status: "loggedOut", player: null, error: null },
  nav: { activeTab: "home" },
  lobby: { status: "disconnected", games: [], join: { type: "idle" } },
  settings: { theme: "forgeDark" },
};

interface AppStore {
  state: AppState;
  /** Apply a backend event (the only state-changing path, mirrors the backend). */
  apply: (event: AppEvent) => void;
  /** Replace state with a backend snapshot (initial hydration). */
  hydrate: (state: AppState) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  state: INITIAL,
  apply: (event) => set((s) => ({ state: applyEvent(s.state, event) })),
  hydrate: (state) => set({ state }),
}));
