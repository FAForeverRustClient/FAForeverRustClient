// Unsent lines, one per conversation, for the rest of the session.
//
// The composer used to hold its text in component state and clear it on every
// channel switch, so a half-written answer was lost to a glance at another
// tab, and leaving the Chat page unmounted the composer and took the text with
// it. A draft is a UI convenience rather than application state: the backend
// never needs to know about it, and nothing should survive a restart. So it
// lives here, at module level, which outlasts any one mount of the composer.
//
// Keyed by conversation rather than by surface: the Chat tab keys a draft on
// the channel or private conversation name, and the matchmaker's party chat
// uses a key of its own (see `partyDraftKey`), so the same room open in both
// places keeps two separate lines.

const drafts = new Map<string, string>();

/** The draft key for the party chat panel, kept apart from the Chat tab's. */
export function partyDraftKey(room: string): string {
  // IRC forbids `:` in a nickname, so this can never collide with a private
  // conversation's key, and a channel key always starts with `#`.
  return `party:${room}`;
}

export function readDraft(key: string): string {
  return drafts.get(key) ?? "";
}

/** Record the line for `key`; an empty line forgets the entry. */
export function writeDraft(key: string, text: string): void {
  if (text === "") drafts.delete(key);
  else drafts.set(key, text);
}
