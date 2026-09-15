// Opening one register from somewhere else in the client.
//
// A notification can send you into Settings at a particular place: the
// game-cache alert, the two install messages and the update banner all do. That
// used to be a `scrollIntoView` on an element id, which worked while the whole
// tab was one scroll. It cannot work now, because the register it wants is not
// merely further down: it is not on screen at all until the rail opens it.
//
// So the request is a value rather than a scroll, and the settings view reads
// it when it mounts and whenever it changes.

import type { RegisterKey } from "./registers";

/**
 * The section names the backend sends, and the register each one now means.
 *
 * The names are part of the protocol -- `NotificationAction::OpenSettings`
 * carries them from Rust -- so they are translated here rather than renamed
 * there. A name with no entry opens the index, which is the honest answer: it
 * lists every register, so nobody is stranded on a page unrelated to the
 * notification they clicked.
 */
const SECTION_REGISTERS: Record<string, RegisterKey> = {
  // The game and replay install both live under Paths, and so does the note
  // about where a redirected pick was sent.
  paths: "paths",
  folders: "paths",
  // "How much disk is this using", which is the alert's whole subject.
  gameCache: "cache",
  updates: "client",
  general: "client",
  appearance: "appearance",
  chat: "chat",
  notifications: "notifications",
  account: "account",
  discord: "account",
  game: "game",
  connectivity: "connectivity",
  diagnostics: "diagnostics",
  debugWindows: "diagnostics",
};

export function registerForSection(section: string): RegisterKey | null {
  return SECTION_REGISTERS[section] ?? null;
}

let requested: RegisterKey | null = null;
const listeners = new Set<() => void>();

/** Ask the settings view to open `section`'s register the next time it renders. */
export function requestSettingsSection(section: string): void {
  const register = registerForSection(section);
  if (!register) return;
  requested = register;
  for (const listener of listeners) listener();
}

export function subscribeToSettingsRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The pending request, if any.
 *
 * Read rather than taken: the settings view acts on it in an effect, and
 * clearing it from the snapshot getter would make that getter impure and give
 * `useSyncExternalStore` a different answer each time it asked.
 */
export function pendingSettingsRequest(): RegisterKey | null {
  return requested;
}

export function clearSettingsRequest(): void {
  if (requested === null) return;
  requested = null;
  for (const listener of listeners) listener();
}
