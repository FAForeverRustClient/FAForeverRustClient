import { describe, expect, it } from "vitest";
import {
  ROSTER_MAX_WIDTH,
  ROSTER_MEDIUM_FROM,
  ROSTER_MIN_WIDTH,
  ROSTER_WIDE_FROM,
  clampRosterWidth,
  rosterTier,
} from "./RosterResizeHandle";

describe("rosterTier", () => {
  it("takes the smaller step for a width between two of them", () => {
    // The rule that keeps the panel from ever clipping: one pixel short of a
    // step is the step below, not a squeezed version of the one above.
    expect(rosterTier(ROSTER_WIDE_FROM - 1)).toBe("medium");
    expect(rosterTier(ROSTER_MEDIUM_FROM - 1)).toBe("narrow");
  });

  it("is on the step exactly at its threshold", () => {
    expect(rosterTier(ROSTER_WIDE_FROM)).toBe("wide");
    expect(rosterTier(ROSTER_MEDIUM_FROM)).toBe("medium");
  });

  it("covers the whole range the handle can produce", () => {
    // Every width the panel can be dragged to has a step, including both ends:
    // an unhandled width would render a lineup with no layout rules at all.
    expect(rosterTier(ROSTER_MIN_WIDTH)).toBe("narrow");
    expect(rosterTier(ROSTER_MAX_WIDTH)).toBe("wide");
    for (let width = ROSTER_MIN_WIDTH; width <= ROSTER_MAX_WIDTH; width += 1) {
      expect(["narrow", "medium", "wide"]).toContain(rosterTier(clampRosterWidth(width)));
    }
  });

  it("puts both thresholds inside the range, so all three steps are reachable", () => {
    expect(ROSTER_MEDIUM_FROM).toBeGreaterThan(ROSTER_MIN_WIDTH);
    expect(ROSTER_WIDE_FROM).toBeGreaterThan(ROSTER_MEDIUM_FROM);
    expect(ROSTER_WIDE_FROM).toBeLessThanOrEqual(ROSTER_MAX_WIDTH);
  });
});
