import { describe, expect, it } from "vitest";

import { factionIdFromName } from "./factions";

describe("factionIdFromName", () => {
  it("reads the lowercase words the lobby sends", () => {
    // Exactly what `update_party` carries for a member who picked all four.
    expect(["uef", "aeon", "cybran", "seraphim"].map(factionIdFromName)).toEqual([1, 2, 3, 4]);
  });

  it("reads the capitalised names the faction picker uses", () => {
    expect(factionIdFromName("Seraphim")).toBe(4);
    expect(factionIdFromName(" Cybran ")).toBe(3);
  });

  it("knows Random, which is a faction the picker can hold", () => {
    expect(factionIdFromName("random")).toBe(5);
  });

  it("answers null for anything else, so the caller can print the word", () => {
    expect(factionIdFromName("nomads")).toBeNull();
    expect(factionIdFromName("")).toBeNull();
  });
});
