import { describe, expect, it } from "vitest";
import { hasMapVaultFocus, requestMapVaultFocus, takeMapVaultFocus } from "./mapVaultFocus";

describe("mapVaultFocus", () => {
  it("hands the request over exactly once", () => {
    requestMapVaultFocus({ name: "Seton's Clutch", folderName: "setons_clutch.v0004" });

    expect(hasMapVaultFocus()).toBe(true);
    expect(takeMapVaultFocus()).toEqual({ name: "Seton's Clutch", folderName: "setons_clutch.v0004" });
    // Coming back to the tab later must not repeat a jump nobody asked for.
    expect(hasMapVaultFocus()).toBe(false);
    expect(takeMapVaultFocus()).toBeNull();
  });

  it("reports nothing when the tab was opened on its own", () => {
    expect(takeMapVaultFocus()).toBeNull();
  });

  it("treats a blank name as no request", () => {
    requestMapVaultFocus({ name: "   ", folderName: "setons_clutch.v0004" });

    expect(takeMapVaultFocus()).toBeNull();
  });

  it("keeps only the most recent request", () => {
    requestMapVaultFocus({ name: "Dual Gap", folderName: "dual_gap.v0003" });
    requestMapVaultFocus({ name: " Broken Vows ", folderName: " broken_vows.v0008 " });

    expect(takeMapVaultFocus()).toEqual({ name: "Broken Vows", folderName: "broken_vows.v0008" });
  });
});
