// The single typed bridge to the backend. No component calls `invoke`/`listen`
// directly — they go through here (ARCHITECTURE.md §4). Types come from the
// generated `bindings.ts`, so this surface can never drift from Rust.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppCommand, AppEvent, AppState } from "./bindings";

const EVENT_CHANNEL = "app://event";

export const ipc = {
  /** UI → backend. Returns immediately; results arrive as events. */
  dispatch(command: AppCommand): Promise<void> {
    return invoke("dispatch", { command });
  },

  /** Backend → UI: consistent snapshot for initial hydration. */
  snapshot(): Promise<AppState> {
    return invoke<AppState>("snapshot");
  },

  /** Subscribe to the backend event stream. One subscription for the whole app. */
  onEvent(handler: (event: AppEvent) => void): Promise<UnlistenFn> {
    return listen<AppEvent>(EVENT_CHANNEL, (e) => handler(e.payload));
  },
};
