import { describe, expect, it } from "vitest";
import { gridCapacity } from "./useGridPageSize";

describe("how many cards fill a page", () => {
  it("counts whole rows of whatever the grid resolved to", () => {
    // Four tracks, cards 76 tall, 8 of gap: 4 rows need 76*4 + 8*3 = 328.
    expect(
      gridCapacity({ columns: 4, availableHeightPx: 328, rowHeightPx: 76, rowGapPx: 8 }),
    ).toBe(16);
  });

  it("does not charge a gap for the last row", () => {
    // Exactly three rows and not a pixel more. Dividing without allowing for
    // the missing trailing gap would have said two.
    expect(
      gridCapacity({ columns: 3, availableHeightPx: 244, rowHeightPx: 76, rowGapPx: 8 }),
    ).toBe(9);
  });

  it("drops the row that does not fit rather than half-showing it", () => {
    expect(
      gridCapacity({ columns: 2, availableHeightPx: 327, rowHeightPx: 76, rowGapPx: 8 }),
    ).toBe(6);
  });

  it("keeps a usable page on a window too short to hold one row", () => {
    // A page of one card under a pager is worse than a little scrolling.
    expect(
      gridCapacity({ columns: 1, availableHeightPx: 10, rowHeightPx: 76, rowGapPx: 8 }),
    ).toBe(4);
  });

  it("answers something usable before the grid has been laid out", () => {
    // The first measurement can land while the panel is still zero-sized.
    expect(
      gridCapacity({ columns: 0, availableHeightPx: 0, rowHeightPx: 0, rowGapPx: 0 }),
    ).toBe(4);
  });
});
