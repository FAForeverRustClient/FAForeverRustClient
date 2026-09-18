// The selected language, kept outside React so non-component code (date and
// number formatting in `shared/`) can read it too.
//
// This is intentionally *not* part of the Zustand app store: that store mirrors
// backend state and is replaced wholesale by backend events, whereas the
// language is a frontend-only preference for now. Phase 2 moves it into the
// backend `Settings` slice, at which point this module reads from there instead
// and the rest of the app keeps calling the same `t()`.

import { DEFAULT_LOCALE, isLocale, matchLocale, type Locale } from "./locales";

const STORAGE_KEY = "faf.locale";

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * The language the system is in, as far as the WebView will say.
 *
 * `navigator.languages` is the ordered list the operating system hands the
 * browser, so the first entry this client has a catalogue for is the best
 * answer available. A runtime that has neither property, or names nothing we
 * translate, answers `null`.
 */
export function detectSystemLocale(): Locale | null {
  if (typeof navigator === "undefined") return null;
  const tags = navigator.languages?.length
    ? navigator.languages
    : navigator.language
      ? [navigator.language]
      : [];
  return matchLocale(tags);
}

/**
 * The language to open in.
 *
 * A stored choice wins outright, and is the only thing that does: somebody who
 * picked English on a Russian machine meant it.
 *
 * With nothing stored, the system's language is used. That is the first run
 * after installing, which is the case the request was about: a client on a
 * Russian Windows opened in English and stayed there until its owner found the
 * picker.
 *
 * The detected language is deliberately *not* written back. Storing it would
 * turn "never chose" into a choice, and the next reader could no longer tell
 * the two apart; leaving it unwritten also means somebody who changes their
 * system language and has never touched the picker is followed rather than
 * left behind. `setLocale` writes, and only a real choice calls it.
 */
function readStoredLocale(): Locale {
  try {
    if (typeof window === "undefined") return DEFAULT_LOCALE;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(raw)) return raw;
  } catch {
    // A blocked or unavailable storage must not stop the client from starting.
    // Nothing is stored as far as this run is concerned, so the system's
    // language is still a better guess than English.
  }
  return detectSystemLocale() ?? DEFAULT_LOCALE;
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
