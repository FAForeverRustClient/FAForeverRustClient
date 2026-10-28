// How long a list's filters are remembered, one answer for every list (#447).
//
// The setting is `general.filterMemory`: never, until the client closes, or
// also across a restart. What counts as a filter is whatever narrows a list:
// a search, a "hide" or "only" switch, a picker, a vault preset. A sort order
// and a column layout are not filters and are kept the way they always were.
//
// Two kinds of list go through here.
//
// Most keep their filters in component state. They call
// `useRememberedFilter`, which keeps the value in this module for the rest of
// the session and, while the setting asks for it, in
// `browsing.rememberedFilters` for the next one.
//
// A few keep theirs in a browsing preference of its own, which predates this
// setting (the game browser's switches, the vault presets, the replay vault's
// player). The live replay filters did too, until #590. Those already outlive a tab switch, the
// backend clears them at startup unless the setting says otherwise, and
// `useForgetFiltersOnLeave` clears them when the tab is left while the setting
// is "never".
//
// One list is outside the setting: the play tab's game list (#648). Its
// switches, rules and search are kept across a restart whatever the setting
// says, because that list is set up once and opened every day, and finding it
// unfiltered after every start read as the client forgetting its settings.

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { FilterMemory } from "../ipc/bindings";
import { ipc } from "../ipc/client";
import { useAppStore } from "../store/store";

/** Every list's filters as it last left them, for the rest of this session. */
const sessionFilters = new Map<string, unknown>();

/**
 * What is stored for the next session, once anything in this session has
 * written to it. Sent whole on every write, and kept here rather than read
 * back from the store each time: two lists writing inside one round trip
 * would otherwise both start from the same stored copy, and the second write
 * would not hold the first.
 */
let storedFilters: Record<string, string> | null = null;

function currentMemory(): FilterMemory {
  return useAppStore.getState().state.settings.general.filterMemory ?? "session";
}

/**
 * The keys of the play tab's game list, which is always remembered across a
 * restart (#648). Twin of `ALWAYS_KEPT_FILTER_PREFIX` in the backend's
 * `BrowsingPreferences::without_filters`, which keeps the same entries.
 */
export const ALWAYS_KEPT_PREFIX = "play.";

/** How long the list behind `key` keeps its filters. */
function memoryFor(key: string): FilterMemory {
  return key.startsWith(ALWAYS_KEPT_PREFIX) ? "restart" : currentMemory();
}

/** Only the entries the setting never clears. */
function alwaysKept(filters: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).filter(([key]) => key.startsWith(ALWAYS_KEPT_PREFIX)));
}

/** The setting as it is now, for a value read once as a list mounts. */
export const filterMemoryNow = currentMemory;

/** An `accept` for filters stored as one object. */
export function isFilterRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The setting, for a component that has to react to it. */
export function useFilterMemory(): FilterMemory {
  return useAppStore((state) => state.state.settings.general.filterMemory ?? "session");
}

function storedFilter(key: string): unknown {
  const raw = (storedFilters ?? useAppStore.getState().state.settings.browsing.rememberedFilters)?.[key];
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function writeStoredFilters(next: Record<string, string>) {
  storedFilters = next;
  ipc.send({
    kind: "Settings",
    command: { type: "patchBrowsing", payload: { patch: { rememberedFilters: next } } },
  });
}

/**
 * The value a list should start from: what it last had, if the setting keeps
 * it, otherwise `fallback`.
 *
 * `accept` guards a value written by an older build whose filters had a
 * different shape; a value it refuses is treated as never stored.
 */
export function rememberedFilter<T>(key: string, fallback: T, accept?: (value: unknown) => boolean): T {
  const memory = memoryFor(key);
  if (memory === "never") return fallback;
  const candidates = memory === "restart"
    ? [sessionFilters.get(key), storedFilter(key)]
    : [sessionFilters.get(key)];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    if (accept && !accept(candidate)) continue;
    return candidate as T;
  }
  return fallback;
}

