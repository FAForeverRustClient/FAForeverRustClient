// A lower and an upper bound, either of them possibly open, as words.

import { t } from "../i18n";

/**
 * `1200 to 1800`, `From 1200`, `Up to 1800`, or `null` when neither bound is
 * set and the caller has its own word for that.
 *
 * An open bound used to be filled in with "Any", which made "0 To Any" of a
 * lobby open at the top and read worse in every other language: in Russian it
 * came out as "from 1000 to ANY" (#512). A range with one end is said with
 * that end alone instead.
 */
export function boundsText(
  low: number | null,
  high: number | null,
  format: (value: number) => string = String,
): string | null {
  if (low !== null && high !== null) {
    return t("common.rangeBetween", { low: format(low), high: format(high) });
  }
  if (low !== null) return t("common.rangeFrom", { low: format(low) });
  if (high !== null) return t("common.rangeUpTo", { high: format(high) });
  return null;
}
