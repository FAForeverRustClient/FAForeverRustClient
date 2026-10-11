// What the mocked IPC boundary was asked to send, kept apart from the mock so
// that a test and the mock read the one list whichever path loaded them.

import type { AppCommand } from "../ipc/bindings";

const sent: AppCommand[] = [];

export function recordCommand(command: AppCommand): void {
  sent.push(command);
}

/** Every command sent since the last `clearSentCommands`, oldest first. */
export function sentCommands(): readonly AppCommand[] {
  return sent;
}

export function clearSentCommands(): void {
  sent.length = 0;
}