/** Note a list's filters as they are now, for as long as the setting says. */
export function rememberFilter(key: string, value: unknown) {
  const memory = memoryFor(key);
  if (memory === "never") return;
  sessionFilters.set(key, value);
  if (memory !== "restart") return;
  const base = storedFilters ?? useAppStore.getState().state.settings.browsing.rememberedFilters ?? {};
  const serialized = JSON.stringify(value);
  if (base[key] === serialized) return;
  writeStoredFilters({ ...base, [key]: serialized });
}

/**
 * Remember a list's filters, held wherever the list holds them, every time
 * they change. `key` names the list and must be unique in the client.
 *
 * The settings write is debounced: a search box changes on every keystroke,
 * and only where it stopped is worth one. The session copy is not, so a tab
 * left at once still comes back with what was typed.
 */
export function useRememberFilter(key: string, value: unknown) {
  const first = useRef(true);
  const pending = useRef<{ key: string; value: unknown } | null>(null);
  useEffect(() => {
    // The value it started from is already what is remembered.
    if (first.current) {
      first.current = false;
      return;
    }
    if (memoryFor(key) !== "never") sessionFilters.set(key, value);
    pending.current = { key, value };
    const timer = window.setTimeout(() => {
      pending.current = null;
      rememberFilter(key, value);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [key, value]);
  // A tab left inside the debounce still has its last change written.
  useEffect(() => () => {
    if (pending.current) rememberFilter(pending.current.key, pending.current.value);
  }, []);
}

/** `useState` for a list's filters, starting from what is remembered. */
export function useRememberedFilter<T>(
  key: string,
  fallback: T | (() => T),
  accept?: (value: unknown) => boolean,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() =>
    rememberedFilter(key, typeof fallback === "function" ? (fallback as () => T)() : fallback, accept),
  );
  useRememberFilter(key, value);
  return [value, setValue];
}

/**
 * Several filters of one list, remembered as one object and set field by
 * field. A remembered copy without a field, written before the field
 * existed, takes the default for it.
 */
export function useRememberedFilters<T extends object>(key: string, defaults: T) {
  const [filters, setFilters] = useState<T>(() => ({
    ...defaults,
    ...rememberedFilter<Partial<T>>(key, {}, isFilterRecord),
  }));
  useRememberFilter(key, filters);
  const setFilter = useCallback(<K extends keyof T>(field: K, value: T[K]) => {
    setFilters((current) => (current[field] === value ? current : { ...current, [field]: value }));
  }, []);
  return { filters, setFilter, setFilters };
}

/**
 * Run `forget` when the component leaves the screen while the setting is
 * "never": for the lists whose filters live in a browsing preference of their
 * own, which would otherwise come back the next time the tab is opened.
 */
export function useForgetFiltersOnLeave(forget: () => void) {
  const latest = useRef(forget);
  latest.current = forget;
  useEffect(() => () => {
    if (currentMemory() === "never") latest.current();
  }, []);
}

/**
 * Apply a change of the setting to what is already remembered.
 *
 * Never: everything goes, so the next list opened starts clean. Until the
 * client closes: nothing is kept for the next session, which the backend
 * would clear at startup anyway, but a file that still holds them is a
 * surprise for whoever reads it. Across a restart: what this session already
 * remembers is written down now, rather than only once each list changes
 * again. The play tab's game list keeps its filters through all three.
 */
export function filterMemoryChanged(next: FilterMemory) {
  if (next === "never") {
    for (const key of [...sessionFilters.keys()]) {
      if (!key.startsWith(ALWAYS_KEPT_PREFIX)) sessionFilters.delete(key);
    }
  }
  const base = storedFilters ?? useAppStore.getState().state.settings.browsing.rememberedFilters ?? {};
  if (next === "restart") {
    const written: Record<string, string> = { ...base };
    for (const [key, value] of sessionFilters) written[key] = JSON.stringify(value);
    writeStoredFilters(written);
  } else {
    writeStoredFilters(alwaysKept(base));
  }
}

/** For tests: start from an empty session. */
export function resetFilterMemoryForTests() {
  sessionFilters.clear();
  storedFilters = null;
}
