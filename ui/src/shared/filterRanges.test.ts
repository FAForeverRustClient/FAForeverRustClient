import { describe, expect, it } from "vitest";
import { includesNormalized, isWithinDateRange, isWithinNumberRange } from "./filterRanges";

describe("catalogue filter helpers", () => {
  it("matches optional text case-insensitively", () => {
    expect(includesNormalized("The Map Author", " map ")).toBe(true);
    expect(includesNormalized(null, "author")).toBe(false);
    expect(includesNormalized(null, "  ")).toBe(true);
  });

  it("uses inclusive nullable numeric bounds", () => {
    expect(isWithinNumberRange(4.5, 4.5, 5)).toBe(true);
    expect(isWithinNumberRange(4.4, 4.5, null)).toBe(false);
    expect(isWithinNumberRange(10, null, null)).toBe(true);
  });

  it("includes the complete selected calendar days", () => {
    expect(isWithinDateRange("2026-08-11T23:59:59Z", "2026-08-11", "2026-08-11")).toBe(true);
    expect(isWithinDateRange("2026-08-10T23:59:59Z", "2026-08-11", "")).toBe(false);
    expect(isWithinDateRange("not-a-date", "2026-08-11", "")).toBe(false);
    expect(isWithinDateRange("not-a-date", "", "")).toBe(true);
  });
});
