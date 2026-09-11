import { describe, expect, it } from "vitest";
import { countryLabel, countryName, flagSrc } from "./countryFlags";

describe("flagSrc", () => {
  it("normalizes ISO country codes", () => {
    expect(flagSrc(" DE ")).toBe("/flags/de.png");
  });

  it.each(["A1", "A2", "", "../secret"])(
    "uses the neutral earth flag for non-country code %j",
    (country) => {
      expect(flagSrc(country)).toBe("/flags/earth.png");
    },
  );
});

describe("countryName", () => {
  it("names the country in the reader's language", () => {
    // The report: a flag alone does not say which country it is, and the
    // tooltip said "PL", which does not either.
    expect(countryName("pl", "en-US")).toBe("Poland");
    expect(countryName("PL", "de-DE")).toBe("Polen");
    expect(countryName(" de ", "en-US")).toBe("Germany");
  });

  it.each(["A1", "A2", "", "../secret", "deu", "d"])(
    "has no name for %j, which is not a country",
    (country) => {
      // A1 and A2 are GeoIP's anonymous proxy and satellite provider. They get
      // the earth flag from `flagSrc` and no name from here.
      expect(countryName(country, "en-US")).toBe("");
    },
  );
});

describe("countryLabel", () => {
  it("falls back to the bare code rather than an empty tooltip", () => {
    expect(countryLabel("pl", "en-US")).toBe("Poland");
    // A1 is GeoIP's anonymous proxy: no country to name, so the code stands.
    expect(countryLabel("a1", "en-US")).toBe("A1");
    expect(countryLabel(" deu ", "en-US")).toBe("DEU");
  });
});
