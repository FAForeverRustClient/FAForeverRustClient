import { describe, expect, it } from "vitest";
import { placeAlongAxis, pointsInZoom } from "./RatingHistoryChart";

describe("pointsInZoom (#631)", () => {
  const points = [1, 2, 3, 4, 5].map((timestamp) => ({ timestamp, at: timestamp, rating: 1000 + timestamp }));

  it("keeps the marked stretch, its ends included", () => {
    expect(pointsInZoom(points, { start: 2, end: 4 }).map((point) => point.timestamp)).toEqual([2, 3, 4]);
  });

  it("keeps every point without a zoom", () => {
    expect(pointsInZoom(points, null)).toBe(points);
  });
});

describe("placing points along the bottom (#645)", () => {
  const points = [100, 5_000, 90_000].map((timestamp) => ({ timestamp, rating: 1500 }));

  it("by date, at their time", () => {
    expect(placeAlongAxis(points, "date", 1).map((point) => point.at)).toEqual([100, 5_000, 90_000]);
  });

  it("by game, one step per game however far apart they were played", () => {
    expect(placeAlongAxis(points, "games", 3_448).map((point) => point.at)).toEqual([3_448, 3_449, 3_450]);
  });
});
