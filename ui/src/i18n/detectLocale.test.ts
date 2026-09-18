import { describe, expect, it } from "vitest";
import { matchLocale } from "./locales";

describe("matchLocale", () => {
  it("takes the language a regional tag names", () => {
    expect(matchLocale(["ru-RU"])).toBe("ru");
    expect(matchLocale(["de-AT"])).toBe("de");
    expect(matchLocale(["pt-BR", "fr-CA"])).toBe("fr");
  });

  it("accepts a bare language tag", () => {
    expect(matchLocale(["pl"])).toBe("pl");
  });

  it("walks the list in the order the system gave it", () => {
    // Windows hands over a preference order, and the first translated entry is
    // the closest thing to what the reader asked for.
    expect(matchLocale(["nl-NL", "de-DE", "en-GB"])).toBe("de");
  });

  it("ignores case and an underscore separator", () => {
    // `navigator.language` is lower-cased and hyphenated, but the same tags
    // reach this from other places in other shapes.
    expect(matchLocale(["ES_es"])).toBe("es");
  });

  it("answers null when nothing is translated, rather than guessing", () => {
    expect(matchLocale(["ja-JP", "ko-KR"])).toBeNull();
    expect(matchLocale([])).toBeNull();
  });

  it("is not fooled by a tag whose region looks like a language", () => {
    // "en-DE" is English as spoken in Germany, not German.
    expect(matchLocale(["en-DE"])).toBe("en");
  });
});
