// Intl constructors are much more expensive than formatting with an instance.
const dates = new Map<string, Intl.DateTimeFormat>();
const numbers = new Map<string, Intl.NumberFormat>();
const plurals = new Map<string, Intl.PluralRules>();

function cached<T>(cache: Map<string, T>, key: string, create: () => T): T {
  const known = cache.get(key);
  if (known) return known;
  const value = create();
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

export function dateFormatter(locale: string, options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cached(dates, JSON.stringify([locale, options]), () => new Intl.DateTimeFormat(locale, options));
}

export function numberFormatter(locale: string, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  return cached(numbers, JSON.stringify([locale, options]), () => new Intl.NumberFormat(locale, options));
}

export function pluralFormatter(locale: string): Intl.PluralRules {
  return cached(plurals, locale, () => new Intl.PluralRules(locale));
}
