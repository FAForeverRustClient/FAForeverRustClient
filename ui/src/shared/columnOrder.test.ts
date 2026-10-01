import { describe, expect, it } from "vitest";
import {
  fromDrawnOrder,
  inDrawnOrder,
  isDesignedOrder,
  resolveColumnOrder,
  withColumnMoved,
  withColumnStepped,
} from "./columnOrder";

describe("a list's column order", () => {
  it("is the designed one when nothing was stored", () => {
    expect(resolveColumnOrder(undefined, 4)).toEqual([0, 1, 2, 3]);
    expect(resolveColumnOrder([], 3)).toEqual([0, 1, 2]);
  });

  it("keeps a stored arrangement, drops what is not a column and adds what is missing", () => {
    expect(resolveColumnOrder([2, 0, 1], 3)).toEqual([2, 0, 1]);
    // A release that had one column fewer: the new one goes last.
    expect(resolveColumnOrder([1, 0], 3)).toEqual([1, 0, 2]);
    // A hand-edited file: duplicates, negatives and strangers are dropped.
    expect(resolveColumnOrder([1, 1, -1, 9, 0.5, 2], 3)).toEqual([1, 2, 0]);
  });

  it("tells the designed order apart", () => {
    expect(isDesignedOrder([0, 1, 2])).toBe(true);
    expect(isDesignedOrder([1, 0, 2])).toBe(false);
  });

  it("puts a dropped column where its target was", () => {
    expect(withColumnMoved([0, 1, 2, 3], 0, 2)).toEqual([1, 2, 0, 3]);
    expect(withColumnMoved([0, 1, 2, 3], 3, 1)).toEqual([0, 3, 1, 2]);
    expect(withColumnMoved([0, 1, 2], 1, 1)).toEqual([0, 1, 2]);
  });

  it("steps a column one place with the keyboard, not past either end", () => {
    expect(withColumnStepped([0, 1, 2], 1, 1)).toEqual([0, 2, 1]);
    expect(withColumnStepped([0, 1, 2], 0, -1)).toEqual([0, 1, 2]);
    expect(withColumnStepped([0, 1, 2], 2, 1)).toEqual([0, 1, 2]);
  });

  it("maps per-column values to drawn order and back", () => {
    const order = [2, 0, 1];
    const drawn = inDrawnOrder([10, 20, 30], order);
    expect(drawn).toEqual([30, 10, 20]);
    expect(fromDrawnOrder(drawn, order, [0, 0, 0])).toEqual([10, 20, 30]);
  });
});
