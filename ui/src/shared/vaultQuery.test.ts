import { describe, expect, it } from "vitest";
import { EMPTY_MAP_QUERY, EMPTY_MOD_QUERY, sameVaultSearch } from "./vaultQuery";

describe("sameVaultSearch", () => {
  it("treats a page change inside one filter as the same search", () => {
    expect(sameVaultSearch(EMPTY_MAP_QUERY, { ...EMPTY_MAP_QUERY, page: 7 })).toBe(true);
  });

  it("retires the count when the filter changes", () => {
    expect(sameVaultSearch(EMPTY_MAP_QUERY, { ...EMPTY_MAP_QUERY, recommended: true })).toBe(false);
    expect(sameVaultSearch(EMPTY_MAP_QUERY, { ...EMPTY_MAP_QUERY, sortBy: "newest" })).toBe(false);
    expect(sameVaultSearch(EMPTY_MAP_QUERY, { ...EMPTY_MAP_QUERY, minPlayers: 2 })).toBe(false);
  });

  it("does not depend on the order the fields were written in", () => {
    const { search, page, ...rest } = EMPTY_MAP_QUERY;
    expect(sameVaultSearch(EMPTY_MAP_QUERY, { ...rest, page, search })).toBe(true);
  });

  it("reads a mod query by the same rule", () => {
    expect(sameVaultSearch(EMPTY_MOD_QUERY, { ...EMPTY_MOD_QUERY, page: 3 })).toBe(true);
    expect(sameVaultSearch(EMPTY_MOD_QUERY, { ...EMPTY_MOD_QUERY, modType: "UI" })).toBe(false);
  });
});
