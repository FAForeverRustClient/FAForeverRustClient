// Opening one settings section from somewhere else in the client.
//
// A notification can send you into Settings at a particular place: the
// game-cache alert, the two install messages and the update banner all do. That
// used to be a `scrollIntoView` on an element id, which worked while the whole
// tab was one scroll. It cannot work now, because the section it wants is not
// merely further down: it is not on screen at all until the sidebar opens it.
//
// So the request is a value rather than a scroll, and the settings view reads
// it when it mounts and whenever it changes.

import type { SectionKey } from "./sections";

/**
 * The section names the backend sends, and the sidebar section each one means.
 *
 * The names are part of the protocol: `NotificationAction::OpenSettings`
 * carries them from Rust, so they are translated here rather than renamed
 * there. A name with no entry leaves the tab where it opens, which is the
 * honest answer: nobody is sent to a page unrelated to what they clicked.
 */
const NOTIFICATION_SECTIONS: Record<string, SectionKey> = {
  // The game and replay install both live under Paths, and so does the note
  // about where a redirected pick was sent.
  paths: "paths",
  folders: "paths",
  // "How much disk is this using", which is the alert's whole subject.
  gameCache: "cache",
  updates: "general",
  general: "general",
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

export function sectionForNotification(section: string): SectionKey | null {
  return NOTIFICATION_SECTIONS[section] ?? null;
}

let requested: SectionKey | null = null;
const listeners = new Set<() => void>();

/** Ask the settings view to open `section` the next time it renders. */
export function requestSettingsSection(section: string): void {
  const target = sectionForNotification(section);
  if (!target) return;
  requested = target;
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
export function pendingSettingsRequest(): SectionKey | null {
  return requested;
}

export function clearSettingsRequest(): void {
  if (requested === null) return;
  requested = null;
  for (const listener of listeners) listener();
}
