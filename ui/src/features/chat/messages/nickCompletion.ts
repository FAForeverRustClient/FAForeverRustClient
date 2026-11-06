// Tab completion of nicknames in the composer, kept apart from the component
// so the one decision that matters can be tested on its own: whether a Tab
// press belongs to the completion at all.
//
// It used to take every Tab unconditionally, which made the message box a
// keyboard trap: with an empty line, or a word nobody in the channel is called,
// Tab did nothing and focus could never leave for the emoji picker, the send
// button or anything else on the page. Tab now belongs to the box while the
// caret ends a word: it completes the word, cycles a run of candidates, or,
// for a word nobody here is called, does nothing (#712). That one used to move
// focus to the emoji button, so a mistyped name or a player who had just left
// threw the writer out of the line they were correcting. Everywhere else Tab
// is the browser's and moves focus as it does on any page: an empty line,
// after a space, a selection, a name already complete, and Shift+Tab always.

export interface Completion {
  /** Text before the word being completed. */
  prefix: string;
  /** Text after the caret, kept intact while candidates cycle. */
  suffix: string;
  matches: string[];
  index: number;
}

export interface TabCompletion {
  /** `null` when the press is kept in the box but completed nothing. */
  completion: Completion | null;
  /** The whole line after the completion is applied. */
  text: string;
  /** Restore the caret just after the completed nickname. */
  caret: number;
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
 *  * Tab starts one only when the word before the caret is the start of a
 *    nickname here, and is not already exactly the only one it could be.
 *  * A word before the caret that starts no nickname here keeps the press,
 *    leaving the line and the caret as they were (#712).
 */
export function tabCompletion(
  draft: string,
  nicknames: readonly string[],
  active: Completion | null,
  backwards: boolean,
  selection = { start: draft.length, end: draft.length },
): TabCompletion | null {
  // A selection is an explicit edit range, not an unfinished nickname.
  if (selection.start !== selection.end) return null;
  const caret = Math.max(0, Math.min(selection.start, draft.length));
  const current = active?.matches[active.index];
  if (active && draft === active.prefix + current + active.suffix
    && caret === active.prefix.length + (current?.length ?? 0)) {
    if (active.matches.length < 2) return null;
    const step = backwards ? -1 : 1;
    const count = active.matches.length;
    const index = (active.index + step + count) % count;
    const name = active.matches[index];
    return { completion: { ...active, index }, text: active.prefix + name + active.suffix, caret: active.prefix.length + name.length };
  }
  if (backwards) return null;

  const before = draft.slice(0, caret);
  const partial = before.match(/\S+$/)?.[0] ?? "";
  if (!partial) return null;
  const lower = partial.toLowerCase();
  const matches = nicknames
    .filter((name) => name.toLowerCase().startsWith(lower))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  // Somebody was being named, and nobody here is called that: a typo, or a
  // player who has left. The writer is mid-word and about to correct it.
  if (matches.length === 0) return { completion: null, text: draft, caret };
  // Typed out in full already: completing it would change nothing, and
  // swallowing the key for that would trap focus all over again.
  if (matches.length === 1 && matches[0] === partial) return null;

  const prefix = before.slice(0, before.length - partial.length);
  const suffix = draft.slice(caret);
  return { completion: { prefix, suffix, matches, index: 0 }, text: prefix + matches[0] + suffix, caret: prefix.length + matches[0].length };
}
