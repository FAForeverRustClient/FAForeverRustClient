// How long a hover panel waits before it appears, and before it goes away.
//
// "Hover panel" is the detail overlay a list opens when the pointer rests on a
// row: the lineup on a game in the Play tab, the game card behind a nickname's
// crossed swords in chat, the rating card behind the nickname itself. They all
// used to open the instant the pointer touched anything, which is fine when you
// meant it and expensive when you did not: crossing the game list on the way
// somewhere else opened four or five of them, each one covering the row below
// the one you were aiming at.
//
// A fixed delay is not the answer either. A second was tried and drew the
// opposite complaint, because scanning a list one row at a time then waits a
// second per row. So: the delay is a preference, and it applies to the *first*
// panel only. Once one is open, or has just closed, the next opens at once, and
// a delay long enough to stop accidents does not also make browsing slow.
//
// Read through functions rather than a hook because two of the three callers
// are module-level stores outside the React tree.

import { useAppStore } from "../store/store";

/**
 * How long after the last panel closed the next one still opens at once.
 *
 * Long enough to cover moving from one row to the next, which is a close and an
 * open a few tens of milliseconds apart; short enough that coming back to the
 * list after reading something is a fresh hover and waits again.
 */
const WARM_WINDOW_MS = 500;

/** Which panels are open right now. Ids come from the caller's `useId`. */
const openPanels = new Set<string>();
let lastClosedAt = 0;

export function noteHoverPanelOpen(id: string): void {
  openPanels.add(id);
}

export function noteHoverPanelClosed(id: string): void {
  if (openPanels.delete(id)) lastClosedAt = Date.now();
}

/** Whether a panel is open, or one closed recently enough to still count. */
function hoverIsWarm(): boolean {
  return openPanels.size > 0 || Date.now() - lastClosedAt < WARM_WINDOW_MS;
}

function appearance() {
  return useAppStore.getState().state.settings.appearance;
}

/** Whether hover panels are shown at all. */
export function hoverPanelsEnabled(): boolean {
  return appearance().hoverPanels;
}

/**
 * The delay before a panel opens, in milliseconds.
 *
 * Zero while another panel is open or has just closed: see the note above.
 */
export function hoverOpenDelay(): number {
  return hoverIsWarm() ? 0 : appearance().hoverOpenDelayMs;
}

/** The delay before a panel closes once the pointer has left it. */
export function hoverCloseDelay(): number {
  return appearance().hoverCloseDelayMs;
}
