import { describe, expect, it } from "vitest";
import { hostWhitelist, isWhitelistedHost, shownDespiteFilters } from "./hostWhitelist";

describe("the host whitelist", () => {
  const whitelist = hostWhitelist(["Nuggets", " aurora ", ""]);

  it("finds a host in any case", () => {
    expect(isWhitelistedHost("nuggets", whitelist)).toBe(true);
    expect(isWhitelistedHost("AURORA", whitelist)).toBe(true);
    expect(isWhitelistedHost("Zed", whitelist)).toBe(false);
  });

  it("is never matched by an empty host", () => {
    expect(isWhitelistedHost("", whitelist)).toBe(false);
  });

  it("keeps a whitelisted host's game that the filters would hide", () => {
    expect(shownDespiteFilters("Nuggets", whitelist, () => false)).toBe(true);
  });

  it("leaves every other game to the filters", () => {
    expect(shownDespiteFilters("Zed", whitelist, () => false)).toBe(false);
    expect(shownDespiteFilters("Zed", whitelist, () => true)).toBe(true);
  });

  it("does nothing while it is empty", () => {
    const empty = hostWhitelist([]);
    expect(shownDespiteFilters("Nuggets", empty, () => false)).toBe(false);
  });
});
