import { describe, expect, it } from "vitest";
import { normalizePathPreferences, withKeptGeneratedMaps } from "./pathPreferences";

describe("path preferences", () => {
  it("trims what a file manager pastes in", () => {
    expect(normalizePathPreferences({ mapsDir: "  D:/faf/maps  " }).mapsDir).toBe("D:/faf/maps");
  });

  it("fills every field, so an absent one reads as unset rather than undefined", () => {
    expect(normalizePathPreferences({})).toEqual({
      vaultDir: "",
      mapsDir: "",
      modsDir: "",
      replaysDir: "",
      gamePrefsPath: "",
      mapGeneratorDir: "",
      javaPath: "",
    });
  });
});

describe("kept generated maps", () => {
  it("adds without releasing what an earlier run kept", () => {
    expect(withKeptGeneratedMaps(["neroxis_a"], ["neroxis_b"])).toEqual(["neroxis_a", "neroxis_b"]);
  });

  it("ignores a repeat, whatever its case, and blank entries", () => {
    expect(withKeptGeneratedMaps(["neroxis_a"], ["  NEROXIS_A ", "   ", "neroxis_b"])).toEqual([
      "neroxis_a",
      "neroxis_b",
    ]);
  });
});
