// Naming the country behind a flag, wherever a flag is shown.
//
// The flags were labelled with the ISO code they came from, which is only
// useful to somebody who already knows the code: the report was from a player
// who could not tell which country a flag belonged to, and "PL" does not
// answer that any better than the picture did.

import { useCallback } from "react";

import { intlTag } from "../i18n/locales";
import { useLocale } from "../i18n/useTranslation";
import { countryLabel } from "./countryFlags";

/**
 * A function naming the country behind a flag, in the user's language.
 *
 * A hook rather than a bare call because the name has to follow the language
 * picker, and one that returns a function rather than a name because the lists
 * that show flags show a few hundred at a time.
 */
export function useCountryLabel(): (country: string) => string {
  const locale = useLocale();
  const tag = intlTag(locale);
  return useCallback((country: string) => countryLabel(country, tag), [tag]);
}
