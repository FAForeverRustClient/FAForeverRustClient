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

import { MIN_BROWSER_COLUMN_PX } from "./browsingPreferences";

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
      ? Math.max(MIN_BROWSER_COLUMN_PX, Math.round(saved))
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
function room(
  widths: readonly number[],
  index: number,
  flexible: number,
  grow: boolean,
  flexibleRoom: number,
): number {
  // The flexible column has no width of its own. It takes up whatever its
  // neighbour gives away, and gives up only what it has on screen above its
  // floor: past that the list used to grow instead, so the column beyond the
  // divider slid to the right while the divider stayed under the cursor. On a
  // small screen that happened almost at once, and the divider now stops.
  if (index === flexible) return grow ? Number.POSITIVE_INFINITY : flexibleRoom;
  // Growing is unbounded. A divider that stops while the cursor keeps going is
  // the complaint this answers, and there is nothing a wide column can break:
  // the two columns either side of a divider trade width, so the row's total
  // never changes however far one of them is dragged.
  return grow ? Number.POSITIVE_INFINITY : widths[index] - MIN_BROWSER_COLUMN_PX;
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
  flexibleRoom = Number.POSITIVE_INFINITY,
): number[] {
  const left = boundary - 1;
  const right = boundary;
  if (left < 0 || right >= widths.length) return [...widths];

  // How far the line may travel before one of its two columns hits a bound.
  // Dragging further than that has to stop rather than carry on changing one
  // side, or the two would drift apart and the line would leave the cursor.
  const forward = Math.min(
    room(widths, left, flexible, true, flexibleRoom),
    room(widths, right, flexible, false, flexibleRoom),
  );
  const back = Math.min(
    room(widths, left, flexible, false, flexibleRoom),
    room(widths, right, flexible, true, flexibleRoom),
  );
  const moved = Math.max(-back, Math.min(forward, Math.round(delta)));

  const next = [...widths];
  if (left !== flexible) next[left] = widths[left] + moved;
  if (right !== flexible) next[right] = widths[right] - moved;
  return next;
}

// ── Fitting a list to its space ────────────────────────────────────────────
//
// Every list with draggable columns is as wide as the space it has, and every
// column stays on screen (issue 341). The lists used to have a minimum width
// and scrolled sideways below it: shrinking the window took columns off the
// edge, and a divider next to the flexible column behaved differently there
// than on a large screen. Now:
//
// * Every column has a width of its own, the flexible one included. A list
//   wider than its columns gives what is left over to the flexible column.
// * A list narrower than its columns draws every column narrower in
//   proportion. The stored widths are untouched and come back on a wider
//   screen.
// * A divider trades width between its two neighbours and nothing else, at
//   any size, and stays under the pointer: at half scale a stored width moves
//   twice as far as the pointer did.

/** The smallest share a column is drawn at. Only a window a few dozen pixels wide gets there. */
const MIN_FIT_SCALE = 0.02;

/** What the columns are drawn at, from 1 (as dragged) down, to fit `space`. */
export function fitScale(space: number, widths: readonly number[]): number {
  if (space <= 0) return 1;
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (total <= 0) return 1;
  return Math.min(1, Math.max(MIN_FIT_SCALE, space / total));
}

/** The widths as drawn at `scale`. */
export function scaledWidths(widths: readonly number[], scale: number): number[] {
  return widths.map((width) => Math.max(1, Math.round(width * scale)));
}

/**
 * The widths after the divider in front of `boundary` has been dragged
 * `delta` stored pixels, positive being to the right, every column trading
 * as an equal: the one to the left grows by what the one to the right gives
 * up, and neither goes below `floorOf` its index.
 */
export function withBoundaryTraded(
  widths: readonly number[],
  boundary: number,
  delta: number,
  floorOf: (index: number) => number,
): number[] {
  const left = boundary - 1;
  const right = boundary;
  if (left < 0 || right >= widths.length) return [...widths];
  const forward = Math.max(0, widths[right] - floorOf(right));
  const back = Math.max(0, widths[left] - floorOf(left));
  const moved = Math.max(-back, Math.min(forward, Math.round(delta)));
  const next = [...widths];
  next[left] = widths[left] + moved;
  next[right] = widths[right] - moved;
  return next;
}

/**
 * The room a grid row has for its columns: its content width less the gaps
 * between them, read off the element so no list repeats its stylesheet here.
 */
export function gridColumnSpace(row: HTMLElement, columns: number): number {
  const style = getComputedStyle(row);
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const gap = parseFloat(style.columnGap) || 0;
  return row.clientWidth - padding - gap * (columns - 1);
}

/**
 * The drawn width of column `index`, measured from one of its header row's
 * dividers. Every list draws its dividers inside its header cells, one cell
 * per column, so the column's cell is the header row's child marked with that
 * index, or, in a list that keeps its cells in designed order, the child at
 * that index.
 */
export function drawnColumnWidth(handle: HTMLElement, index: number): number | null {
  const row = handle.parentElement?.parentElement;
  // A table draws its cells in the stored order and marks each with the
  // designed column it is (`data-column`); a grid list keeps them in designed
  // order. See `designedCells` in `useColumnOrder`.
  const cell = row?.querySelector(`:scope > [data-column="${index}"]`) ?? row?.children[index];
  return cell ? Math.round(cell.getBoundingClientRect().width) : null;
}
