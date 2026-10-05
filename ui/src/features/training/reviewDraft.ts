// The review request form's draft, outside the form.
//
// The dialog closes on Escape and on a click beside it, and both used to take
// whatever the player had written with them: the draft lived in the dialog's
// own state and nowhere else. It is kept here per replay instead, for as long
// as the client runs, so reopening the request for the same game brings the
// text back. It is let go when the player cancels on purpose, or once the
// request has been copied out to be posted.

import type { ReviewRequestDraft } from "../../ipc/bindings";

const kept = new Map<string, ReviewRequestDraft>();

/**
 * Which game a draft is about, as the service opened it.
 *
 * Taken from the prefilled draft rather than from what the player has typed
 * since: editing the replay field must not move the draft to another key.
 */
export function reviewKey(draft: ReviewRequestDraft): string {
  if (draft.replayId !== null) return `id:${draft.replayId}`;
  if (draft.replayLink.trim() !== "") return `link:${draft.replayLink.trim()}`;
  if (draft.replayFile.trim() !== "") return `file:${draft.replayFile.trim()}`;
  return "blank";
}

export function keptReview(key: string): ReviewRequestDraft | null {
  return kept.get(key) ?? null;
}

export function keepReview(key: string, draft: ReviewRequestDraft): void {
  kept.set(key, draft);
}

export function forgetReview(key: string): void {
  kept.delete(key);
}

/** Field by field, because the state's echo of a draft is never the same object. */
export function sameReview(a: ReviewRequestDraft | null, b: ReviewRequestDraft | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const keys = Object.keys(a) as (keyof ReviewRequestDraft)[];
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * What the replay field shows: the one reference the post will name.
 *
 * Twin of `replay_reference` in `faf_domain::state::training`. The field used
 * to show the link or else the file, while the post fell back to the replay id
 * as well, so a field that looked empty could still name a replay.
 */
export function replayReference(draft: ReviewRequestDraft): string {
  if (draft.replayLink.trim() !== "") return draft.replayLink;
  if (draft.replayId !== null) return `#${draft.replayId}`;
  return draft.replayFile;
}

/**
 * The draft after the player typed `value` into the replay field.
 *
 * What they typed becomes the only reference. The id and the local file the
 * form was opened with are dropped with it: kept, clearing the field brought
 * the file name straight back, and a typed link next to them left the request
 * describing two replays.
 */
export function withReplay(draft: ReviewRequestDraft, value: string): ReviewRequestDraft {
  return { ...draft, replayLink: value, replayFile: "", replayId: null };
}
