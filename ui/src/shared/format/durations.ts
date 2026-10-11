import { t } from "../../i18n";
function wholeSeconds(seconds: number): number {
  return Math.max(0, Math.floor(seconds));
}

/** Countdown-oriented duration such as `4:08`. */
export function formatClockDuration(seconds: number): string {
  const total = wholeSeconds(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

// The unit letters are copy like any other: `1h 12m` is `1 h 12 min` in
// German. One message per shape rather than one per unit, so a language can
// also reorder or space them.
const hoursMinutes = (hours: number, minutes: number) => t("duration.hoursMinutes", { hours, minutes });
const justMinutes = (minutes: number) => t("duration.minutes", { minutes });

/** Human-readable replay duration such as `1h 12m` or `8m 03s`. */
export function formatDuration(seconds: number | null, fallback = ""): string {
  if (seconds === null || seconds < 0) return fallback;
  const total = wholeSeconds(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return hoursMinutes(hours, minutes);
  return t("duration.minutesSeconds", { minutes, seconds: String(total % 60).padStart(2, "0") });
}

/**
 * How long a game has been going, as `24m` or `1h 12m`.
 *
 * Neither of the two above it. `formatDuration` keeps seconds below the hour,
 * which is noise on a value nobody reads to the second and would force the
 * view to tick once a second to stay honest. `formatRelativeDuration` answers
 * "now" under a minute, which is right for the age of a lobby listing and
 * wrong as the value of a field labelled "game time".
 */
export function formatGameTime(seconds: number): string {
  const total = wholeSeconds(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? hoursMinutes(hours, minutes) : justMinutes(minutes);
}

interface RelativeDurationOptions {
  nowLabel?: string;
}

/**
 * Coarse age for rapidly changing game lists: `24m`, `1h 12m`, `3d`.
 *
 * A caller that wants "ago" puts this into its own message (`replays.card.ago`)
 * rather than appending a suffix: German fronts the preposition.
 */
export function formatRelativeDuration(
  seconds: number,
  { nowLabel = t("common.now") }: RelativeDurationOptions = {},
): string {
  const total = wholeSeconds(seconds);
  if (total < 60) return nowLabel;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return justMinutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hoursMinutes(hours, minutes % 60);
  return t("duration.days", { days: Math.floor(hours / 24) });
}

/** Zero minutes, for a duration that is running but has not reached one. */
export function zeroMinutes(): string {
  return justMinutes(0);
}
