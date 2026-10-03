import { describe, expect, it } from "vitest";
import { designedOrder, resolveColumnOrder, withColumnMoved } from "../../../shared/hooks/useColumnOrder";
import {
  columnTemplate,
  columnWidths,
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_DETAIL_WIDTH,
  detailWidth,
  columnScale,
  MIN_GAME_COLUMN_PX,
  scaledColumnWidths,
  withColumnResized,
  withDetailResized,
} from "./browserLayout";
import {
  MAX_DETAIL_PX,
  MIN_BROWSER_COLUMN_PX,
  MIN_DETAIL_PX,
} from "../../../shared/browsingPreferences";

describe("the game list's column widths", () => {
  it("falls back to the designed width for anything not stored", () => {
    // Empty, short and over-long are all "use the design for the rest": a
    // release that adds or drops a column must not leave the list unusable.
    expect(columnWidths([])).toEqual([...DEFAULT_COLUMN_WIDTHS]);
    expect(columnWidths([400])).toEqual([400, ...DEFAULT_COLUMN_WIDTHS.slice(1)]);
    expect(columnWidths([400, 0, 0, 0, 0, 0, 999])).toEqual([
      400,
      ...DEFAULT_COLUMN_WIDTHS.slice(1),
    ]);
    expect(columnWidths(undefined)).toEqual([...DEFAULT_COLUMN_WIDTHS]);
  });

  it("draws the columns as dragged while the list has room for them", () => {
    // 935 px of columns, five 16 px gaps and 32 px of padding: 1047.
    expect(columnScale(1200, DEFAULT_COLUMN_WIDTHS)).toBe(1);
    expect(columnScale(1047, DEFAULT_COLUMN_WIDTHS)).toBe(1);
    // Not measured yet.
    expect(columnScale(0, DEFAULT_COLUMN_WIDTHS)).toBe(1);
  });

  it("narrows every column in proportion when it does not", () => {
    const scale = columnScale(1047 - 187, DEFAULT_COLUMN_WIDTHS);
    expect(scale).toBeCloseTo(748 / 935);
    const shown = scaledColumnWidths(DEFAULT_COLUMN_WIDTHS, scale);
    expect(shown.reduce((sum, width) => sum + width, 0)).toBeCloseTo(748, -1);
  });

  it("reads a set saved before the tags column as the columns it described", () => {
    // Five widths are game, map, players, rating and age. Taken position by
    // position the map's width would become the tags column's, and every
    // column after it would shift one place along.
    expect(columnWidths([400, 210, 90, 110, 80])).toEqual([
      400,
      DEFAULT_COLUMN_WIDTHS[1],
      210,
      90,
      110,
      80,
    ]);
  });

  it("moves the line under the cursor and nothing else", () => {
    // The two columns the line separates trade width, so the totals do not
    // change and no other line moves. Resizing one column on its own is what
    // this replaced: the game column absorbed it, which moved every line in
    // front of the cursor while the one under it stayed still.
    const widths = [320, 170, 80, 100, 75];
    expect(withColumnResized(widths, 2, 20)).toEqual([320, 190, 60, 100, 75]);
    expect(withColumnResized(widths, 2, -20)).toEqual([320, 150, 100, 100, 75]);
  });

  it("moves the game column's edge for the line in front of Tags", () => {
    // The game column has a width of its own, so the line in front of Tags
    // moves like any other: the game column gives what Tags takes.
    const widths = [320, 190, 170, 80, 100, 75];
    expect(withColumnResized(widths, 1, 40)).toEqual([360, 150, 170, 80, 100, 75]);
    expect(withColumnResized(widths, 1, -40)).toEqual([280, 230, 170, 80, 100, 75]);
  });

  it("stops the game column at a readable width", () => {
    const widths = [320, 190, 170, 80, 100, 75];
    expect(withColumnResized(widths, 1, -5000)[0]).toBe(MIN_GAME_COLUMN_PX);
    expect(withColumnResized(widths, 1, -5000)[1]).toBe(190 + 320 - MIN_GAME_COLUMN_PX);
  });

  it("travels until the column it is closing has nothing left", () => {
    // Only the shrinking side can stop a line: growing is unbounded. So the
    // drag runs until Players is shut, and on the way back it grows by
    // everything Map had to give, not by the distance the pointer covered.
    const widths = [320, 170, 80, 100, 75];
    expect(withColumnResized(widths, 2, 5000))
      .toEqual([320, 170 + (80 - MIN_BROWSER_COLUMN_PX), MIN_BROWSER_COLUMN_PX, 100, 75]);
    expect(withColumnResized(widths, 2, -5000))
      .toEqual([320, MIN_BROWSER_COLUMN_PX, 80 + (170 - MIN_BROWSER_COLUMN_PX), 100, 75]);
  });

  it("stops the game column at a readable width from either side", () => {
    // Moved to the right of another column, the game column is the one the
    // divider in front of it takes from when dragged right.
    const widths = [190, 320, 170];
    expect(withColumnResized(widths, 1, 5000, 1)[1]).toBe(MIN_GAME_COLUMN_PX);
  });

  it("moves a column to where it is dropped", () => {
    expect(withColumnMoved([0, 1, 2, 3, 4, 5], 0, 3)).toEqual([1, 2, 3, 0, 4, 5]);
    expect(withColumnMoved([0, 1, 2, 3, 4, 5], 5, 0)).toEqual([5, 0, 1, 2, 3, 4]);
    expect(resolveColumnOrder([], 6)).toEqual(designedOrder(6));
    expect(resolveColumnOrder([5, 4, 3, 2, 1, 0], 6)).toEqual([5, 4, 3, 2, 1, 0]);
    // An order saved for a table with a different number of columns.
    expect(resolveColumnOrder([1, 0], 6)).toEqual(designedOrder(6));
  });

  it("gives the game column the slack wherever it is drawn", () => {
    expect(columnTemplate([170, 320, 80], 1)).toBe("170px minmax(0, 1fr) 80px");
  });

  it("gives the game column whatever the other four leave", () => {
    // Not a track of its own at the end: the list then stopped a third of the
    // way across a wide window, with the titles beside it still cut off.
    expect(columnTemplate([320, 170, 80, 100, 75])).toBe(
      "minmax(0, 1fr) 170px 80px 100px 75px",
    );
  });
});

describe("the details panel's width", () => {
  it("widens as the divider is dragged towards the list", () => {
    // The handle is on the panel's left edge, so left is wider.
    expect(withDetailResized(300, -40)).toBe(340);
    expect(withDetailResized(300, 40)).toBe(260);
  });

  it("stays between a readable preview and a usable game list", () => {
    expect(withDetailResized(300, -5000)).toBe(MAX_DETAIL_PX);
    expect(withDetailResized(300, 5000)).toBe(MIN_DETAIL_PX);
  });

  it("reads an unset width as the designed one", () => {
    expect(detailWidth(0)).toBe(DEFAULT_DETAIL_WIDTH);
    expect(detailWidth(undefined)).toBe(DEFAULT_DETAIL_WIDTH);
    expect(detailWidth(400)).toBe(400);
  });
});
