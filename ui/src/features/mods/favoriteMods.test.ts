import { describe, expect, it } from "vitest";

import { favoriteModKeys, favoriteModToggle, isFavoriteMod } from "./favoriteMods";

describe("starring a mod", () => {
  it("names the one uid rather than sending a whole list", () => {
    expect(favoriteModToggle(["eco-graph"], "ACU-Highlight")).toEqual({
      type: "setListMember",
      payload: { list: "favoriteMods", value: "ACU-Highlight", member: true },
    });
  });

  it("un-stars an entry an older client wrote in another case", () => {
    expect(favoriteModToggle(["ACU-HIGHLIGHT"], "acu-highlight")).toMatchObject({
      payload: { member: false },
    });
  });

  it("survives a preferences file that has never held one", () => {
    expect(favoriteModToggle(undefined, "a")).toMatchObject({ payload: { member: true } });
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
