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
  chat: { status: "disconnected", messages: [], users: [] },
  lobby: {
    status: "disconnected",
    games: [],
    liveGames: [],
    join: { type: "idle" },
    host: { type: "idle" },
    ratings: {},
  },
  replays: {
    status: { type: "idle" },
    lastWarning: null,
    vault: [],
    vaultStatus: { type: "idle" },
    local: [],
    localStatus: { type: "idle" },
  },
  maps: {
    vault: [],
    vaultStatus: { type: "idle" },
    installed: [],
    installedStatus: { type: "idle" },
    installStatus: { type: "idle" },
  },
  mods: {
    vault: [],
    vaultStatus: { type: "idle" },
    installed: [],
    installedStatus: { type: "idle" },
    installStatus: { type: "idle" },
    toggleStatus: { type: "idle" },
  },
  leaderboard: {
    leagues: [],
    leaguesStatus: { type: "idle" },
    selectedLeagueId: null,
    entries: [],
    entriesStatus: { type: "idle" },
    globalEntries: [],
    globalStatus: { type: "idle" },
  },
  settings: { theme: "forgeDark", gamePath: "", replayGamePath: "" },
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
