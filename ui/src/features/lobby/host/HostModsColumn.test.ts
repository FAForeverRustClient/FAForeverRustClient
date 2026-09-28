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
  it("sorts mods alphabetically by display name regardless of enabled status", () => {
    const mods: InstalledMod[] = [
      makeMod({ uid: "mod-z", displayName: "Zeppelin UI", enabled: true }),
      makeMod({ uid: "mod-a", displayName: "Auto Reclaim", enabled: false }),
      makeMod({ uid: "mod-m", displayName: "Mini Map Zoom", enabled: true }),
      makeMod({ uid: "mod-b", displayName: "Better Eco", enabled: false }),
    ];

    const result = filterAndSortHostMods(mods, "ui", "");
    expect(result.map((m) => m.displayName)).toEqual([
      "Auto Reclaim",
      "Better Eco",
      "Mini Map Zoom",
      "Zeppelin UI",
    ]);
  });

  it("preserves stable item order when a mod is enabled or disabled", () => {
    const initialMods: InstalledMod[] = [
      makeMod({ uid: "mod-1", displayName: "Alpha Mod", enabled: false }),
      makeMod({ uid: "mod-2", displayName: "Beta Mod", enabled: false }),
      makeMod({ uid: "mod-3", displayName: "Gamma Mod", enabled: false }),
    ];

    const initialOrder = filterAndSortHostMods(initialMods, "ui", "").map((m) => m.uid);

    // Toggling the last mod to enabled must not jump it to the top of the list.
    const updatedMods = initialMods.map((mod) =>
      mod.uid === "mod-3" ? { ...mod, enabled: true } : mod,
    );
    const updatedOrder = filterAndSortHostMods(updatedMods, "ui", "").map((m) => m.uid);

    expect(updatedOrder).toEqual(initialOrder);
    expect(updatedOrder).toEqual(["mod-1", "mod-2", "mod-3"]);
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
