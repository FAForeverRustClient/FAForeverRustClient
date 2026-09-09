import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  NO_ZOOM,
  clampPan,
  clampScale,
  panBy,
  zoomByStep,
  zoomTo,
} from "./mapZoom";

const size = { width: 400, height: 400 };

describe("map preview zoom", () => {
  it("keeps the point under the cursor still", () => {
    const zoomed = zoomTo(NO_ZOOM, 2, { x: 100, y: 300 }, size);
    // The content coordinate under (100, 300) was (100, 300) at scale 1, and
    // is still under it afterwards.
    expect((100 - zoomed.x) / zoomed.scale).toBeCloseTo(100);
    expect((300 - zoomed.y) / zoomed.scale).toBeCloseTo(300);
  });

  it("never lets an edge of the image leave the viewport", () => {
    const dragged = panBy(zoomTo(NO_ZOOM, 2, { x: 200, y: 200 }, size), { x: 999, y: -999 }, size);
    expect(dragged.x).toBe(0);
    expect(dragged.y).toBe(size.height * (1 - dragged.scale));
  });

  it("pins the image at the origin once it is back to whole-map", () => {
    expect(clampPan({ scale: 1, x: -80, y: 40 }, size)).toEqual(NO_ZOOM);
  });

  it("stops at the ends of the range", () => {
    expect(clampScale(0.2)).toBe(1);
    expect(clampScale(99)).toBe(MAX_SCALE);
    const far = zoomTo(NO_ZOOM, 100, { x: 0, y: 0 }, size);
    expect(far.scale).toBe(MAX_SCALE);
  });

  it("steps by the same proportion in both directions", () => {
    const point = { x: 200, y: 200 };
    const inOnce = zoomByStep(NO_ZOOM, 1, point, size);
    const backAgain = zoomByStep(inOnce, -1, point, size);
    expect(inOnce.scale).toBeGreaterThan(1);
    expect(backAgain.scale).toBeCloseTo(1);
    expect(backAgain.x).toBeCloseTo(0);
  });

  it("zooming out from a corner walks the view back to the whole map", () => {
    const corner = zoomTo(NO_ZOOM, 4, { x: 400, y: 400 }, size);
    expect(corner.x).toBe(size.width * (1 - 4));
    const reset = zoomTo(corner, 1, { x: 400, y: 400 }, size);
    expect(reset).toEqual(NO_ZOOM);
  });
});
