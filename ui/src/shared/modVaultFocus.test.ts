import { describe, expect, it } from "vitest";
import { requestModVaultFocus, takeModVaultFocus } from "./modVaultFocus";

describe("modVaultFocus", () => {
  it("hands the request over exactly once", () => {
    requestModVaultFocus("Total Mayhem");

    expect(takeModVaultFocus()).toEqual({ search: "Total Mayhem", scope: "name" });
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

  it("can ask for a search beyond the name, which is how a uid is found", () => {
    requestModVaultFocus(" e2d7e6c4-3a1b ", "description");

    expect(takeModVaultFocus()).toEqual({ search: "e2d7e6c4-3a1b", scope: "description" });
  });

  it("keeps only the most recent request", () => {
    requestModVaultFocus("BlackOps Unleashed");
    requestModVaultFocus("Supreme Score Board");

    expect(takeModVaultFocus()).toEqual({ search: "Supreme Score Board", scope: "name" });
  });
});
