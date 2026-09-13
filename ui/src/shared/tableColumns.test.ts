import { describe, expect, it } from "vitest";
import { MAX_BROWSER_COLUMN_PX, MIN_BROWSER_COLUMN_PX } from "./browsingPreferences";
import {
  columnTemplate,
  resolveColumnWidths,
  tableMinWidth,
  withBoundaryDragged,
} from "./tableColumns";

const WIDTHS = [120, 110, 260, 84, 84, 150, 130, 128];
const FLEXIBLE = 2;

describe("a table's stored column widths", () => {
  it("falls back to the designed width for anything not stored", () => {
    // Empty, short and over-long are all "use the design for the rest": a
    // release that adds or drops a column must not leave the table unusable.
    expect(resolveColumnWidths([], WIDTHS)).toEqual(WIDTHS);
    expect(resolveColumnWidths(undefined, WIDTHS)).toEqual(WIDTHS);
    expect(resolveColumnWidths([200], WIDTHS)).toEqual([200, ...WIDTHS.slice(1)]);
    expect(resolveColumnWidths([...WIDTHS, 999], WIDTHS)).toEqual(WIDTHS);
  });

  it("bounds a stored width the way the backend bounds it", () => {
    expect(resolveColumnWidths([1], WIDTHS)[0]).toBe(MIN_BROWSER_COLUMN_PX);
    expect(resolveColumnWidths([9999], WIDTHS)[0]).toBe(MAX_BROWSER_COLUMN_PX);
  });
});

describe("dragging the line in front of a column", () => {
  it("trades width between the two columns it separates", () => {
    // Which is what keeps the line under the cursor: the totals do not change,
    // so the flexible column does not move and neither does any other line.
    expect(withBoundaryDragged(WIDTHS, 4, -20, FLEXIBLE)).toEqual([
      120, 110, 260, 64, 104, 150, 130, 128,
    ]);
    // Far enough right that the column it takes from runs out first: 28 of the
    // 30 pixels are there to be had, and both sides stop on the same 28.
    expect(withBoundaryDragged(WIDTHS, 4, 30, FLEXIBLE)).toEqual([
      120, 110, 260, 112, 56, 150, 130, 128,
    ]);
  });

  it("leaves the flexible column alone on either side of the line", () => {
    // It has no width of its own, so there is nothing to write: it takes on
    // whatever its neighbour gives up, which is how the line still moves.
    expect(withBoundaryDragged(WIDTHS, 2, 40, FLEXIBLE)).toEqual([
      120, 150, 260, 84, 84, 150, 130, 128,
    ]);
    expect(withBoundaryDragged(WIDTHS, 3, 40, FLEXIBLE)).toEqual([
      120, 110, 260, 56, 84, 150, 130, 128,
    ]);
  });

  it("stops both columns at the bounds, rather than one of them", () => {
    // Letting the far side carry on would pull the line away from the cursor
    // and quietly change the total width of the table with it.
    const dragged = withBoundaryDragged(WIDTHS, 5, 5000, FLEXIBLE);
    expect(dragged[5]).toBe(MIN_BROWSER_COLUMN_PX);
    expect(dragged[4]).toBe(84 + (150 - MIN_BROWSER_COLUMN_PX));
    expect(tableMinWidth(dragged)).toBe(tableMinWidth(WIDTHS));
  });

  it("ignores a line that has no column on one side of it", () => {
    expect(withBoundaryDragged(WIDTHS, 0, 40, FLEXIBLE)).toEqual(WIDTHS);
    expect(withBoundaryDragged(WIDTHS, WIDTHS.length, 40, FLEXIBLE)).toEqual(WIDTHS);
  });
});

describe("the template a set of widths draws", () => {
  it("gives the flexible column whatever the others leave", () => {
    expect(columnTemplate([56, 260, 140], 1)).toBe("56px minmax(0, 1fr) 140px");
  });

  it("measures a table by the widths it was given, floor included", () => {
    expect(tableMinWidth(WIDTHS)).toBe(1066);
  });
});
