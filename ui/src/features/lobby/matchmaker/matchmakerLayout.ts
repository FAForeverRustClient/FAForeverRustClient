// How wide the matchmaker tab's party chat is.
//
// Arithmetic rather than rendering, so it sits beside `browserLayout.ts` and
// is tested the same way. The bounds are the ones the backend enforces anyway
// (`MIN_PARTY_CHAT_PX` / `MAX_PARTY_CHAT_PX` in `faf-domain`), because a width
// is stored and a stored number is a number a hand-edited settings file can
// make anything at all.

import { MAX_PARTY_CHAT_PX, MIN_PARTY_CHAT_PX } from "../../../shared/browsingPreferences";

/**
 * The rail's designed width.
 *
 * Wider than the 380px ceiling it had, which is the report: a chat line was
 * wrapping every few words in a tab that had room to spare. The queue grid on
 * the other side of the divider lays out in 300px tracks, so this is the width
 * that costs it nothing on a 1600px window and one track on a 1280px one.
 */
export const DEFAULT_PARTY_CHAT_WIDTH = 440;

/** The stored width, or the designed one when nothing is stored. */
export function partyChatWidth(stored: number | undefined): number {
  return stored && stored > 0
    ? Math.min(MAX_PARTY_CHAT_PX, Math.max(MIN_PARTY_CHAT_PX, stored))
    : DEFAULT_PARTY_CHAT_WIDTH;
}

/** The width after a drag, bounded the way the backend bounds it. */
export function withPartyChatResized(width: number, delta: number): number {
  // The handle is on the rail's left edge, so dragging left (a negative delta)
  // makes the rail wider. Same sign convention as the game browser's divider.
  return Math.min(MAX_PARTY_CHAT_PX, Math.max(MIN_PARTY_CHAT_PX, Math.round(width - delta)));
}
