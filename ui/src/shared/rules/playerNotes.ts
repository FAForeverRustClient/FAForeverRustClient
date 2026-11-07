import type { PlayerNote } from "../../ipc/bindings";

export const PLAYER_NOTE_CHARACTER_LIMIT = 150;

/** Twin of `SocialPreferences::note_for`; order-independent by design. */
export function noteForPlayer(notes: readonly PlayerNote[], playerId: number): string {
  return notes.find((entry) => entry.playerId === playerId)?.note ?? "";
}
