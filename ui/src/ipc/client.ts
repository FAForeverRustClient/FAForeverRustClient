// The single typed bridge to the backend. No component calls `invoke`/`listen`
// directly: they go through here (ARCHITECTURE.md §4). Types come from the
// generated `bindings.ts`, so this surface can never drift from Rust.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppCommand, AppEvent, AppState } from "./bindings";

const EVENT_CHANNEL = "app://event";

export type FrontendMessage =
  | { kind: "event"; revision: number; event: AppEvent }
  | { kind: "snapshot"; revision: number; state: AppState };

export interface VersionedSnapshot {
  revision: number;
  state: AppState;
}

type CommandErrorHandler = (message: string) => void;

let commandErrorHandler: CommandErrorHandler | null = null;
let pendingCommandError: string | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportCommandError(error: unknown): void {
  const message = errorMessage(error);
  if (commandErrorHandler) {
    commandErrorHandler(message);
  } else {
    pendingCommandError = message;
  }
}

export const ipc = {
  /** UI → backend; resolves once the bounded runtime queue accepts the command. */
  dispatch(command: AppCommand): Promise<void> {
    return invoke("dispatch", { command });
  },

  /** Resolve only after the command's service effect has finished. */
  settle(command: AppCommand): Promise<void> {
    return invoke("dispatch_and_wait", { command });
  },

  /** UI → backend for event handlers. Bridge failures are reported centrally. */
  send(command: AppCommand): void {
    void invoke("dispatch", { command }).catch(reportCommandError);
  },

  /** Run another bridge-backed operation without creating a floating promise. */
  run(operation: Promise<unknown>): void {
    void operation.catch(reportCommandError);
  },

  /** Register the shell-level destination for unhandled bridge failures. */
  onCommandError(handler: CommandErrorHandler): () => void {
    commandErrorHandler = handler;
    if (pendingCommandError) {
      handler(pendingCommandError);
      pendingCommandError = null;
    }
    return () => {
      if (commandErrorHandler === handler) commandErrorHandler = null;
    };
  },

  /** Backend → UI: consistent snapshot for initial hydration. */
  snapshot(): Promise<VersionedSnapshot> {
    return invoke<VersionedSnapshot>("snapshot");
  },

  /** Subscribe to ordered deltas and lag-recovery snapshots. */
  onMessage(handler: (message: FrontendMessage) => void): Promise<UnlistenFn> {
    return listen<FrontendMessage>(EVENT_CHANNEL, (e) => handler(e.payload));
  },
};
