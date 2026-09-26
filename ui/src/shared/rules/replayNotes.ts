// Private comments and tags on replays (#324).
//
// The twin of `normalized_replay_notes` in
// crates/faf-domain/src/state/settings.rs, plus the two questions the UI asks
// of the list: what is written on this replay, and does it match a search.

import type { ReplayNote } from "../../ipc/bindings";

export const REPLAY_NOTE_CHARACTER_LIMIT = 500;
export const REPLAY_TAG_CHARACTER_LIMIT = 32;
export const REPLAY_TAGS_PER_REPLAY = 10;
const REPLAY_NOTE_LIMIT = 5_000;

function tidyTag(tag: string): string {
  return Array.from(tag.split(/\s+/).filter(Boolean).join(" "))
    .slice(0, REPLAY_TAG_CHARACTER_LIMIT)
    .join("")
    .trim();
}

/** Mirror the Rust normalization applied when a social-settings event lands. */
export function normalizeReplayNotes(notes: readonly ReplayNote[]): ReplayNote[] {
  const byId = new Map<number, ReplayNote>();
  for (const entry of notes) {
    if (entry.replayId <= 0) continue;
    const comment = Array.from(entry.comment.trim()).slice(0, REPLAY_NOTE_CHARACTER_LIMIT).join("");
    const tags: string[] = [];
    for (const raw of entry.tags) {
      const tag = tidyTag(raw);
      if (!tag || tags.some((known) => known.toLowerCase() === tag.toLowerCase())) continue;
      tags.push(tag);
      if (tags.length === REPLAY_TAGS_PER_REPLAY) break;
    }
    if (!comment && tags.length === 0) {
      byId.delete(entry.replayId);
      continue;
    }
    byId.set(entry.replayId, { replayId: entry.replayId, comment, tags });
  }
  return [...byId.values()]
    .sort((left, right) => left.replayId - right.replayId)
    .slice(0, REPLAY_NOTE_LIMIT);
}

export function noteForReplay(notes: readonly ReplayNote[], replayId: number | null): ReplayNote | null {
  if (replayId === null || replayId <= 0) return null;
  return notes.find((entry) => entry.replayId === replayId) ?? null;
}

/** Tags typed as one comma-separated line. */
export function parseTagInput(value: string): string[] {
  return value.split(",").map(tidyTag).filter(Boolean);
}

/**
 * Whether a replay's note answers a search: every word of the query somewhere
 * in the comment or the tags, case-insensitively. An empty query matches all.
 */
export function replayNoteMatches(note: ReplayNote | null, query: string): boolean {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  if (!note) return false;
  const haystack = [note.comment, ...note.tags].join(" ").toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Every tag in use, each once however it is capitalised, sorted for a picker. */
export function allReplayTags(notes: readonly ReplayNote[]): string[] {
  const byKey = new Map<string, string>();
  for (const note of notes) {
    for (const tag of note.tags) {
      const key = tag.toLocaleLowerCase();
      if (!byKey.has(key)) byKey.set(key, tag);
    }
  }
  return [...byKey.values()].sort((left, right) => left.localeCompare(right));
}

/** Whether a note carries any of these tags, case-insensitively. */
export function hasAnyTag(note: ReplayNote | null, tags: readonly string[]): boolean {
  if (tags.length === 0) return true;
  if (!note) return false;
  const wanted = new Set(tags.map((tag) => tag.toLocaleLowerCase()));
  return note.tags.some((tag) => wanted.has(tag.toLocaleLowerCase()));
}

/**
 * The game ids carrying any of these tags, as the vault search takes them.
 *
 * This is how the Online tab filters by tag: the vault knows nothing of the
 * reader's tags, but it can be asked for exactly these games.
 */
export function replayIdsTagged(notes: readonly ReplayNote[], tags: readonly string[]): string[] {
  if (tags.length === 0) return [];
  return notes.filter((note) => hasAnyTag(note, tags)).map((note) => String(note.replayId));
}
