import { t } from "../i18n";
function wholeSeconds(seconds: number): number {
  return Math.max(0, Math.floor(seconds));
}

/** Countdown-oriented duration such as `4:08`. */
export function formatClockDuration(seconds: number): string {
  const total = wholeSeconds(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

/** Human-readable replay duration such as `1h 12m` or `8m 03s`. */
export function formatDuration(seconds: number | null, fallback = ""): string {
  if (seconds === null || seconds < 0) return fallback;
  const total = wholeSeconds(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
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
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

interface RelativeDurationOptions {
  nowLabel?: string;
  suffix?: string;
}

/** Coarse age for rapidly changing game lists, with optional ` ago` suffix. */
export function formatRelativeDuration(
  seconds: number,
  { nowLabel = t("common.now"), suffix = "" }: RelativeDurationOptions = {},
): string {
  const total = wholeSeconds(seconds);
  if (total < 60) return nowLabel;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${suffix}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m${suffix}`;
  return `${Math.floor(hours / 24)}d${suffix}`;
}
