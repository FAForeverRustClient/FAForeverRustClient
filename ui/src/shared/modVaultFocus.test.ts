import { describe, expect, it } from "vitest";
import { requestModVaultFocus, takeModVaultFocus } from "./modVaultFocus";

describe("modVaultFocus", () => {
  it("hands the request over exactly once", () => {
    requestModVaultFocus("Total Mayhem");

    expect(takeModVaultFocus()).toBe("Total Mayhem");
    // Coming back to the tab later must not repeat a search nobody asked for.
    expect(takeModVaultFocus()).toBeNull();
  });

  it("reports nothing when the tab was opened on its own", () => {
    expect(takeModVaultFocus()).toBeNull();
  });

  it("treats a blank name as no request", () => {
    requestModVaultFocus("   ");

    expect(takeModVaultFocus()).toBeNull();
  });

  it("keeps only the most recent request", () => {
    requestModVaultFocus("BlackOps Unleashed");
    requestModVaultFocus("Supreme Score Board");

    expect(takeModVaultFocus()).toBe("Supreme Score Board");
  });
});
