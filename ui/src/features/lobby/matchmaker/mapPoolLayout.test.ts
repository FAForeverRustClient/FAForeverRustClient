import { describe, expect, it } from "vitest";
import {
  MAP_POOL_COMPACT_BELOW,
  MAP_POOL_COMPACT_FOOT,
  MAP_POOL_FOOT,
  MAP_POOL_GAP,
  MAP_POOL_MAX_TILE,
  MAP_POOL_MIN_TILE,
  fitMapPool,
  type MapPoolLayout,
} from "./mapPoolLayout";

const extent = (count: number, layout: MapPoolLayout) => {
  const rows = Math.ceil(count / layout.columns);
  const foot = layout.compact ? MAP_POOL_COMPACT_FOOT : MAP_POOL_FOOT;
  return {
    width: layout.columns * layout.tile + (layout.columns - 1) * MAP_POOL_GAP,
    height: rows * (layout.tile + foot) + (rows - 1) * MAP_POOL_GAP,
  };
};

describe("fitMapPool", () => {
  it("shows every map of any real pool without overflowing the room", () => {
    const rooms = [
      [1000, 380],
      [1820, 780],
      [2460, 1140],
    ];
    for (const [width, height] of rooms) {
      for (let count = 1; count <= 36; count++) {
        const layout = fitMapPool(count, width, height);
        const size = extent(count, layout);
        expect(size.width).toBeLessThanOrEqual(width);
        expect(size.height).toBeLessThanOrEqual(height);
        expect(layout.tile).toBeGreaterThanOrEqual(MAP_POOL_MIN_TILE);
      }
    }
  });

  it("does not grow a small pool past the largest tile", () => {
    const layout = fitMapPool(4, 2400, 1200);
    expect(layout.tile).toBe(MAP_POOL_MAX_TILE);
    expect(layout.columns).toBe(4);
  });

  it("prefers a full last row, then the wider grid, among equal tiles", () => {
    // 12 maps at the largest tile fit as 4x3 and as 6x2; 6x2 is wider.
    expect(fitMapPool(12, 2400, 1200).columns).toBe(6);
    // 15 maps in a room that allows 220px tiles in five or more columns:
    // five columns leave no hole, eight would leave one.
    expect(fitMapPool(15, 1840, 1200).columns).toBe(5);
  });

  it("drops the size line only on tiles below the edge", () => {
    const large = fitMapPool(16, 1820, 780);
    expect(large.compact).toBe(false);
    expect(large.tile).toBeGreaterThanOrEqual(MAP_POOL_COMPACT_BELOW);

    const small = fitMapPool(30, 1000, 380);
    expect(small.compact).toBe(true);
    expect(small.tile).toBeLessThan(MAP_POOL_COMPACT_BELOW);
  });

  it("keeps the smallest tile and lets the dialog scroll only when nothing else fits", () => {
    const layout = fitMapPool(200, 600, 300);
    expect(layout.tile).toBe(MAP_POOL_MIN_TILE);
    expect(extent(200, layout).width).toBeLessThanOrEqual(600);
  });
});
