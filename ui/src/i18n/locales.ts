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
