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

/** One simulation mod a join would have to fetch. */
export interface MissingMod {
  /** As the lobby server spells it, which is what the vault matches on. */
  uid: string;
  /** What to put in front of a person. Falls back to the uid. */
  name: string;
}

/** A join the user has not confirmed yet. */
export interface PendingJoin {
  id: number;
  title: string;
  password: string | null;
  /** The simulation mods that are not on disk yet. */
  missingMods: MissingMod[];
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
export function missingSimMods(game: Game, installed: InstalledMod[]): MissingMod[] {
  const have = new Set(installed.map((mod) => mod.uid.toLocaleLowerCase()));
  return Object.entries(game.simMods)
    .filter(([uid]) => !have.has(uid.toLocaleLowerCase()))
    .map(([uid, name]) => ({ uid, name: name || uid }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The archive sizes of those mods, and whether that is the whole story.
 *
 * `bytes` is the sum of what is known, `unknown` how many of them nothing came
 * back for. Both matter: a total that silently omits three mods is worse than
 * no total, so the dialog says "at least" when `unknown` is not zero and says
 * nothing at all when it has no numbers whatsoever.
 */
export function missingModsSize(
  missing: MissingMod[],
  sizes: Record<string, number>,
): { bytes: number; unknown: number } {
  let bytes = 0;
  let unknown = 0;
  for (const mod of missing) {
    const size = sizes[mod.uid];
    if (size === undefined) unknown += 1;
    else bytes += size;
  }
  return { bytes, unknown };
}
