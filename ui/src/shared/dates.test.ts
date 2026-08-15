import { afterEach, describe, expect, it } from "vitest";
import { resetLocaleForTests, setLocale } from "../i18n/store";
import { clientIntlTag, formatDate, formatDateTime, formatShortDate } from "./dates";

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

  it("follows the selected language", () => {
    setLocale("de");
    expect(clientIntlTag()).toBe("de-DE");
    expect(formatDate("2026-08-10T12:00:00Z", "N/A", { month: "long" })).toBe("August");
    expect(formatShortDate("2026-08-10T12:00:00Z")).toBe("10. Aug. 2026");
  });
});
