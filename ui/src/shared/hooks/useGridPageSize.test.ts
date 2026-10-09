import { describe, expect, it } from "vitest";
import { gridCapacity, pageFillerCount } from "./useGridPageSize";

describe("how many empty places hold a short page", () => {
  it("fills the last page up to a full one, so the pager does not rise", () => {
    // Fourteen fit, the last of three pages has five: nine places held.
    expect(pageFillerCount({ shown: 5, pageSize: 14, fitted: 14, totalPages: 3 })).toBe(9);
  });

  it("holds nothing on a full page", () => {
    expect(pageFillerCount({ shown: 14, pageSize: 14, fitted: 14, totalPages: 3 })).toBe(0);
  });

  it("holds nothing when there is one page and so no pager", () => {
    expect(pageFillerCount({ shown: 3, pageSize: 14, fitted: 14, totalPages: 1 })).toBe(0);
  });

  it("fills to a smaller page size picked in Settings", () => {
    expect(pageFillerCount({ shown: 4, pageSize: 10, fitted: 14, totalPages: 2 })).toBe(6);
  });

  it("fills no further than the panel when Settings picked more than fits", () => {
    // Full pages of 60 scroll anyway; the last one stops at the panel's foot
    // rather than leaving a screen of nothing below its cards.
    expect(pageFillerCount({ shown: 5, pageSize: 60, fitted: 14, totalPages: 2 })).toBe(9);
    expect(pageFillerCount({ shown: 20, pageSize: 60, fitted: 14, totalPages: 2 })).toBe(0);
  });
});

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
