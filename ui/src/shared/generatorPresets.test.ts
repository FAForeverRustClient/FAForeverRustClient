import { describe, expect, it } from "vitest";
import { isUsablePresetName } from "./generatorPresets";

describe("isUsablePresetName", () => {
  it("accepts names in different writing systems", () => {
    expect(isUsablePresetName("Map Preset")).toBe(true);
    expect(isUsablePresetName("Карта 2")).toBe(true);
    expect(isUsablePresetName("Karte 2")).toBe(true);
  });

  it("rejects empty names, path separators and names beyond the byte limit", () => {
    expect(isUsablePresetName("  ")).toBe(false);
    expect(isUsablePresetName("../preset")).toBe(false);
    expect(isUsablePresetName("я".repeat(41))).toBe(false);
  });
});
