import { afterEach, describe, expect, it } from "vitest";
import { formatDate, formatShortDateTime } from "./dates";
import {
  formatWithTokens,
  parseDatePattern,
  parseWithTokens,
  placeholderFor,
  setSystemDatePattern,
} from "./systemDate";

const SEPTEMBER_16 = new Date(2026, 8, 16, 21, 30);

describe("the regional date pattern", () => {
  afterEach(() => setSystemDatePattern(null));

  it("writes a date in the order Windows names", () => {
    for (const [pattern, written] of [
      ["dd.MM.yyyy", "16.09.2026"],
      ["M/d/yyyy", "9/16/2026"],
      ["yyyy-MM-dd", "2026-09-16"],
      ["dd/MM/yy", "16/09/26"],
      ["d. M. yyyy", "16. 9. 2026"],
    ] as const) {
      const tokens = parseDatePattern(pattern);
      expect(tokens).not.toBeNull();
      expect(formatWithTokens(tokens!, SEPTEMBER_16)).toBe(written);
    }
  });

  it("leaves a pattern with names in it to the language", () => {
    expect(parseDatePattern("dd-MMM-yy")).toBeNull();
    expect(parseDatePattern("dddd, d MMMM yyyy")).toBeNull();
    expect(parseDatePattern("gg yyyy/MM/dd")).toBeNull();
    expect(parseDatePattern("dd.MM")).toBeNull();
  });

  it("keeps quoted text as it is", () => {
    const tokens = parseDatePattern("yyyy'年'M'月'd'日'");
    expect(formatWithTokens(tokens!, SEPTEMBER_16)).toBe("2026年9月16日");
  });

  it("reads typed text back in the same order", () => {
    const dayFirst = parseDatePattern("dd.MM.yyyy")!;
    expect(parseWithTokens(dayFirst, "16.09.2026")).toBe("2026-09-16");
    expect(parseWithTokens(dayFirst, "16/9/26")).toBe("2026-09-16");
    expect(parseWithTokens(dayFirst, "31.02.2026")).toBeNull();
    expect(parseWithTokens(dayFirst, "16.09.")).toBeNull();
    expect(parseWithTokens(parseDatePattern("M/d/yyyy")!, "9/16/2026")).toBe("2026-09-16");
  });

  it("shows the pattern as a placeholder", () => {
    expect(placeholderFor(parseDatePattern("d.M.yyyy")!)).toBe("dd.mm.yyyy");
  });

  it("is what a numeric date is written in once the shell has named it", () => {
    const iso = SEPTEMBER_16.toISOString();
    setSystemDatePattern("dd.MM.yyyy");
    expect(formatDate(iso)).toBe("16.09.2026");
    expect(formatShortDateTime(iso).startsWith("16.09.2026 ")).toBe(true);
    setSystemDatePattern(null);
    expect(formatDate(iso)).not.toBe("16.09.2026");
  });
});
