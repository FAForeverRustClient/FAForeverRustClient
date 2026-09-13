// How a list shares out the width it has, and what one divider drag does to it.
//
// Four lists have draggable columns now: the game browser, the co-op board,
// the replay vault and the live replays. They had three answers to the same
// two questions between them, which is how the same five columns ended up
// laid out one way in one tab and another way in the next.
//
// The answers, once:
//
// * One column is the flexible one and has no width of its own. It is the
//   column whose content is a name, because a name is the thing that gets cut
//   off, and it takes whatever the window has left over. Nothing is left over
//   in an empty track at the end: a list that stops a third of the way across
//   a wide window looks broken, and it was reported as "shrunk".
//
// * A divider trades width between the two columns it separates. The column
//   to its left grows by exactly what the column to its right gives up, so the
//   totals never change, so the flexible column never moves and neither does
//   any other divider. The line under the cursor is the only thing that moves,
//   which is the whole of what a divider is for.
//
// The alternative -- resizing one column and letting the flexible one absorb
// it -- is what this replaced. With the flexible column at the front it moved
// every divider except the one being dragged; with it at the back it moved
// every divider to the right of the cursor. Both read as the list fighting
// back.

import { MAX_BROWSER_COLUMN_PX, MIN_BROWSER_COLUMN_PX } from "./browsingPreferences";

/**
 * The stored widths, padded and bounded into a usable set.
 *
 * A stored array can be short (a release that had fewer columns), long (one
 * that had more), or empty (nobody has ever dragged anything). All three mean
 * "use the designed width for the columns you do not know about", which is why
 * this pads rather than rejects.
 */
export function resolveColumnWidths(
  stored: readonly number[] | undefined,
  defaults: readonly number[],
): number[] {
  return defaults.map((fallback, index) => {
    const saved = stored?.[index];
    return saved && saved > 0
      ? Math.min(MAX_BROWSER_COLUMN_PX, Math.max(MIN_BROWSER_COLUMN_PX, Math.round(saved)))
      : fallback;
  });
}

/**
 * The CSS `grid-template-columns` for a set of widths.
 *
 * Every column is the width it was given except the flexible one, which is
 * whatever is left of the row after the others have taken theirs.
 */
export function columnTemplate(widths: readonly number[], flexible: number): string {
  return widths
    .map((width, index) => (index === flexible ? "minmax(0, 1fr)" : `${width}px`))
    .join(" ");
}

/**
 * How wide a table has to be before its columns start being squeezed.
 *
 * `table-layout: fixed` honours a colgroup's widths only while they fit: once
 * they add up to more than the table is allowed to be, the browser scales them
 * all back down and a drag past that point does nothing at all. So the minimum
 * follows the widths, and widening a column widens the table inside its own
 * scroller. The flexible column's stored width is its floor here; it has no
 * width of its own on screen.
 */
export function tableMinWidth(widths: readonly number[]): number {
  return widths.reduce((total, width) => total + width, 0);
}

/** How much a column may still give up (`grow: false`) or take on. */
function room(widths: readonly number[], index: number, flexible: number, grow: boolean): number {
  // The flexible column has no width of its own, so it never limits a drag:
  // it simply takes up what its neighbour gives away.
  if (index === flexible) return Number.POSITIVE_INFINITY;
  return grow ? MAX_BROWSER_COLUMN_PX - widths[index] : widths[index] - MIN_BROWSER_COLUMN_PX;
}

/**
 * The widths after the divider in front of `boundary` has been dragged
 * `delta` pixels, positive being to the right.
 *
 * The column to the left of the line grows and the one to the right gives up
 * the same amount, so the line lands under the cursor and nothing else on the
 * row moves. Either side may be the flexible column, which is skipped: the
 * arithmetic still works, because what one side gives up the flexible column
 * takes on.
 */
export function withBoundaryDragged(
  widths: readonly number[],
  boundary: number,
  delta: number,
  flexible: number,
): number[] {
  const left = boundary - 1;
  const right = boundary;
  if (left < 0 || right >= widths.length) return [...widths];

  // How far the line may travel before one of its two columns hits a bound.
  // Dragging further than that has to stop rather than carry on changing one
  // side, or the two would drift apart and the line would leave the cursor.
  const forward = Math.min(room(widths, left, flexible, true), room(widths, right, flexible, false));
  const back = Math.min(room(widths, left, flexible, false), room(widths, right, flexible, true));
  const moved = Math.max(-back, Math.min(forward, Math.round(delta)));

  const next = [...widths];
  if (left !== flexible) next[left] = widths[left] + moved;
  if (right !== flexible) next[right] = widths[right] - moved;
  return next;
}
