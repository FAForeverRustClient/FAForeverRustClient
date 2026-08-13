import { describe, expect, it } from "vitest";
import { CLIENT_LOCALE, formatDate, formatDateTime, formatShortDate } from "./dates";

describe("English-only date formatting", () => {
  it("does not inherit the operating-system language", () => {
    expect(CLIENT_LOCALE).toBe("en-US");
    expect(formatShortDate("2026-08-10T12:00:00Z")).toBe("Aug 10, 2026");
  });

  it("keeps custom formats and invalid-value fallbacks", () => {
    expect(formatDate("2026-08-10T12:00:00Z", "N/A", { month: "long" })).toBe("August");
    expect(formatDateTime("not-a-date", "N/A")).toBe("N/A");
  });
});
