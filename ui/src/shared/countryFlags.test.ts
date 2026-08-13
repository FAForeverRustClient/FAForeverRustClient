import { describe, expect, it } from "vitest";
import { flagSrc } from "./countryFlags";

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
