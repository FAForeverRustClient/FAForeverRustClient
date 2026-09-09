import { describe, expect, it } from "vitest";
import { modUpdateAvailable } from "./modVersions";

describe("modUpdateAvailable", () => {
  it("reports a newer version in the vault", () => {
    expect(modUpdateAvailable("11", "12")).toBe(true);
    expect(modUpdateAvailable("1.2", "1.10")).toBe(true);
  });

  it("does not report the same version written differently", () => {
    // `mod_info.lua` says `version = 3.0`; the API stores the number 3.
    expect(modUpdateAvailable("3.0", "3")).toBe(false);
    expect(modUpdateAvailable("3", "3.0")).toBe(false);
    expect(modUpdateAvailable(" 12 ", "12")).toBe(false);
  });

  it("does not offer to overwrite a copy that is ahead of the vault", () => {
    expect(modUpdateAvailable("13", "12")).toBe(false);
    expect(modUpdateAvailable("2.0.1", "2.0.0")).toBe(false);
  });

  it("orders version text with a numeric collation", () => {
    expect(modUpdateAvailable("v1.9", "v1.10")).toBe(true);
    expect(modUpdateAvailable("v1.10", "v1.9")).toBe(false);
  });

  it("says nothing when either side has no version", () => {
    expect(modUpdateAvailable("", "12")).toBe(false);
    expect(modUpdateAvailable("12", "")).toBe(false);
    expect(modUpdateAvailable("", "")).toBe(false);
  });
});
