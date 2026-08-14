// The selected language, kept outside React so non-component code (date and
// number formatting in `shared/`) can read it too.
//
// This is intentionally *not* part of the Zustand app store: that store mirrors
// backend state and is replaced wholesale by backend events, whereas the
// language is a frontend-only preference for now. Phase 2 moves it into the
// backend `Settings` slice, at which point this module reads from there instead
// and the rest of the app keeps calling the same `t()`.

import { DEFAULT_LOCALE, isLocale, type Locale } from "./locales";

const STORAGE_KEY = "faf.locale";

type Listener = () => void;

const listeners = new Set<Listener>();

function readStoredLocale(): Locale {
  try {
    if (typeof window === "undefined") return DEFAULT_LOCALE;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isLocale(raw) ? raw : DEFAULT_LOCALE;
  } catch {
    // A blocked or unavailable storage must not stop the client from starting.
    return DEFAULT_LOCALE;
  }
}

let current: Locale = readStoredLocale();

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Persistence is a convenience; the in-memory choice still applies.
  }
  for (const listener of listeners) listener();
}

export function subscribeToLocale(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: restores the module to a known state between cases. */
export function resetLocaleForTests(locale: Locale = DEFAULT_LOCALE): void {
  current = locale;
  listeners.clear();
}
