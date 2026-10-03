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
