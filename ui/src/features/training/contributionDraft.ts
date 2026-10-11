// Whether two contribution drafts say the same thing.
//
// The contribution form hands its draft to the state while the author writes,
// and the state hands every draft straight back as a new object. Telling that
// echo apart from a draft somebody else put there (a reset, a fresh form) is
// what lets the form keep typing through the round trip: adopting the echo
// would replace whatever was typed while it travelled with the older text.

import type { ContributionDraft } from "../../ipc/bindings";

/** Field by field, because the echo is never the same object. */
export function sameDraft(a: ContributionDraft | null, b: ContributionDraft | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const keys = Object.keys(a) as (keyof ContributionDraft)[];
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    const left = a[key];
    const right = b[key];
    if (Array.isArray(left) && Array.isArray(right)) {
      return left.length === right.length && left.every((value, index) => value === right[index]);
    }
    return left === right;
  });
}

/**
 * Read a rating bound the way people write one.
 *
 * `1,200`, `1.200`, `1 200` and `1200+` all mean 1200, and used to vanish
 * because only bare digits were understood. Empty is "no bound" (`null`);
 * anything still not a whole number afterwards is `"invalid"`, so the form can
 * say so instead of dropping it.
 */
export function parseRating(text: string): number | null | "invalid" {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  // Grouping separators (`\s` covers the no-break spaces some locales group
  // with), a trailing plus, and nothing else is forgiven.
  const digits = trimmed.replace(/\+$/, "").replace(/[\s,.']/g, "");
  if (!/^\d+$/.test(digits)) return "invalid";
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : "invalid";
}

export type RatingProblem = "ratingMinInvalid" | "ratingMaxInvalid" | "ratingOrder";

/** What is wrong with the draft's rating band, if anything. */
export function ratingProblem(draft: Pick<ContributionDraft, "ratingMin" | "ratingMax">): RatingProblem | null {
  const min = parseRating(draft.ratingMin);
  const max = parseRating(draft.ratingMax);
  if (min === "invalid") return "ratingMinInvalid";
  if (max === "invalid") return "ratingMaxInvalid";
  if (min !== null && max !== null && min > max) return "ratingOrder";
  return null;
}

/**
 * The draft with its rating bounds written as bare digits.
 *
 * The composed post prints the bounds as they are, so `1,200+` would reach the
 * repository as typed; normalised here it reads the same as every other entry.
 * A bound that does not parse is left alone: the form blocks it anyway.
 */
export function normaliseRatings(draft: ContributionDraft): ContributionDraft {
  const write = (text: string) => {
    const value = parseRating(text);
    return typeof value === "number" ? String(value) : value === null ? "" : text;
  };
  const ratingMin = write(draft.ratingMin);
  const ratingMax = write(draft.ratingMax);
  if (ratingMin === draft.ratingMin && ratingMax === draft.ratingMax) return draft;
  return { ...draft, ratingMin, ratingMax };
}

/**
 * The maps field as a list: comma separated, each name trimmed, empties
 * dropped. Spaces inside a name are kept, because "Setons Clutch" is one map.
 */
export function splitMaps(text: string): string[] {
  return text
    .split(",")
    .map((map) => map.trim())
    .filter((map) => map !== "");
}
