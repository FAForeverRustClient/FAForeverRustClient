// What the submission queue says about the last verdict, read off the guides
// slice. Kept apart from the component so the rules are tested without React.

import type { GuideSubmission, GuidesState } from "../../ipc/bindings";

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

/**
 * Twin of `GuideSubmission::is_acceptable`: an entry to publish, and for a
 * pull request a guide that was read and nothing in it besides that guide and
 * its pictures.
 */
export function isAcceptable(submission: GuideSubmission): boolean {
  if (submission.entry === null) return false;
  const pull = submission.pull;
  return (
    pull === null ||
    (pull.foreign.length === 0 && pull.headSha !== "" && submission.guide !== null)
  );
}
