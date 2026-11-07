// Private comments and tags on replays (#324).
//
// Normalization is authoritative in Rust. These helpers look up the received
// notes and validate/filter local editor drafts without a round trip.

import type { ReplayNote } from "../../ipc/bindings";
import { normalizeReplayPath } from "./replayReadKey";

export const REPLAY_NOTE_CHARACTER_LIMIT = 500;
export const REPLAY_TAG_CHARACTER_LIMIT = 32;
export const REPLAY_TAGS_PER_REPLAY = 10;

function tidyTag(tag: string): string {
  return Array.from(tag.split(/\s+/).filter(Boolean).join(" "))
    .slice(0, REPLAY_TAG_CHARACTER_LIMIT)
    .join("")
    .trim();
}

/**
 * What a note is filed under, twin of `ReplayNoteKey` in the Rust settings
 * slice: its game, or for a replay without a game id, its file as
 * `normalizeReplayPath` spells it, with `replayId` 0.
 */
interface NoteTarget {
  replayId: number;
  path: string | null;
}

/** `null` for a replay with neither, which a note could never be found on again. */
function noteTarget(replayId: number | null, path: string | null | undefined): NoteTarget | null {
  if (replayId !== null && replayId > 0) return { replayId, path: null };
  return path ? { replayId: 0, path: normalizeReplayPath(path) } : null;
}

// Store updates replace the immutable array, so each revision gets its own index.
const noteIndexes = new WeakMap<readonly ReplayNote[], {
  games: Map<number, ReplayNote>;
  files: Map<string, ReplayNote>;
}>();

/**
 * The note on one replay: on its game when it has an id, otherwise on its
 * file, however that file's path is spelt. Twin of
 * `SocialPreferences::replay_note_for`.
 *
 * Only the path asked about is normalised: the notes in the store already are
 * (by the Rust settings reducer), and the local list asks this once per file it
 * filters, which is thousands of times per keystroke.
 */
export function noteForReplay(
  notes: readonly ReplayNote[],
  replayId: number | null,
  localPath?: string | null,
): ReplayNote | null {
  const wanted = noteTarget(replayId, localPath);
  if (!wanted) return null;
  let index = noteIndexes.get(notes);
  if (!index) {
    index = { games: new Map(), files: new Map() };
    for (const note of notes) {
      // Preserve find's first-match behavior, including callers with duplicates.
      if (note.replayId > 0) {
        if (!index.games.has(note.replayId)) index.games.set(note.replayId, note);
      } else if (note.path && !index.files.has(note.path)) {
        index.files.set(note.path, note);
      }
    }
    noteIndexes.set(notes, index);
  }
  return (wanted.path === null
    ? index.games.get(wanted.replayId)
    : index.files.get(wanted.path)) ?? null;
}

/** Distinct, tidied tags, without dropping overflow the editor must explain. */
export function parseTagInput(value: string): string[] {
  const tags: string[] = [];
  const known = new Set<string>();
  for (const raw of value.split(",")) {
    const tag = tidyTag(raw);
    const key = tag.toLowerCase();
    if (!tag || known.has(key)) continue;
    known.add(key);
    tags.push(tag);
  }
  return tags;
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
 * The notes on games, leaving out those on files without a game id: the
 * vault has none of those files, so the Online tab has nothing to find by
 * them.
 */
export function gameReplayNotes(notes: readonly ReplayNote[]): ReplayNote[] {
  return notes.filter((note) => note.replayId > 0);
}

/**
 * The game ids carrying any of these tags, as the vault search takes them.
 *
 * This is how the Online tab filters by tag: the vault knows nothing of the
 * reader's tags, but it can be asked for exactly these games. A note on a file
 * without a game id names no game, so it adds nothing here; asking the vault
 * for game 0 would find nothing anyway.
 */
export function replayIdsTagged(notes: readonly ReplayNote[], tags: readonly string[]): string[] {
  if (tags.length === 0) return [];
  return gameReplayNotes(notes).filter((note) => hasAnyTag(note, tags)).map((note) => String(note.replayId));
}
