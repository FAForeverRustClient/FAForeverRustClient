// The catalogue registry: the one place a language is wired in.
//
// Adding a language is two edits and nothing else:
//   1. a `catalog/<code>.ts` exporting a `Partial<Record<MessageKey, Message>>`
//   2. one entry here and one in `locales.ts`
//
// Catalogues are deliberately `Partial`. A language ships the moment it is
// useful rather than the moment it is complete: anything not yet translated
// falls back to English at lookup time (see `resolve` in `../index.ts`), so a
// half-translated language is a mixed but working UI, never a broken one.
// `pnpm run i18n:coverage` reports how far each one has got.

import type { Message, MessageKey } from "./en";
import { en } from "./en";
import type { Locale } from "../locales";

export type Catalogue = Partial<Record<MessageKey, Message>>;
export type CatalogueCode = Locale;

export const CATALOGUES: Record<Locale, Catalogue> = { en, de: {}, fr: {}, ru: {}, es: {}, pl: {} };
const loaders = {
  de: () => import("./de").then((module) => module.de),
  fr: () => import("./fr").then((module) => module.fr),
  ru: () => import("./ru").then((module) => module.ru),
  es: () => import("./es").then((module) => module.es),
  pl: () => import("./pl").then((module) => module.pl),
};
const loaded = new Set<Locale>(["en"]);
const pending = new Map<Locale, Promise<void>>();

export function catalogueLoaded(locale: Locale): boolean { return loaded.has(locale); }

export function loadCatalogue(locale: Locale): Promise<void> {
  if (locale === "en" || loaded.has(locale)) return Promise.resolve();
  const known = pending.get(locale);
  if (known) return known;
  const request = loaders[locale]().then((catalogue) => {
    CATALOGUES[locale] = catalogue;
    loaded.add(locale);
  }).finally(() => pending.delete(locale));
  pending.set(locale, request);
  return request;
}
