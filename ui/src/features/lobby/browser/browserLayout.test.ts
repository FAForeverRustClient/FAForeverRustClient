import { describe, expect, it } from "vitest";
import {
  columnTemplate,
  columnWidths,
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_DETAIL_WIDTH,
  detailWidth,
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
    expect(columnWidths([400, 0, 0, 0, 0, 999])).toEqual([
      400,
      ...DEFAULT_COLUMN_WIDTHS.slice(1),
    ]);
    expect(columnWidths(undefined)).toEqual([...DEFAULT_COLUMN_WIDTHS]);
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

  it("takes from the game column for the line in front of Map", () => {
    // The game column has no width of its own, so the line in front of Map
    // only has to move Map: what Map gives up the title takes on.
    const widths = [320, 170, 80, 100, 75];
    expect(withColumnResized(widths, 1, 40)).toEqual([320, 130, 80, 100, 75]);
    expect(withColumnResized(widths, 1, -40)).toEqual([320, 210, 80, 100, 75]);
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
