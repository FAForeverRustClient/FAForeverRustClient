// The join that is waiting for an answer, and the question it is waiting on.
//
// Joining a lobby used to fetch whatever that lobby required the moment you
// double-clicked it. Double-clicking the wrong row therefore left twenty
// simulation mods on disk, which is what was reported: people wanted to be in
// the driver's seat. So a join that would download something new stops here
// first.
//
// Held in a module-level store rather than in `AppState`, and that is a
// deliberate line. The pending question is not something the backend has an
// opinion about: nothing has been sent, nothing is running, and a reload
// forgets it, which is the correct behaviour for an unanswered prompt. The
// lobby's game tooltip already uses the same shape (`setGlobalLineup`), and
// the password on a join request is already kept in the renderer for the same
// reason.

import type { Game, InstalledMod } from "../../ipc/bindings";

/** A join the user has not confirmed yet. */
export interface PendingJoin {
  id: number;
  title: string;
  password: string | null;
  /** Display names of the simulation mods that are not on disk yet. */
  missingMods: string[];
}

let pending: PendingJoin | null = null;
const listeners = new Set<() => void>();

export function subscribePendingJoin(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pendingJoinSnapshot(): PendingJoin | null {
  return pending;
}

export function setPendingJoin(next: PendingJoin | null) {
  pending = next;
  for (const listener of listeners) listener();
}

/**
 * The simulation mods this lobby needs that are not installed.
 *
 * Matched on uid, lowercased, the way every other mod lookup in the client
 * matches: `game.simMods` is keyed by uid and the installed list carries the
 * same value from `mod_info.lua`. The map's *values* are the display names the
 * lobby server sent, which is what the dialog lists, because a uid tells a
 * reader nothing.
 *
 * An empty result means the join costs no download and never raises a prompt,
 * whatever the setting says. That is the case that keeps this out of the way
 * of the people who play the same three modded lobbies every evening.
 */
export function missingSimMods(game: Game, installed: InstalledMod[]): string[] {
  const have = new Set(installed.map((mod) => mod.uid.toLocaleLowerCase()));
  return Object.entries(game.simMods)
    .filter(([uid]) => !have.has(uid.toLocaleLowerCase()))
    .map(([uid, name]) => name || uid)
    .sort((left, right) => left.localeCompare(right));
}
