import { describe, expect, it } from "vitest";

import { favoriteModKeys, isFavoriteMod, withFavoriteToggled } from "./favoriteMods";

describe("starring a mod", () => {
  it("stores the uid folded, whatever case it arrives in", () => {
    expect(withFavoriteToggled([], "26B9F6DA-C6E1-4A0F-9F9B-6C0F0A3C2E71")).toEqual([
      "26b9f6da-c6e1-4a0f-9f9b-6c0f0a3c2e71",
    ]);
  });

  it("un-stars an entry an older client wrote in another case", () => {
    expect(withFavoriteToggled(["ACU-HIGHLIGHT"], "acu-highlight")).toEqual([]);
  });

  it("leaves the rest of the list alone", () => {
    expect(withFavoriteToggled(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("survives a preferences file that has never held one", () => {
    expect(withFavoriteToggled(undefined, "a")).toEqual(["a"]);
    expect(favoriteModKeys(null).size).toBe(0);
  });
});

describe("asking whether a mod is starred", () => {
  it("ignores case and surrounding space on both sides", () => {
    const favorites = favoriteModKeys([" ReUI ", "acu-highlight"]);
    expect(isFavoriteMod(favorites, "reui")).toBe(true);
    expect(isFavoriteMod(favorites, "ACU-Highlight")).toBe(true);
    expect(isFavoriteMod(favorites, "smart-factory")).toBe(false);
  });
});
