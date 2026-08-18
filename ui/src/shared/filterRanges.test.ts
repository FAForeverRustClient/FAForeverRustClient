import { describe, expect, it } from "vitest";
import {
  includesNormalized,
  isWithinDateRange,
  isWithinNumberRange,
  sortByDateDesc,
} from "./filterRanges";

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

  it("sorts newest first and keeps unparsable timestamps last", () => {
    const rows = [
      { name: "middle", at: "2026-08-11T00:00:00Z" },
      { name: "broken", at: "not-a-date" },
      { name: "newest", at: "2026-08-12T00:00:00Z" },
      { name: "oldest", at: "2020-01-01T00:00:00Z" },
    ];
    expect(sortByDateDesc(rows, (row) => row.at).map((row) => row.name))
      .toEqual(["newest", "middle", "oldest", "broken"]);
  });

  it("treats a missing timestamp as the epoch rather than throwing", () => {
    const rows = [{ at: undefined }, { at: "2026-08-12T00:00:00Z" }];
    expect(sortByDateDesc(rows, (row) => row.at)[0].at).toBe("2026-08-12T00:00:00Z");
  });
});
