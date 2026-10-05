// What the submission queue says about the last verdict, read off the guides
// slice. Kept apart from the component so the rules are tested without React.

import type { GuidesState } from "../../ipc/bindings";

/**
 * The failed write worth showing, if any.
 *
 * Only while its row is still listed. A failure is about a row, and one that
 * has since gone (decided by somebody else, or by a later attempt that worked)
 * used to keep its error on screen beside a list that no longer had the row
 * it described.
 */
export function writeFailure(state: GuidesState): { number: number; reason: string } | null {
  if (state.write.type !== "failed") return null;
  const { number, reason } = state.write.payload;
  return state.submissions.some((submission) => submission.number === number)
    ? { number, reason }
    : null;
}

/** The verdict that just settled, for the line that says it worked. */
export function settledNotice(
  state: GuidesState,
): { verdict: "accepted" | "declined"; number: number } | null {
  if (state.write.type === "accepted") {
    return { verdict: "accepted", number: state.write.payload.number };
  }
  if (state.write.type === "rejected") {
    return { verdict: "declined", number: state.write.payload.number };
  }
  return null;
}
