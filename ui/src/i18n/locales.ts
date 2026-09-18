// The set of languages the client ships. Adding one means adding an entry here
// plus a catalogue under `catalog/`; nothing else in the app needs to change.
//
// `intlTag` is deliberately separate from the catalogue key: the key is what we
// persist and what the catalogues are named after, while the tag is what `Intl`
// needs for dates, numbers and plural rules. Keeping them apart means a future
// regional variant (say `pt-BR`) does not force a rename of the catalogue.

export interface LocaleDefinition {
  /** Shown in the language picker, always in the language itself. */
  readonly name: string;
  /** BCP 47 tag handed to `Intl.*`. */
  readonly intlTag: string;
}

export const LOCALES = {
  en: { name: "English", intlTag: "en-US" },
  de: { name: "Deutsch", intlTag: "de-DE" },
  fr: { name: "Français", intlTag: "fr-FR" },
  ru: { name: "Русский", intlTag: "ru-RU" },
  es: { name: "Español", intlTag: "es-ES" },
  pl: { name: "Polski", intlTag: "pl-PL" },
} as const satisfies Record<string, LocaleDefinition>;

export type Locale = keyof typeof LOCALES;

/**
 * English is the source language: every catalogue key is defined here first, so
 * it is also the fallback whenever another catalogue is incomplete.
 */
export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_KEYS = Object.keys(LOCALES) as Locale[];

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && value in LOCALES;
}

export function intlTag(locale: Locale): string {
  return LOCALES[locale].intlTag;
}

/**
 * The shipped locale that best matches a list of BCP 47 tags, or `null`.
 *
 * The tags come from the browser, which in the desktop app is the system
 * WebView and reports the operating system's own language list. So a client
 * installed on a Russian Windows can open in Russian rather than making its
 * owner find the picker first, which is what was asked for.
 *
 * Matched on the primary subtag only. `ru-RU`, `ru-BY` and a bare `ru` all
 * want the Russian catalogue, and the catalogues are keyed by language rather
 * than by region for exactly that reason (see `intlTag`, which is where the
 * region still matters). A regional variant of a language nobody has
 * translated falls through to the next tag the system named, and then to
 * `null`, which the caller reads as "use the default".
 */
export function matchLocale(tags: readonly string[]): Locale | null {
  for (const tag of tags) {
    const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (isLocale(primary)) return primary;
  }
  return null;
}
