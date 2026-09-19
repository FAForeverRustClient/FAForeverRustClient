import { afterEach, describe, expect, it } from "vitest";
import { resetLocaleForTests, setLocale } from "../../i18n/store";
import { clientIntlTag, formatDate, formatDateTime, formatShortDate, formatShortDateTime } from "./dates";

afterEach(() => {
  resetLocaleForTests();
});

describe("date formatting", () => {
  it("does not inherit the operating-system language", () => {
    // The guarantee this file has always made: formatting follows an explicit
    // client decision. That decision used to be the hardcoded "en-US"; it is
    // now the language the user selected, which defaults to English.
    expect(clientIntlTag()).toBe("en-US");
    expect(formatShortDate("2026-08-10T12:00:00Z")).toBe("Aug 10, 2026");
  });

  it("keeps custom formats and invalid-value fallbacks", () => {
    expect(formatDate("2026-08-10T12:00:00Z", "N/A", { month: "long" })).toBe("August");
    expect(formatDateTime("not-a-date", "N/A")).toBe("N/A");
  });

  it("puts a clock time beside the short date", () => {
    // Asserted as a shape rather than a literal: the hour a UTC instant falls
    // in is whatever the machine running the suite is set to, and the point of
    // this helper is only that a time of day is printed at all -- a replay card
    // showing 9/13/2026 cannot tell two of that evening's games apart.
    expect(formatShortDateTime("2026-08-10T12:00:00Z")).toMatch(
      /^\d{1,2}\/\d{1,2}\/2026, \d{2}:\d{2}(\s(AM|PM))?$/,
    );
    expect(formatShortDateTime("", "N/A")).toBe("N/A");
    expect(formatShortDateTime("not-a-date", "N/A")).toBe("N/A");
  });

  it("follows the selected language", () => {
    setLocale("de");
    expect(clientIntlTag()).toBe("de-DE");
    expect(formatDate("2026-08-10T12:00:00Z", "N/A", { month: "long" })).toBe("August");
    expect(formatShortDate("2026-08-10T12:00:00Z")).toBe("10. Aug. 2026");
  });
});
