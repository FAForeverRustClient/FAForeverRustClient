import { describe, expect, it } from "vitest";
import type { InstalledMod, ModVaultQuery, VaultMod } from "../../ipc/bindings";
import { EMPTY_MOD_QUERY } from "../../shared/vaultQuery";
import { modsMatchingQuery, modsPassingInstallFilter } from "./modVaultResults";

function mod(uid: string, overrides: Partial<VaultMod> = {}): VaultMod {
  return {
    modId: 1,
    versionId: 1,
    displayName: uid,
    author: "Nuggets",
    uploader: "Nuggets",
    uploaderId: 1,
    uid,
    version: "1",
    description: "",
    filename: `${uid}.zip`,
    modType: "sim",
    ranked: false,
    recommended: false,
    ratingTenths: 0,
    reviews: 0,
    createdAt: "",
    updatedAt: "",
    downloadUrl: "",
    thumbnailUrl: "",
    ...overrides,
  };
}

function installedCopy(source: VaultMod, version: string): InstalledMod {
  return {
    folderName: source.uid,
    uid: source.uid,
    displayName: source.displayName,
    version,
    author: source.author,
    description: "",
    modType: source.modType,
    enabled: true,
  };
}

const uids = (mods: VaultMod[]) => mods.map((m) => m.uid);

describe("modsPassingInstallFilter", () => {
  const current = mod("current", { version: "3" });
  const outdated = mod("outdated", { version: "5" });
  const missing = mod("missing");
  const installed = new Map([
    ["current", installedCopy(current, "3")],
    ["outdated", installedCopy(outdated, "4")],
  ]);
  const installedFor = (vault: VaultMod) => installed.get(vault.uid);
  const page = [current, outdated, missing];

  it("splits a list by what is on disk", () => {
    expect(uids(modsPassingInstallFilter(page, "all", installedFor))).toEqual(["current", "outdated", "missing"]);
    expect(uids(modsPassingInstallFilter(page, "installed", installedFor))).toEqual(["current", "outdated"]);
    expect(uids(modsPassingInstallFilter(page, "available", installedFor))).toEqual(["missing"]);
    expect(uids(modsPassingInstallFilter(page, "updates", installedFor))).toEqual(["outdated"]);
  });
});

describe("modsMatchingQuery", () => {
  // The favourites preset: what the search panel shows has to apply to the
  // starred mods as the server query would have applied it to the vault.
  const starred = [
    mod("reui", { displayName: "ReUI", author: "Crotalus", modType: "ui", ranked: true, ratingTenths: 47, reviews: 120, createdAt: "2019-01-01T00:00:00Z", updatedAt: "2024-05-01T00:00:00Z" }),
    mod("hotbuild", { displayName: "Hotbuild Overhaul", author: "Exotic", modType: "ui", ranked: true, ratingTenths: 42, reviews: 30, description: "keys like ReUI", createdAt: "2020-06-01T00:00:00Z", updatedAt: "2020-06-01T00:00:00Z" }),
    mod("blackops", { displayName: "BlackOps Unleashed", author: "Lt_hawkeye", modType: "sim", ratingTenths: 0, reviews: 0, createdAt: "2016-02-02T00:00:00Z", updatedAt: "2022-02-02T00:00:00Z" }),
  ];

  it("searches the name by default, every word required", () => {
    expect(uids(modsMatchingQuery(starred, { ...EMPTY_MOD_QUERY, search: "reui" }))).toEqual(["reui"]);
    expect(uids(modsMatchingQuery(starred, { ...EMPTY_MOD_QUERY, search: "overhaul hot" }))).toEqual(["hotbuild"]);
    expect(modsMatchingQuery(starred, { ...EMPTY_MOD_QUERY, search: "hot reui" })).toEqual([]);
  });

  it("widens to the description and uid when asked", () => {
    const query = { ...EMPTY_MOD_QUERY, search: "reui", searchDescriptions: true };
    expect(uids(modsMatchingQuery(starred, query))).toEqual(["reui", "hotbuild"]);
  });

  it("matches the whole name for an exact search", () => {
    expect(uids(modsMatchingQuery(starred, { ...EMPTY_MOD_QUERY, search: "reui", exactName: true }))).toEqual(["reui"]);
    expect(modsMatchingQuery(starred, { ...EMPTY_MOD_QUERY, search: "hotbuild", exactName: true })).toEqual([]);
  });

  it("applies creator, type and ranked", () => {
    expect(uids(modsMatchingQuery(starred, { ...EMPTY_MOD_QUERY, author: "exo" }))).toEqual(["hotbuild"]);
    expect(uids(modsMatchingQuery(starred, { ...EMPTY_MOD_QUERY, modType: "sim" }))).toEqual(["blackops"]);
    expect(uids(modsMatchingQuery(starred, { ...EMPTY_MOD_QUERY, ranked: false }))).toEqual(["blackops"]);
  });

  it("drops unreviewed mods once a rating bound is set", () => {
    const query = { ...EMPTY_MOD_QUERY, minRatingTenths: 45 };
    expect(uids(modsMatchingQuery(starred, query))).toEqual(["reui"]);
  });

  it("bounds the date field the query names", () => {
    const window = { ...EMPTY_MOD_QUERY, after: "2022-01-01", before: "2024-12-31" };
    expect(uids(modsMatchingQuery(starred, window))).toEqual(["reui", "blackops"]);
    expect(modsMatchingQuery(starred, { ...window, dateFieldUpdated: false })).toEqual([]);
  });

  it("sorts the way the query asks", () => {
    const sorted = (sortBy: ModVaultQuery["sortBy"], sortDescending = true) =>
      uids(modsMatchingQuery(starred, { ...EMPTY_MOD_QUERY, sortBy, sortDescending }));
    expect(sorted("rating")).toEqual(["reui", "hotbuild", "blackops"]);
    expect(sorted("newest")).toEqual(["hotbuild", "reui", "blackops"]);
    expect(sorted("updated")).toEqual(["reui", "blackops", "hotbuild"]);
    expect(sorted("name", false)).toEqual(["blackops", "hotbuild", "reui"]);
  });
});
