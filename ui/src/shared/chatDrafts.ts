// Unsent lines, one per conversation, for the current account session.
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
// places keeps two separate lines. Tournament keys include the event and room.
// The application store clears these lines synchronously at account boundaries,
// including snapshot replacement while every chat view is unmounted.

const drafts = new Map<string, string>();
const listeners = new Set<() => void>();
let session = 0;

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function draftSession(): number {
  return session;
}

export function clearDrafts(): void {
  drafts.clear();
  session += 1;
  for (const listener of listeners) listener();
}

/** The draft key for the party chat panel, kept apart from the Chat tab's. */
export function partyDraftKey(room: string): string {
  // IRC forbids `:` in a nickname, so this can never collide with a private
  // conversation's key, and a channel key always starts with `#`.
  return `party:${room}`;
}

export function tournamentDraftKey(eventId: string, roomId: string): string {
  return `tournament:${JSON.stringify([eventId, roomId])}`;
}

export function readDraft(key: string): string {
  return drafts.get(key) ?? "";
}

/** Record the line for `key`; an empty line forgets the entry. */
export function writeDraft(key: string, text: string, owner = session): void {
  // A callback captured before logout must not repopulate the next session.
  if (owner !== session || readDraft(key) === text) return;
  if (text === "") drafts.delete(key);
  else drafts.set(key, text);
  for (const listener of listeners) listener();
}
