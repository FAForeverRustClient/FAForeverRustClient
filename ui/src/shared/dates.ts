import { getLocale, intlTag, t } from "../i18n";

const SHORT_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

/**
 * The tag every date in the client is formatted with.
 *
 * This is resolved from the language the user picked, never from the operating
 * system: an English UI must not print German month names just because the host
 * happens to be German, and a German UI must not print `Aug 10, 2026`. Passing
 * it explicitly is also what keeps `scripts/check-architecture.mjs` satisfied,
 * which rejects any `Intl` or `toLocale*String` call that omits the locale and
 * would therefore inherit the host's.
 */
export function clientIntlTag(): string {
  return intlTag(getLocale());
}

export function formatDate(
  value: string | number,
  fallback = t("common.unknown"),
  options?: Intl.DateTimeFormatOptions,
): string {
  if (value === "" || (typeof value === "number" && value <= 0)) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleDateString(clientIntlTag(), options);
}

export function formatShortDate(value: string | number, fallback = t("common.unknown")): string {
  return formatDate(value, fallback, SHORT_DATE_OPTIONS);
}

export function formatDateTime(value: string | number, fallback = t("common.unknown")): string {
  if (value === "" || (typeof value === "number" && value <= 0)) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? fallback
    : date.toLocaleString(clientIntlTag(), { dateStyle: "medium", timeStyle: "short" });
}
