import { describe, expect, it } from "vitest";
import { hexToHsv, hsvToHex, normalizeHex } from "./colorMath";

describe("reading a pasted colour", () => {
  it("accepts the spellings people paste and stores one", () => {
    expect(normalizeHex("#BA55D3")).toBe("#ba55d3");
    expect(normalizeHex("ba55d3")).toBe("#ba55d3");
    expect(normalizeHex(" #fa0 ")).toBe("#ffaa00");
  });

  it("refuses what is not a colour", () => {
    expect(normalizeHex("")).toBeNull();
    expect(normalizeHex("#ba55d")).toBeNull();
    expect(normalizeHex("rgb(1, 2, 3)")).toBeNull();
  });
});

describe("hue, saturation and value", () => {
  it("round-trips every colour the settings hold", () => {
    for (const hex of ["#cea863", "#33a1e6", "#dc143c", "#4ab04a", "#ba55d3", "#808080", "#000000", "#ffffff"]) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });

  it("puts the primaries where the hue slider draws them", () => {
    expect(hexToHsv("#ff0000").h).toBe(0);
    expect(hexToHsv("#00ff00").h).toBe(120);
    expect(hexToHsv("#0000ff").h).toBe(240);
  });

  it("keeps grey at no saturation rather than dividing by zero", () => {
    expect(hexToHsv("#000000")).toEqual({ h: 0, s: 0, v: 0 });
  });
});
