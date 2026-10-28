// "You are still searching for a match. Stop searching and join?"
//
// Joining a custom lobby left the matchmaker search running (#650): the
// player sat in a lobby while the queue could still match them, and a match
// found then would pull them out of the lobby they had just chosen. So a join
// asked for during a search stops here first and the player decides: stop the
// search and join, or stay in the queue and do not join.
//
// Held in a module-level store for the same reason `joinConfirmation.ts` is:
// nothing has been sent, the backend has no opinion about an unanswered
// question, and a reload should forget it.

import type { MatchmakingState } from "../ipc/bindings";
import { ipc } from "../ipc/client";

/** A join that waits for the player to give up their search. */
export interface PendingSearchJoin {
  id: number;
  /** The lobby's title, to name it in the question. Empty when unknown. */
  title: string;
  password: string | null;
  /** The queues the search is running in, which stopping it leaves. */
  queueNames: string[];
}

let pending: PendingSearchJoin | null = null;
const listeners = new Set<() => void>();

export function subscribeSearchJoin(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function searchJoinSnapshot(): PendingSearchJoin | null {
  return pending;
}

export function setSearchJoin(next: PendingSearchJoin | null) {
  pending = next;
  for (const listener of listeners) listener();
}

/**
 * The queues a search is running in, or none.
 *
 * `preparing` counts: the client is already in the queue while it checks the
 * game files, and a match can be found in that time. A match already found
 * or launching does not: that game is starting, and the matchmaker panel
 * handles it.
 */
export function activeSearchQueues(state: MatchmakingState): string[] {
  return state.type === "searching" || state.type === "preparing" ? state.payload.queueNames : [];
}

/** Leave every queue the search is running in. */
export function stopSearching(queueNames: readonly string[]) {
  for (const queueName of queueNames) {
    void ipc.send({ kind: "Lobby", command: { type: "matchmake", payload: { queueName, start: false } } });
  }
}
