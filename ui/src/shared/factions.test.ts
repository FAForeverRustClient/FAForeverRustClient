import { afterEach, describe, expect, it } from "vitest";

import { resetLocaleForTests, setLocale } from "../i18n/store";
import { factionIdFromName, factionLabel, galacticWarFactionLabel } from "./factions";

afterEach(() => {
  resetLocaleForTests();
});

describe("factionIdFromName", () => {
  it("reads the lowercase words the lobby sends", () => {
    // Exactly what `update_party` carries for a member who picked all four.
    expect(["uef", "aeon", "cybran", "seraphim"].map(factionIdFromName)).toEqual([1, 2, 3, 4]);
  });

  it("reads the capitalised names the faction picker uses", () => {
    expect(factionIdFromName("Seraphim")).toBe(4);
    expect(factionIdFromName(" Cybran ")).toBe(3);
  });

  it("reads the full Galactic War names", () => {
    expect([
      "United Earth Federation",
      "Aeon Illuminate",
      "Cybran Nation",
      "Seraphim Army",
    ].map(factionIdFromName)).toEqual([1, 2, 3, 4]);
  });

  it("knows Random, which is a faction the picker can hold", () => {
    expect(factionIdFromName("random")).toBe(5);
  });

  it("answers null for anything else, so the caller can print the word", () => {
    expect(factionIdFromName("nomads")).toBeNull();
    expect(factionIdFromName("")).toBeNull();
  });

  it("localizes TMM labels and full Galactic War faction names", () => {
    setLocale("ru");
    const names = [
      ["UEF", "United Earth Federation"],
      ["Aeon", "Aeon Illuminate"],
      ["Cybran", "Cybran Nation"],
      ["Seraphim", "Seraphim Army"],
    ] as const;

    expect([1, 2, 3, 4].map(factionLabel)).toEqual([
      "ОФЗ",
      "Эон",
      "Кибран",
      "Серафим",
    ]);
    expect(names.map(([name, fullName]) => galacticWarFactionLabel(name, fullName))).toEqual([
      "Объединённая Федерация Земли",
      "Иллюминаты Эон",
      "Нация Кибран",
      "Армия Серафим",
    ]);
  });
});
