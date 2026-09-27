// How wide the game list's columns and the detail panel beside them are.
//
// The tiles could already be made narrower or wider (`gameTileColumns`); the
// list's columns and the panel next to them could not, so the only way to read
// a long lobby title was to hope. Both are arithmetic rather than rendering,
// so both live here with the bounds the backend enforces anyway. What a
// divider drag does to a set of widths is the same question every other list
// in the client asks, so the answer lives in `shared/tableColumns`.

import {
  MAX_BROWSER_COLUMNS,
  MAX_DETAIL_PX,
  MIN_DETAIL_PX,
} from "../../../shared/browsingPreferences";
import {
  columnTemplate as templateFor,
  resolveColumnWidths,
  withBoundaryDragged,
} from "../../../shared/tableColumns";

/**
 * The designed widths, in the order the header lists them: game, tags, map,
 * players, rating, age.
 */
export const DEFAULT_COLUMN_WIDTHS: readonly number[] = [320, 190, 170, 80, 100, 75];

/** How many columns the list had before the tags got one of their own. */
const COLUMNS_BEFORE_TAGS = 5;

/**
 * The game column, which is the flexible one.
 *
 * It is the title, the host and the tags, so it is what a wide window should
 * be spent on and what a narrow one has to give up first. Its stored width is
 * kept -- a settings file written by an older release still means the same
 * thing position by position -- but nothing reads it any more: the column is
 * whatever the row has left after the other four.
 */
export const FLEXIBLE_COLUMN = 0;

/** The gap between two columns, matching `.game-browser-row`. */
const COLUMN_GAP_PX = 16;
/** A row's own padding either side, matching `.game-browser-row`. */
const ROW_PADDING_PX = 16;
/** The narrowest the game column can be dragged: a thumbnail and a word. */
export const MIN_GAME_COLUMN_PX = 120;
/** The smallest share a column is drawn at: only a window a few dozen pixels wide gets there. */
const MIN_COLUMN_SCALE = 0.02;

/**
 * What the columns are drawn at, from 1 (as dragged) down, so that the row
 * fits a list `listWidth` wide.
 *
 * The list is always as wide as the space it has (issue 341). Forced wider,
 * it scrolled sideways on a smaller screen and was far wider than anything in
 * it; left to squeeze one column, that column went first and then everything
 * spilled. So a list narrower than the columns together draws every column
 * narrower in proportion, the game column included, and the widths stored are
 * untouched: on a wider screen they come back exactly. A list wider than the
 * columns gives what is left over to the game column.
 */
export function columnScale(listWidth: number, widths: readonly number[]): number {
  if (listWidth <= 0) return 1;
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (total <= 0) return 1;
  const usable = listWidth - 2 * ROW_PADDING_PX - COLUMN_GAP_PX * (widths.length - 1);
  return Math.min(1, Math.max(MIN_COLUMN_SCALE, usable / total));
}

/** The widths as drawn at `scale`. */
export function scaledColumnWidths(widths: readonly number[], scale: number): number[] {
  return widths.map((width) => Math.max(1, Math.round(width * scale)));
}

/** The detail panel's designed width, matching `custom-games.css`. */
export const DEFAULT_DETAIL_WIDTH = 270;

/**
 * Saved widths, padded and bounded into a usable set of six.
 *
 * A set of exactly five was saved before the tags column existed, when the
 * second width was the map's. It is read that way, with the tags column at
 * its designed width (a zero), so nobody's map column turns into a tags
 * column of the same width. Every set saved since is six long.
 */
export function columnWidths(stored: readonly number[] | undefined): number[] {
  const upgraded = stored?.length === COLUMNS_BEFORE_TAGS
    ? [stored[0], 0, ...stored.slice(1)]
    : stored;
  return resolveColumnWidths(upgraded, DEFAULT_COLUMN_WIDTHS).slice(0, MAX_BROWSER_COLUMNS);
}

/** For `withBoundaryDragged`: every column of the game list has a width of its own. */
const NO_FLEXIBLE_COLUMN = -1;

/**
 * The widths after the divider in front of `boundary` has been dragged.
 *
 * Pair-wise, so the line lands under the cursor: what the column on the right
 * gives up the column on the left takes on. Resizing one column on its own
 * and letting the game column absorb it is what this replaced, and it meant
 * grabbing the divider between Map and Players moved the divider between Game
 * and Map while the one under the cursor stayed put.
 */
export function withColumnResized(
  widths: readonly number[],
  boundary: number,
  delta: number,
): number[] {
  // The game column trades width like any other now: it has a width of its
  // own, so the divider in front of the tags column moves both of its
  // neighbours and nothing else, on any screen. It stops at a readable floor.
  const gameGives = boundary === FLEXIBLE_COLUMN + 1 && delta < 0;
  const bounded = gameGives
    ? Math.max(delta, Math.min(0, MIN_GAME_COLUMN_PX - widths[FLEXIBLE_COLUMN]))
    : delta;
  return withBoundaryDragged(widths, boundary, bounded, NO_FLEXIBLE_COLUMN);
}

/**
 * The CSS `grid-template-columns` for a set of widths.
 *
 * Four columns at the width they were given and the game column taking the
 * rest. The slack had a track of its own for one release, which kept the
 * columns off the far edge of a wide window but left the list stopping a
 * third of the way across it with nothing after it. A title that could have
 * used those pixels was being cut off at the same time.
 */
export function columnTemplate(widths: readonly number[]): string {
  return templateFor(widths, FLEXIBLE_COLUMN);
}

/** The detail panel's width after a drag, bounded the way the backend bounds it. */
export function withDetailResized(width: number, delta: number): number {
  // The handle sits on the panel's left edge, so dragging left (a negative
  // delta) makes the panel wider.
  return Math.min(MAX_DETAIL_PX, Math.max(MIN_DETAIL_PX, Math.round(width - delta)));
}

/** The stored detail width, or the designed one when nothing is stored. */
export function detailWidth(stored: number | undefined): number {
  return stored && stored > 0
    ? Math.min(MAX_DETAIL_PX, Math.max(MIN_DETAIL_PX, stored))
    : DEFAULT_DETAIL_WIDTH;
}
