// What the join dialog is showing, decided away from React.
//
// A pure function over `JoinState` for two reasons. It is the part worth
// testing -- which states put a dialog on screen and which take it away -- and
// it is the part a test can reach: the dialog itself reads the store, and the
// store renders from its initial state under `jsdom`, so a test driving it
// through a join would be asserting against a snapshot that never moves.

import type { Game, GameLaunch, IceAdapter, JoinState, PreparationPhase } from "../../../ipc/bindings";
import type { LaunchContext } from "../../../shared/components/LaunchProgress";
import { splitGoAdapterTitle } from "../../../shared/goAdapterTitle";
import { adapterForGame } from "../../../shared/rules/iceAdapter";

export type JoinProgress =
  /** Patching, checksumming, downloading, staging a map: the slow part. */
  | { kind: "preparing"; phase: PreparationPhase; detail: string; progress: number | null }
  /**
   * The files are ready and the join request is out: the server has yet to
   * answer it with the launch order. Short, but it sits between the two
   * phases that show the dialog, and returning `null` here closed the dialog
   * and opened it again a moment later, its step log gone.
   */
  | { kind: "seating" }
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
    // A join is "joining" twice: the moment it is pressed, before the first
    // preparation step, and again once the files are ready and the request
    // has gone to the server. Neither is a reason to close the dialog.
    case "joining":
      return join.payload.prepared
        ? { kind: "seating" }
        : { kind: "preparing", phase: "asking", detail: "", progress: null };
    case "idle":
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
 * - `hostOnExpJava`, `expJavaAgainstHost`, `javaAgainstExpJavaHost`: the same
 *   three for the experimental Java adapter, which speaks WebRTC and so
 *   cannot reach a peer on the ordinary Java adapter either.
 */
export type AdapterNote =
  | "hostOnGo"
  | "goAgainstHost"
  | "javaAgainstHost"
  | "hostOnExpJava"
  | "expJavaAgainstHost"
  | "javaAgainstExpJavaHost";

/** The notes that only say what happens, rather than warn that it will fail. */
export const isInfoAdapterNote = (note: AdapterNote): boolean => note === "hostOnGo" || note === "hostOnExpJava";

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
  const mark = splitGoAdapterTitle(title);
  const joined = adapterForGame(adapter, title);
  if (joined === "go") return mark.goAdapter ? "hostOnGo" : "goAgainstHost";
  if (joined === "expJava") return mark.expJavaAdapter ? "hostOnExpJava" : "expJavaAgainstHost";
  if (mark.goAdapter) return "javaAgainstHost";
  return mark.expJavaAdapter ? "javaAgainstExpJavaHost" : null;
}

/**
 * What the head names: the launch order once there is one, otherwise the
 * lobby the last join was sent for.
 *
 * The map comes from the launch order only when it names one, which only a
 * matchmaker launch does: for a custom game or a hosted one `mapname` is
 * empty, the server having been told the map rather than telling it. The
 * head lost its map picture the moment the game started; it reads the
 * lobby's map then.
 */
export function contextOf(
  launch: GameLaunch | null,
  game: Game | null,
  mapLabel: (map: string) => string,
): LaunchContext | null {
  if (launch) {
    const map = launch.mapname || game?.map || "";
    return {
      name: splitGoAdapterTitle(launch.name || game?.title || "").title,
      mapName: map || null,
      detail: map ? mapLabel(map) : null,
    };
  }
  if (game) {
    return {
      name: splitGoAdapterTitle(game.title).title,
      mapName: game.map || null,
      detail: game.map ? mapLabel(game.map) : null,
    };
  }
  return null;
}
