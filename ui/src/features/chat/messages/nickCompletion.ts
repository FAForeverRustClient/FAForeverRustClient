// Tab completion of nicknames in the composer, kept apart from the component
// so the one decision that matters can be tested on its own: whether a Tab
// press belongs to the completion at all.
//
// It used to take every Tab unconditionally, which made the message box a
// keyboard trap: with an empty line, or a word nobody in the channel is called,
// Tab did nothing and focus could never leave for the emoji picker, the send
// button or anything else on the page. Tab now belongs to the completion only
// while there is something to complete or a run of candidates to cycle;
// otherwise it is the browser's, and moves focus like everywhere else.

export interface Completion {
  /** Text before the word being completed. */
  prefix: string;
  matches: string[];
  index: number;
}

export interface TabCompletion {
  completion: Completion;
  /** The whole line after the completion is applied. */
  text: string;
}

/**
 * What a Tab (or, with `backwards`, a Shift+Tab) press does to the line.
 *
 * `null` means the key is not ours: the caller must leave the event alone so
 * focus moves. Otherwise the caller prevents the default and applies `text`.
 *
 *  * An active run with more than one candidate cycles, forwards on Tab and
 *    backwards on Shift+Tab (Java's `AutoCompletionHelper`, Python's
 *    `ChatLineEdit.try_completion`).
 *  * A run with a single candidate has nothing left to cycle, so the next Tab
 *    moves on, the same as it would after typing the name out in full.
 *  * Shift+Tab never starts a completion: it is how the keyboard goes back.
 *  * Tab starts one only when the last word of the line is the start of a
 *    nickname here, and is not already exactly the only one it could be.
 */
export function tabCompletion(
  draft: string,
  nicknames: readonly string[],
  active: Completion | null,
  backwards: boolean,
): TabCompletion | null {
  if (active) {
    if (active.matches.length < 2) return null;
    const step = backwards ? -1 : 1;
    const count = active.matches.length;
    const index = (active.index + step + count) % count;
    return { completion: { ...active, index }, text: active.prefix + active.matches[index] };
  }
  if (backwards) return null;

  const separator = draft.lastIndexOf(" ");
  const partial = draft.slice(separator + 1);
  if (!partial) return null;
  const lower = partial.toLowerCase();
  const matches = nicknames
    .filter((name) => name.toLowerCase().startsWith(lower))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  if (matches.length === 0) return null;
  // Typed out in full already: completing it would change nothing, and
  // swallowing the key for that would trap focus all over again.
  if (matches.length === 1 && matches[0] === partial) return null;

  const prefix = draft.slice(0, separator + 1);
  return { completion: { prefix, matches, index: 0 }, text: prefix + matches[0] };
}
