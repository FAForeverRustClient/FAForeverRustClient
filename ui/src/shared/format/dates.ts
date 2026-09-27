import { getLocale, intlTag, t } from "../../i18n";
import { formatRelativeDuration } from "./durations";
import { formatWithTokens, systemDateTokens } from "./systemDate";

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
 *
 * The one thing taken from the system is the order of a numeric date, which
 * has no words in it: see `numericDate`.
 */
export function clientIntlTag(): string {
  return intlTag(getLocale());
}

/**
 * A date as numbers only, in the order of the user's regional format where
 * the system names one (`16.09.2026` for a day-first region, whatever the
 * language), and in the client language's order otherwise (issue 292).
 */
function numericDate(date: Date): string {
  const tokens = systemDateTokens();
  return tokens ? formatWithTokens(tokens, date) : date.toLocaleDateString(clientIntlTag());
}

export function formatDate(
  value: string | number,
  fallback = t("common.unknown"),
  options?: Intl.DateTimeFormatOptions,
): string {
  if (value === "" || (typeof value === "number" && value <= 0)) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return options ? date.toLocaleDateString(clientIntlTag(), options) : numericDate(date);
}

export function formatShortDate(value: string | number, fallback = t("common.unknown")): string {
  return formatDate(value, fallback, SHORT_DATE_OPTIONS);
}

export function formatTime(value: string | number, fallback = t("common.unknown")): string {
  if (value === "" || (typeof value === "number" && value <= 0)) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? fallback
    : date.toLocaleTimeString(clientIntlTag(), { timeStyle: "short" });
}

/**
 * The numeric date and the time of day, in one line.
 *
 * `formatDateTime` spells the month out (`Sep 13, 2026, 10:30 PM`), which reads
 * well in a detail row and is too wide for the two-column meta grid on a replay
 * card. This is the same short date those cards already printed, with the clock
 * time the card was missing appended to it.
 */
export function formatShortDateTime(value: string | number, fallback = t("common.unknown")): string {
  if (value === "" || (typeof value === "number" && value <= 0)) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  if (systemDateTokens()) {
    return `${numericDate(date)} ${date.toLocaleTimeString(clientIntlTag(), { hour: "2-digit", minute: "2-digit" })}`;
  }
  return date.toLocaleString(clientIntlTag(), {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDateTime(value: string | number, fallback = t("common.unknown")): string {
  if (value === "" || (typeof value === "number" && value <= 0)) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? fallback
    : date.toLocaleString(clientIntlTag(), { dateStyle: "medium", timeStyle: "short" });
}

/// A week. Past it, "how long ago" stops being the useful reading.
const RELATIVE_AGE_LIMIT_SECONDS = 7 * 24 * 60 * 60;

/**
 * How long ago something happened, or when it happened.
 *
 * "3d ago" answers the question for a game from this week. "67d ago" does not:
 * nobody counts back sixty-seven days, and the date it stands for is both
 * shorter to read and the thing the reader was after. So the relative form
 * holds for a week and the date takes over after that.
 */
export function formatAgeOrDate(value: string | number, fallback = ""): string {
  if (value === "" || (typeof value === "number" && value <= 0)) return fallback;
  const moment = new Date(value).getTime();
  if (Number.isNaN(moment)) return fallback;
  const seconds = (Date.now() - moment) / 1000;
  if (seconds < 0) return fallback;
  if (seconds >= RELATIVE_AGE_LIMIT_SECONDS) return formatShortDate(value, fallback);
  const justNow = t("replays.card.justNow");
  const elapsed = formatRelativeDuration(seconds, { nowLabel: justNow });
  // The whole phrase is one message: German fronts the preposition ("vor 3d"),
  // which a suffix appended to the duration could not produce.
  return elapsed === justNow ? elapsed : t("replays.card.ago", { duration: elapsed });
}
