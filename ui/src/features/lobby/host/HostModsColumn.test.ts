import { describe, expect, it } from "vitest";

import type { InstalledMod } from "../../../ipc/bindings";
import { filterAndSortHostMods } from "./HostModsColumn";

function makeMod(fields: Partial<InstalledMod> & { uid: string; displayName: string }): InstalledMod {
  return {
    folderName: fields.uid,
    version: "1",
    author: "Author",
    description: "Mod description",
    modType: "ui",
    enabled: false,
    ...fields,
  };
}

describe("filterAndSortHostMods", () => {
  it("puts the active mods first, each group alphabetically by display name", () => {
    const mods: InstalledMod[] = [
      makeMod({ uid: "mod-z", displayName: "Zeppelin UI", enabled: true }),
      makeMod({ uid: "mod-a", displayName: "Auto Reclaim", enabled: false }),
      makeMod({ uid: "mod-m", displayName: "Mini Map Zoom", enabled: true }),
      makeMod({ uid: "mod-b", displayName: "Better Eco", enabled: false }),
    ];

    const result = filterAndSortHostMods(mods, "ui", "");
    expect(result.map((m) => m.displayName)).toEqual([
      "Mini Map Zoom",
      "Zeppelin UI",
      "Auto Reclaim",
      "Better Eco",
    ]);
  });

  it("keeps a held mod in the place it had, whichever way it was switched", () => {
    const initialMods: InstalledMod[] = [
      makeMod({ uid: "mod-1", displayName: "Alpha Mod", enabled: true }),
      makeMod({ uid: "mod-2", displayName: "Beta Mod", enabled: false }),
      makeMod({ uid: "mod-3", displayName: "Gamma Mod", enabled: false }),
    ];
    const initialOrder = filterAndSortHostMods(initialMods, "ui", "").map((m) => m.uid);
    expect(initialOrder).toEqual(["mod-1", "mod-2", "mod-3"]);

    // Alpha switched off and Gamma on, each from its own checkbox: each sorts
    // as it did before the click, so neither moves.
    const updatedMods = initialMods.map((mod) => ({
      ...mod,
      enabled: mod.uid === "mod-3" ? true : mod.uid === "mod-1" ? false : mod.enabled,
    }));
    const held = new Map([
      ["mod-1", true],
      ["mod-3", false],
    ]);
    expect(filterAndSortHostMods(updatedMods, "ui", "", held).map((m) => m.uid)).toEqual(initialOrder);

    // Once the list settles (nothing held), the new state decides.
    expect(filterAndSortHostMods(updatedMods, "ui", "").map((m) => m.uid)).toEqual(["mod-3", "mod-1", "mod-2"]);
  });

  it("filters by mod tab (ui vs sim)", () => {
    const mods: InstalledMod[] = [
      makeMod({ uid: "ui-1", displayName: "UI Mod", modType: "ui" }),
      makeMod({ uid: "sim-1", displayName: "Sim Mod", modType: "sim" }),
    ];

    expect(filterAndSortHostMods(mods, "ui", "").map((m) => m.uid)).toEqual(["ui-1"]);
    expect(filterAndSortHostMods(mods, "sim", "").map((m) => m.uid)).toEqual(["sim-1"]);
  });

  it("filters by search term matching display name", () => {
    const mods: InstalledMod[] = [
      makeMod({ uid: "mod-1", displayName: "Eco Manager" }),
      makeMod({ uid: "mod-2", displayName: "Smart Select" }),
      makeMod({ uid: "mod-3", displayName: "Eco Radar" }),
    ];

    const result = filterAndSortHostMods(mods, "ui", "eco");
    expect(result.map((m) => m.displayName)).toEqual(["Eco Manager", "Eco Radar"]);
  });

  it("uses uid as tie-breaker for identical display names", () => {
    const mods: InstalledMod[] = [
      makeMod({ uid: "mod-b", displayName: "Duplicate Name" }),
      makeMod({ uid: "mod-a", displayName: "Duplicate Name" }),
    ];

    const result = filterAndSortHostMods(mods, "ui", "");
    expect(result.map((m) => m.uid)).toEqual(["mod-a", "mod-b"]);
  });
});
