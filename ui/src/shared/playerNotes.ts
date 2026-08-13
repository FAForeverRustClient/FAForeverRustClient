import type { PlayerNote } from "../ipc/bindings";

export const PLAYER_NOTE_CHARACTER_LIMIT = 150;
const PLAYER_NOTE_LIMIT = 1_000;

/** Twin of `SocialPreferences::note_for`; order-independent by design. */
export function noteForPlayer(notes: readonly PlayerNote[], playerId: number): string {
  return notes.find((entry) => entry.playerId === playerId)?.note ?? "";
}

/** Mirror the Rust normalization applied when a social-settings event lands. */
export function normalizePlayerNotes(notes: readonly PlayerNote[]): PlayerNote[] {
  const byId = new Map<number, PlayerNote>();
  for (const entry of notes) {
    const login = entry.login.trim();
    const note = Array.from(entry.note.trim()).slice(0, PLAYER_NOTE_CHARACTER_LIMIT).join("");
    if (entry.playerId <= 0 || !login || Array.from(login).length > 64 || !note) continue;
    byId.set(entry.playerId, { playerId: entry.playerId, login, note });
  }
  return [...byId.values()]
    .sort((left, right) => left.playerId - right.playerId)
    .slice(0, PLAYER_NOTE_LIMIT);
}
