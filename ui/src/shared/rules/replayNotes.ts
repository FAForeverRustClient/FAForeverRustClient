// Private comments and tags on replays (#324).
//
// The twin of `normalized_replay_notes` in
// crates/faf-domain/src/state/settings.rs, plus the two questions the UI asks
// of the list: what is written on this replay, and does it match a search.

import type { ReplayNote } from "../../ipc/bindings";
import { normalizeReplayPath } from "./replayReadKey";

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

/**
 * Order by Unicode code point, which is how Rust orders strings. JavaScript's
 * own comparison goes by UTF-16 unit, and the two disagree past the Basic
 * Multilingual Plane.
 */
function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = (a[index].codePointAt(0) ?? 0) - (b[index].codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/** Games first, by id, as notes have always been kept; then files, by path. */
function compareTargets(left: NoteTarget, right: NoteTarget): number {
  if (left.path !== null && right.path !== null) return compareCodePoints(left.path, right.path);
  if (left.path !== null) return 1;
  if (right.path !== null) return -1;
  return left.replayId - right.replayId;
}

/** Mirror the Rust normalization applied when a social-settings event lands. */
export function normalizeReplayNotes(notes: readonly ReplayNote[]): ReplayNote[] {
  const byTarget = new Map<string, { target: NoteTarget; note: ReplayNote }>();
  for (const entry of notes) {
    const target = noteTarget(entry.replayId, entry.path);
    if (!target) continue;
    const key = target.path === null ? `game:${target.replayId}` : `file:${target.path}`;
    const comment = Array.from(entry.comment.trim()).slice(0, REPLAY_NOTE_CHARACTER_LIMIT).join("");
    const tags: string[] = [];
    for (const raw of entry.tags) {
      const tag = tidyTag(raw);
      if (!tag || tags.some((known) => known.toLowerCase() === tag.toLowerCase())) continue;
      tags.push(tag);
      if (tags.length === REPLAY_TAGS_PER_REPLAY) break;
    }
    if (!comment && tags.length === 0) {
      byTarget.delete(key);
      continue;
    }
    byTarget.set(key, { target, note: { replayId: target.replayId, path: target.path, comment, tags } });
  }
  return [...byTarget.values()]
    .sort((left, right) => compareTargets(left.target, right.target))
    .slice(0, REPLAY_NOTE_LIMIT)
    .map(({ note }) => note);
}

/**
 * The note on one replay: on its game when it has an id, otherwise on its
 * file, however that file's path is spelt. Twin of
 * `SocialPreferences::replay_note_for`.
 *
 * Only the path asked about is normalised: the notes in the store already are
 * (see `normalizeReplayNotes`), and the local list asks this once per file it
 * filters, which is thousands of times per keystroke.
 */
export function noteForReplay(
  notes: readonly ReplayNote[],
  replayId: number | null,
  localPath?: string | null,
): ReplayNote | null {
  const wanted = noteTarget(replayId, localPath);
  if (!wanted) return null;
  return notes.find((entry) => wanted.path === null
    ? entry.replayId === wanted.replayId
    : entry.replayId <= 0 && entry.path === wanted.path) ?? null;
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
