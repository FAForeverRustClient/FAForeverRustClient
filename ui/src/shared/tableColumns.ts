// How a list shares out the width it has, and what one divider drag does to it.
//
// Five lists have draggable columns now: the game browser (and the co-op
// board, which draws the same header), the replay vault, the live replays and
// the matchmaker's recent results. They had three answers to the same two
// questions between them, which is how the same five columns ended up laid
// out one way in one tab and another way in the next.
//
// The answers, once:
//
// * One column is the flexible one. It is the column whose content is a name,
//   because a name is the thing that gets cut off, and it takes whatever the
//   window has left over on top of its own width. Nothing is left over in an
//   empty track at the end: a list that stops a third of the way across a
//   wide window looks broken, and it was reported as "shrunk".
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
 * whatever is left of the row after the others have taken theirs, and never
 * less than `flexibleMin`. Give it the flexible column's floor: when every
 * column is at its floor and the row is still too narrow, a `1fr` with no
 * minimum would be squeezed to nothing while the others spill past the edge.
 */
export function columnTemplate(widths: readonly number[], flexible: number, flexibleMin = 0): string {
  const flexibleTrack = `minmax(${flexibleMin > 0 ? `${flexibleMin}px` : 0}, 1fr)`;
  return widths
    .map((width, index) => (index === flexible ? flexibleTrack : `${width}px`))
    .join(" ");
}

// ── Fitting a list to its space ────────────────────────────────────────────
//
// Every list with draggable columns is as wide as the space it has (issue 341).
// The lists used to have a minimum width and scrolled sideways below it:
// shrinking the window took columns off the edge, and a divider next to the
// flexible column behaved differently there than on a large screen. Then they
// drew every column narrower in proportion, all the way down, and a column of
// buttons was squeezed until its buttons hung out of the list: the matchmaker's
// replay button sat outside its card at 1280 pixels with the party chat open.
// Now:
//
// * Every column has a width of its own, the flexible one included, and a
//   floor: the narrowest it is ever drawn. A column of controls has the room
//   its controls need, a column of text the width below which it stops being
//   readable, anything else a pixel.
// * A list wider than its columns gives what is left over to the flexible
//   column, and a list a little narrower takes it back from there first: no
//   other column narrows while the flexible one is wider than its own width.
// * Narrower still, every column above its floor is drawn narrower in
//   proportion and stops at its floor. The stored widths are untouched and
//   come back on a wider screen.
// * Only when every column is at its floor does the list stop fitting. It is
//   then as wide as its floors and scrolls sideways inside its own scroller.
//   Squeezing on, or letting the end of the row fall off the edge, is what hid
//   the replay button; a scrollbar keeps every control on the page.
// * A divider trades width between its two neighbours and nothing else, at
//   any size, and stays under the pointer: at half scale a stored width moves
//   twice as far as the pointer did.

/** Where a set of columns lands in the space it has. */
export interface ColumnFit {
  /** Each column's width on screen. The flexible column takes the rest of the row besides. */
  drawn: number[];
  /**
   * The share of its stored width every column above its floor is drawn at:
   * 1 while the columns fit. A divider converts the pointer's distance with it.
   */
  scale: number;
  /** The drawn widths together. More than the space only when `overflow` is set. */
  total: number;
  /**
   * Every column is at its floor and the floors take all of the space or more:
   * the list is made as wide as `total` and scrolls if that is wider than it.
   * Exactly full counts, so a table measured with that width set reads the
   * same answer again rather than letting go of it and growing back.
   */
  overflow: boolean;
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/**
 * The columns fitted into `space` pixels, each at least its floor.
 *
 * The flexible column gives up its slack first, because the slack is all it
 * is: whatever the row had left after every column took its width. Below
 * that every column shrinks in proportion, the flexible one included, rather
 * than the flexible column going all the way down to its floor before any
 * other moves. Pinned at its floor, it would be drawn at a width no stored
 * number describes, so the divider beside it could not move it without
 * moving every other column too. In proportion, every column on screen is its
 * stored width times one scale, and a trade between two of them keeps the
 * scale and leaves the rest where they are. A list that wants its flexible
 * column to keep more of itself gives it a larger designed width.
 */
export function fitColumns(
  widths: readonly number[],
  floors: readonly number[],
  space: number,
): ColumnFit {
  const floorOf = (index: number) => Math.max(MIN_BROWSER_COLUMN_PX, floors[index] ?? MIN_BROWSER_COLUMN_PX);
  const natural = widths.map((width, index) => Math.max(floorOf(index), width));
  const naturalTotal = sum(natural);
  // Not measured yet.
  if (space <= 0) return { drawn: natural, scale: 1, total: naturalTotal, overflow: false };
  const floorDrawn = widths.map((_, index) => floorOf(index));
  const floorTotal = sum(floorDrawn);
  if (floorTotal >= space) {
    // Every column at its floor. The scale is one at which every column is,
    // so a divider dragged here has nothing to take from either side.
    const scale = Math.min(1, ...widths.map((width, index) => floorOf(index) / Math.max(width, 1)));
    return { drawn: floorDrawn, scale, total: floorTotal, overflow: true };
  }
  // Room for every column as dragged.
  if (naturalTotal <= space) return { drawn: natural, scale: 1, total: naturalTotal, overflow: false };
  // One scale for every column above its floor. A column the scale would take
  // below its floor is held there, and the others share what is left, until
  // nothing new reaches a floor. At least one column always stays above its
  // floor here, because the floors together fit.
  const held = widths.map(() => false);
  let scale = 1;
  for (;;) {
    let fixed = 0;
    let free = 0;
    widths.forEach((width, index) => {
      if (held[index]) fixed += floorOf(index);
      else free += width;
    });
    scale = (space - fixed) / free;
    let changed = false;
    widths.forEach((width, index) => {
      if (!held[index] && width * scale < floorOf(index)) {
        held[index] = true;
        changed = true;
      }
    });
    if (!changed) break;
  }
  // Rounded down, so the columns never add up to more than the space and the
  // flexible column, which takes the rest, is never squeezed under its floor.
  const drawn = widths.map((width, index) =>
    held[index] ? floorOf(index) : Math.max(floorOf(index), Math.floor(width * scale)),
  );
  return { drawn, scale, total: sum(drawn), overflow: false };
}

/**
 * The widths after the divider in front of `boundary` has been dragged
 * `delta` stored pixels, positive being to the right, every column trading
 * as an equal: the one to the left grows by what the one to the right gives
 * up, and neither goes below `floorOf` its index, in stored pixels.
 *
 * A column whose stored width is under its floor is drawn at its floor, and
 * starts from there: it is lifted to its floor first, which changes nothing on
 * screen, so the divider moves from the first pixel instead of sitting still
 * until the stored width has caught up with what is drawn.
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
  const leftFrom = Math.max(widths[left], Math.ceil(floorOf(left)));
  const rightFrom = Math.max(widths[right], Math.ceil(floorOf(right)));
  const forward = Math.max(0, Math.floor(rightFrom - floorOf(right)));
  const back = Math.max(0, Math.floor(leftFrom - floorOf(left)));
  const moved = Math.max(-back, Math.min(forward, Math.round(delta)));
  const next = [...widths];
  next[left] = leftFrom + moved;
  next[right] = rightFrom - moved;
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
