// `useState` that outlives the component for the rest of the session.
//
// Tabs are unmounted when they lose focus, so every filter, search and page a
// tab keeps in local state was gone the moment somebody looked at another tab
// and came back (#388). The settings file is the wrong home for most of that:
// a search typed an hour ago is not a preference. Memory is the right one: it
// lasts as long as the client is open and no longer.

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

const memory = new Map<string, unknown>();

/**
 * Like `useState`, but seeded from the value the same `key` had when its last
 * user unmounted, and remembered again on every change.
 *
 * Keys are global, so they are namespaced by the view that owns them
 * (`"mods.vault.page"`). Two views mounted at once with the same key would
 * each overwrite the other's memory; nothing in this client does that.
 */
export function useSessionState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (memory.has(key)) return memory.get(key) as T;
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  useEffect(() => {
    memory.set(key, value);
  }, [key, value]);
  return [value, setValue];
}

/** Forget everything, for tests. */
export function clearSessionState() {
  memory.clear();
}
