import { describe, expect, it } from "vitest";
import { mapSearchTerm } from "./deepLinks";

describe("a map link's vault search", () => {
  it("searches the folder's longest word, which the display name contains", () => {
    expect(mapSearchTerm("setons_clutch.v0004")).toBe("clutch");
    expect(mapSearchTerm("the_gap_of_rohan.v0002")).toBe("rohan");
    expect(mapSearchTerm("Old Map (final)")).toBe("final");
  });

  it("falls back to the folder when it has no plain word", () => {
    expect(mapSearchTerm("(x)")).toBe("x");
    expect(mapSearchTerm("()")).toBe("()");
  });
});
