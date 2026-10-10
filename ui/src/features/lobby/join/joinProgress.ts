// What the join dialog is showing, decided away from React.
//
// A pure function over `JoinState` for two reasons. It is the part worth
// testing -- which states put a dialog on screen and which take it away -- and
// it is the part a test can reach: the dialog itself reads the store, and the
// store renders from its initial state under `jsdom`, so a test driving it
// through a join would be asserting against a snapshot that never moves.

import type { IceAdapter, JoinState, PreparationPhase } from "../../../ipc/bindings";
import { splitGoAdapterTitle } from "../../../shared/goAdapterTitle";
import { adapterForGame } from "../../../shared/rules/iceAdapter";

export type JoinProgress =
  /** Patching, checksumming, downloading, staging a map: the slow part. */
  | { kind: "preparing"; phase: PreparationPhase; detail: string; progress: number | null }
  /**
   * The launch order is accepted and Forged Alliance is coming up.
   *
   * Nothing measurable happens here -- the client has handed off to a process
   * that takes its time opening a window -- which is exactly why it needs to
   * stay on screen. This used to be the moment the dialog closed, leaving one
   * line at the bottom of the window reading "Initiating" while the screen sat
   * still, and the report was that the client looked like it had given up.
   */
  | { kind: "starting"; name: string };

/**
 * What to show for a join state, or `null` for the states that show nothing.
 *
 * `inGame` is `null` because the game window is now the thing to look at, and
 * a dialog over it would be in the way of the one that matters. A failure is
 * `null` because it is retained by the notification centre, where it can be
 * read and dismissed rather than covering the window until somebody clicks.
 */
export function joinProgressOf(join: JoinState): JoinProgress | null {
  switch (join.type) {
    case "preparing":
      return {
        kind: "preparing",
        phase: join.payload.phase,
        detail: join.payload.detail,
        progress: join.payload.progress === null
          ? null
          : Math.min(100, Math.max(0, join.payload.progress)),
      };
    case "launched":
      return { kind: "starting", name: join.payload.launch.name };
    case "idle":
    case "joining":
    case "inGame":
    case "failed":
    case "launchFailed":
    case "needsModReplacement":
      return null;
  }
}

/**
 * The line to append to the step log, or `null` when there is nothing new.
 *
 * The backend repeats a step with a fresh percentage, which is one step and
 * not a hundred, so a repeat of the last line is dropped.
 */
export function nextStep(steps: readonly string[], line: string): string | null {
  if (line === "" || steps[steps.length - 1] === line) return null;
  return line;
}

/**
 * Why the game is worth a line about its ICE adapter.
 *
 * - `hostOnGo`: the game is hosted on Go and this join goes along, whether
 *   `dynamic` followed the title or the setting already said Go.
 * - `goAgainstHost`: the setting forces Go on a game whose title does not mark
 *   it as hosted on Go.
 * - `javaAgainstHost`: the setting forces Java on a game hosted on Go.
 */
export type AdapterNote = "hostOnGo" | "goAgainstHost" | "javaAgainstHost";

/**
 * The adapter line for a game with this title, or `null` for the usual case.
 *
 * The usual case is Java on a game that is not marked as hosted on Go, which is
 * nearly every game. It gets no line: one on every join is a line people stop
 * reading, and then the join where it says Go goes unread too. What is left is
 * the case the issue asked about, a game that runs on the other adapter, and
 * the two where the setting and the host disagree, which do not connect at all.
 *
 * Reads the host from the title mark, as the backend does. A game this client
 * hosts reads the same way, because hosting on Go marks the title. What this
 * cannot see is that a game is hosted here: the backend remembers that outside
 * the state (`hosted_title`) and starts such a game on the hosting setting. So
 * with the joining setting forced to one adapter and the hosting setting on
 * the other, the line for a game you host describes the joining setting.
 */
export function adapterNoteOf(adapter: IceAdapter, title: string): AdapterNote | null {
  const hostOnGo = splitGoAdapterTitle(title).goAdapter;
  if (adapterForGame(adapter, title) === "go") return hostOnGo ? "hostOnGo" : "goAgainstHost";
  return hostOnGo ? "javaAgainstHost" : null;
}
