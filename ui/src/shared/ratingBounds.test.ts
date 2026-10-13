import { describe, expect, it } from "vitest";

import { boundsText } from "./ratingBounds";

describe("bounds as words", () => {
  it("names both ends when both are set", () => {
    expect(boundsText(1000, 1800)).toBe("1000 to 1800");
  });

  it("names the one end that is set instead of calling the other one Any", () => {
    // The report: "0 To Any" for a lobby open at the top.
    expect(boundsText(0, null)).toBe("From 0");
    expect(boundsText(null, 1800)).toBe("Up to 1800");
  });

  it("leaves a range without ends to the caller", () => {
    expect(boundsText(null, null)).toBeNull();
  });

  it("formats each end the caller's way", () => {
    expect(boundsText(-200, null, (value) => `[${value}]`)).toBe("From [-200]");
  });
});
