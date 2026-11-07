import { describe, expect, it } from "vitest";
import { DEFAULT_MAP_FILTERS, MAP_FILTER_CHOICES, type VaultPreset } from "./mapVaultFilters";
import { DEFAULT_MOD_FILTERS, MOD_FILTER_CHOICES, type ModPreset } from "../mods/modVaultFilters";
import { decodeVaultSearch, encodeVaultSearch } from "../../shared/vaultSavedSearches";

describe("named vault searches", () => {
  it("round-trips map filters and their category without storing an account ID or page", () => {
    const value = { category: "favorites" as VaultPreset, filters: { ...DEFAULT_MAP_FILTERS, author: "Mapper", width: 1024, showHidden: true, minimumPlayers: 4, sort: "played" as const } };
    expect(decodeVaultSearch(encodeVaultSearch(value), DEFAULT_MAP_FILTERS, ["all", "favorites"], MAP_FILTER_CHOICES)).toEqual(value);
  });
  it("round-trips mod scope, installation, dates and sorting", () => {
    const value = { category: "all" as ModPreset, filters: { ...DEFAULT_MOD_FILTERS, search: "ReUI", searchScope: "exact" as const, installFilter: "updates" as const, dateAfter: "2025-01-01", sort: "name" as const } };
    expect(decodeVaultSearch(encodeVaultSearch(value), DEFAULT_MOD_FILTERS, ["all"], MOD_FILTER_CHOICES)).toEqual(value);
  });
  it("uses defaults for added fields, drops unknown properties and has stable signatures", () => {
    const saved = JSON.stringify({ version: 1, category: "all", filters: { search: "Setons", unknown: "ignored" } });
    expect(decodeVaultSearch(saved, DEFAULT_MAP_FILTERS, ["all"], MAP_FILTER_CHOICES)).toEqual({ category: "all", filters: { ...DEFAULT_MAP_FILTERS, search: "Setons" } });
    expect(encodeVaultSearch({ category: "all", filters: { author: "a", search: "b" } })).toBe(encodeVaultSearch({ category: "all", filters: { search: "b", author: "a" } }));
  });
  it.each(["null", "[]", "not json", '{"version":99,"category":"all","filters":{}}', '{"version":1,"category":"all","filters":{"sort":"unknown"}}', '{"version":1,"category":"all","filters":{"minimumPlayers":1.5}}', '{"version":1,"category":"all","filters":{"createdAfter":"yesterday"}}'])("rejects invalid saved data: %s", (saved) => {
    expect(decodeVaultSearch(saved, DEFAULT_MAP_FILTERS, ["all"], MAP_FILTER_CHOICES)).toBeNull();
  });
});
