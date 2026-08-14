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
import { de } from "./de";
import { fr } from "./fr";
import { ru } from "./ru";
import { es } from "./es";

export type Catalogue = Partial<Record<MessageKey, Message>>;

export const CATALOGUES = {
  en,
  de,
  fr,
  ru,
  es,
} as const satisfies Record<string, Catalogue>;

export type CatalogueCode = keyof typeof CATALOGUES;
