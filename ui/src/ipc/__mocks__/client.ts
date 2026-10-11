// The IPC boundary for mounted component tests, in place of `../client`.
//
// A test opts in with `vi.mock(".../ipc/client")`, and Vitest takes this file
// for it. Nothing here reaches Tauri: every command a component sends is
// recorded in order (`testing/sentCommands`), so a test can read what was asked
// for and then answer it the way the backend does, with an event applied to
// the store.

import type { AppCommand } from "../bindings";
import type { VersionedSnapshot } from "../client";
import { recordCommand } from "../../testing/sentCommands";

export const ipc = {
  dispatch(command: AppCommand): Promise<void> {
    recordCommand(command);
    return Promise.resolve();
  },

  settle(command: AppCommand): Promise<void> {
    recordCommand(command);
    return Promise.resolve();
  },

  send(command: AppCommand): void {
    recordCommand(command);
  },

  run(operation: Promise<unknown>): void {
    void operation.catch(() => undefined);
  },

  onCommandError(): () => void {
    return () => undefined;
  },

  reportStall(): void {},

  reportEventCost(): void {},

  snapshot(): Promise<VersionedSnapshot> {
    return Promise.reject(new Error("no backend in a mounted test"));
  },

  onMessage(): Promise<() => void> {
    return Promise.resolve(() => undefined);
  },
};
