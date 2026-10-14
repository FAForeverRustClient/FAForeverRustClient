// The rating-range badge a tile or row carries when the host set one.

import { Icon } from "../../../design-system/Icon";
import { t } from "../../../i18n";
import { boundsText } from "../../../shared/ratingBounds";

/**
 * A lobby's rating range, as a tag.
 *
 * Drawn as three pieces rather than one string because of what a negative
 * bound does to the one-string version: `-1000-700` reads as one number and a
 * hyphen, and the eye has no way to tell which of the two hyphens is a minus
 * sign. Spacing the separator apart from both numbers is the whole fix, and it
 * only works if the separator is its own element.
 *
 * The separator is hidden from assistive technology: the tooltip already says
 * "Rating range: {min} to {max}" in words, and a screen reader announcing a
 * lone hyphen between two numbers is noise.
 *
 * A range open at one end is that end in words, "From 1200" or "Up to 1800",
 * rather than "1200 - Any" (#512).
 */
export function RatingRangeTag(
  { min, max, enforced }: { min: number | null; max: number | null; enforced: boolean },
) {
  const range = boundsText(min, max, minusSign) ?? "";
  return (
    <i
      className={`game-rating-range${enforced ? " is-enforced" : ""}`}
      title={
        enforced
          ? t("lobby.browser.ratingRangeEnforcedTooltip", { range })
          : t("lobby.browser.ratingRangeTooltip", { range })
      }
    >
      {/* A shield is the difference between a range that keeps people out and
          one that only suggests. Without it both looked the same, and only one
          of them was a rule. Not the padlock it was: that is a private game's
          mark, and on a tile the two read as one. */}
      {enforced && <Icon name="shield" size={12} />}
      {min !== null && max !== null ? (
        <>
          <span>{minusSign(min)}</span>
          <span className="game-rating-range-separator" aria-hidden="true">-</span>
          <span>{minusSign(max)}</span>
        </>
      ) : (
        <span>{range}</span>
      )}
    </i>
  );
}

/**
 * A number whose sign sits where the eye expects it.
 *
 * `-` is HYPHEN-MINUS, and in this interface's font it is drawn low: against
 * four digits it lands in the bottom half of them, which is what the report
 * noticed. U+2212 MINUS SIGN is the one designed to sit on the same axis as
 * the digits, and it is the same width as them, so a column of ratings still
 * lines up.
 *
 * Only the sign. The separator between the two bounds stays a hyphen, because
 * it is a range dash rather than an operator and the spacing around it is what
 * distinguishes the two.
 */
function minusSign(value: number): string {
  return value < 0 ? `\u2212${Math.abs(value)}` : String(value);
}
