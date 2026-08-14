// React binding. `useSyncExternalStore` keeps every subscribed component in
// step with the module-level locale without a context provider, so no part of
// the tree has to be wrapped and non-React code can still read the same value.

import { useCallback, useSyncExternalStore } from "react";

import { translateIn, type MessageValues } from "./index";
import type { MessageKey } from "./catalog/en";
import type { Locale } from "./locales";
import { getLocale, setLocale, subscribeToLocale } from "./store";

export interface Translation {
  t: (key: MessageKey, values?: MessageValues) => string;
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export function useLocale(): Locale {
  // `getLocale` is passed as the server snapshot as well. There is no server in
  // a desktop app; that argument is what React uses for any non-hydrating
  // render, which includes `renderToStaticMarkup`. Returning a fixed default
  // there would make every statically rendered view English regardless of the
  // user's choice.
  return useSyncExternalStore(subscribeToLocale, getLocale, getLocale);
}

export function useTranslation(): Translation {
  const locale = useLocale();
  const translate = useCallback(
    (key: MessageKey, values?: MessageValues) => translateIn(locale, key, values),
    [locale],
  );
  return { t: translate, locale, setLocale };
}
