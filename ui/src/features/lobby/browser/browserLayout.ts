// How wide the game list's columns and the detail panel beside them are.
//
// The tiles could already be made narrower or wider (`gameTileColumns`); the
// list's columns and the panel next to them could not, so the only way to read
// a long lobby title was to hope. Both are arithmetic rather than rendering,
// so both live here with the bounds the backend enforces anyway. What a
// divider drag does to a set of widths, and how a set is fitted to the space
// it has, is the same question every other list in the client asks, so the
// answer lives in `shared/tableColumns`.

import {
  MAX_BROWSER_COLUMNS,
  MAX_DETAIL_PX,
  MIN_DETAIL_PX,
} from "../../../shared/browsingPreferences";
import {
  columnTemplate as templateFor,
  resolveColumnWidths,
} from "../../../shared/tableColumns";

/**
 * The designed widths, in the order the header lists them: game, tags, map,
 * players, rating, age.
 *
 * Sized for the client's default 1100 by 720 window, where the list has about
 * 700 pixels for its columns: an ordinary lobby title and its host fit the
 * game column, a map name with its version fits the map column, and every
 * header label fits beside its sort arrow. The tags column gave up the most
 * for it: what does not fit there folds into a "+N more" chip anyway. The set
 * this replaced added up to 935 pixels, so at that size every column was drawn
 * at three quarters and titles, map names and three headings were cut off.
 */
export const DEFAULT_COLUMN_WIDTHS: readonly number[] = [254, 96, 150, 72, 80, 52];

/**
 * The narrowest each column is drawn, in the same order: a thumbnail and the
 * start of a title with its host under it, one tag, the start of a map name,
 * and the figures under Players, Rating and Age. Below these a column is not
 * worth having on screen, so a list that cannot fit them scrolls sideways
 * instead (see `fitColumns`). Together they fit the list beside the details
 * panel at the default window, with a game selected.
 */
export const COLUMN_FLOORS: readonly number[] = [160, 40, 96, 36, 36, 36];

/** How many columns the list had before the tags got one of their own. */
const COLUMNS_BEFORE_TAGS = 5;

/**
 * The game column, which is the flexible one.
 *
 * It is the title, the host and the tags, so it is what a wide window should
 * be spent on and what a narrow one takes from first. Its width is where that
 * stops: below it, every column narrows in proportion.
 */
export const FLEXIBLE_COLUMN = 0;

/** The gap between two columns, matching `.game-browser-row`. */
const COLUMN_GAP_PX = 16;
/**
 * The padding either side of the header and of every row, matching
 * `.game-browser-head` and `.game-browser-row`, which must agree with each
 * other or every cell sits off its divider. The live fitting reads it off the
 * header (`gridColumnSpace`); this is the same figure for the arithmetic done
 * before anything is laid out.
 */
export const ROW_PADDING_PX = 12;
/** The list panel's border and the room its vertical scrollbar takes. */
const LIST_FRAME_PX = 14;
/** The track the divider between the list and the details panel stands in. */
const DETAIL_GAP_PX = 12;

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

/**
 * The CSS `grid-template-columns` for a set of widths.
 *
 * Five columns at the width they were given and the game column taking the
 * rest, never less than its floor. The slack had a track of its own for one
 * release, which kept the columns off the far edge of a wide window but left
 * the list stopping a third of the way across it with nothing after it. A
 * title that could have used those pixels was being cut off at the same time.
 */
export function columnTemplate(widths: readonly number[], game = FLEXIBLE_COLUMN): string {
  return templateFor(widths, game, COLUMN_FLOORS[FLEXIBLE_COLUMN]);
}

/**
 * How wide the list has to be to draw `widths` without narrowing any of them:
 * the columns, the gaps between them and the frame around them.
 */
export function listWidthFor(widths: readonly number[]): number {
  const columns = widths.reduce(
    (total, width, index) => total + Math.max(COLUMN_FLOORS[index] ?? 0, width),
    0,
  );
  return columns + COLUMN_GAP_PX * (widths.length - 1) + 2 * ROW_PADDING_PX + LIST_FRAME_PX;
}

/**
 * Whether the details panel, with no game in it, steps aside for the list.
 *
 * Empty, the panel says "select a game" and nothing else, and at the default
 * window it took 270 pixels from a list that was cutting its titles and its
 * headings short for want of them. So an empty panel is drawn only where the
 * list beside it still has room for its columns as they are; anywhere
 * narrower the list takes the whole row until a game is picked. Picking one
 * brings the panel back at its usual width, and the rows stay where they were,
 * so the click that selected a game is still on it for the second click of a
 * double click.
 *
 * Unmeasured (zero), the panel stays: a list that has not been laid out yet
 * has nothing to be squeezed.
 */
export function emptyDetailGivesWay(
  layoutWidth: number,
  detailWidth: number,
  widths: readonly number[],
): boolean {
  if (layoutWidth <= 0) return false;
  return layoutWidth - DETAIL_GAP_PX - detailWidth < listWidthFor(widths);
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
