import { describe, expect, it } from "vitest";
import { pointsInZoom } from "./RatingHistoryChart";

describe("pointsInZoom (#631)", () => {
  const points = [1, 2, 3, 4, 5].map((timestamp) => ({ timestamp, rating: 1000 + timestamp }));

  it("keeps the marked stretch, its ends included", () => {
    expect(pointsInZoom(points, { start: 2, end: 4 }).map((point) => point.timestamp)).toEqual([2, 3, 4]);
  });

  it("keeps every point without a zoom", () => {
    expect(pointsInZoom(points, null)).toBe(points);
  });
});
