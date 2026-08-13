/** Case-insensitive substring matching for optional catalogue fields. */
export function includesNormalized(value: string | null | undefined, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return needle === "" || (value ?? "").toLocaleLowerCase().includes(needle);
}

/** Inclusive range matching. A null bound leaves that side unbounded. */
export function isWithinNumberRange(
  value: number,
  minimum: number | null,
  maximum: number | null,
): boolean {
  return (minimum === null || value >= minimum) && (maximum === null || value <= maximum);
}

/**
 * Inclusive calendar-day matching for ISO timestamps and date-input values.
 * Invalid catalogue timestamps do not match an active date filter.
 */
export function isWithinDateRange(
  value: string,
  after: string,
  before: string,
): boolean {
  if (!after && !before) return true;

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;

  const afterTimestamp = after ? Date.parse(`${after}T00:00:00.000Z`) : null;
  const beforeTimestamp = before ? Date.parse(`${before}T23:59:59.999Z`) : null;

  return (
    (afterTimestamp === null || !Number.isFinite(afterTimestamp) || timestamp >= afterTimestamp)
    && (beforeTimestamp === null || !Number.isFinite(beforeTimestamp) || timestamp <= beforeTimestamp)
  );
}
