// Opening the moderation report, with the game it is about when the place it
// was opened from knows one.
//
// The game ID is a convenience for the form, not state the backend keeps: the
// report is opened by `Reporting::open` and the form fills its game field from
// here once that has arrived. Held for exactly one opening, so a report opened
// later from the chat does not inherit the game of one opened from a replay.

import { ipc } from "../ipc/client";

let pendingGameId: number | null = null;

/** Open the report for `account`, naming `gameId` in its game field. */
export function openReport(account: { id: number; login: string }, gameId?: number): void {
  pendingGameId = gameId !== undefined && Number.isInteger(gameId) && gameId > 0 ? gameId : null;
  ipc.send({
    kind: "Reporting",
    command: { type: "open", payload: { playerId: account.id, login: account.login } },
  });
}

/** The game the report was opened for, once; null after that or for none. */
export function takeReportGameId(): number | null {
  const gameId = pendingGameId;
  pendingGameId = null;
  return gameId;
}
