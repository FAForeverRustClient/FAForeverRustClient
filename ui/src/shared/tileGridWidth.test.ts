import { describe, expect, it } from "vitest";
import { COMFORTABLE_TILE_PX, comfortableTileColumns, tileWidthFor } from "./tileGridWidth";

describe("the tile grid's widths", () => {
  it("shares the row between the tiles, less the gaps between them", () => {
    expect(tileWidthFor(1200, 1)).toBe(1200);
    // Four tiles, three 12 px gaps.
    expect(tileWidthFor(1200, 4)).toBe(291);
  });

  it("counts the most tiles that stay comfortable, and never fewer than one", () => {
    // Five at the comfortable width and four gaps between them, exactly.
    const five = 5 * COMFORTABLE_TILE_PX + 4 * 12;
    expect(comfortableTileColumns(five)).toBe(5);
    expect(comfortableTileColumns(five - 1)).toBe(4);
    expect(comfortableTileColumns(200)).toBe(1);
    expect(tileWidthFor(five, comfortableTileColumns(five))).toBe(COMFORTABLE_TILE_PX);
  });
});
