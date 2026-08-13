const SHORT_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

/** Fixed until the client has an explicit language setting and translation catalogue. */
export const CLIENT_LOCALE = "en-US";

export function formatDate(
  value: string | number,
  fallback = "Unknown",
  options?: Intl.DateTimeFormatOptions,
): string {
  if (value === "" || (typeof value === "number" && value <= 0)) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleDateString(CLIENT_LOCALE, options);
}

export function formatShortDate(value: string | number, fallback = "Unknown"): string {
  return formatDate(value, fallback, SHORT_DATE_OPTIONS);
}

export function formatDateTime(value: string | number, fallback = "Unknown"): string {
  if (value === "" || (typeof value === "number" && value <= 0)) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? fallback
    : date.toLocaleString(CLIENT_LOCALE, { dateStyle: "medium", timeStyle: "short" });
}
