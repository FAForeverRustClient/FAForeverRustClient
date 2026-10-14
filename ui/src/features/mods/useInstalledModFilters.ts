// The installed library's filters: the search fields and the sort, the preset
// chips and the fields each one sets, and the mods all of it narrows the
// library to.

import { useMemo, useState } from "react";
import type { InstalledMod, VaultMod } from "../../ipc/bindings";
import { includesNormalized, isWithinNumberRange } from "../../shared/filterRanges";
import { useRememberedFilters } from "../../shared/filterMemory";
import { isFavoriteMod } from "./favoriteMods";
import { modUpdateAvailable } from "./modVersions";

export type ModTypeFilter = "all" | "ui" | "sim";
export type EnabledFilter = "all" | "enabled" | "disabled";
export type RankedFilter = "all" | "ranked" | "unranked";
export type InstalledModPreset = "all" | "favorites" | "enabled" | "disabled" | "ui" | "sim" | "updates";
export type InstalledModSort = "state" | "name" | "rating" | "newest" | "author";

/** Where the library's filters are remembered (#447), and where they start. */
const INSTALLED_MOD_FILTERS = "mods.installed";
const NO_INSTALLED_MOD_FILTERS = {
  search: "",
  creator: "",
  preset: "all" as InstalledModPreset,
  modType: "all" as ModTypeFilter,
  enabled: "all" as EnabledFilter,
  ranked: "all" as RankedFilter,
  minimumRating: null as number | null,
  maximumRating: null as number | null,
};

export type InstalledModFilters = ReturnType<typeof useInstalledModFilters>;

export function useInstalledModFilters({
  installed,
  vaultFor,
  favorites,
  favoriteCount,
}: {
  installed: InstalledMod[];
  /** The vault's record of an installed mod, by its counterpart: see `modIdentity`. */
  vaultFor: (mod: InstalledMod) => VaultMod | undefined;
  favorites: ReadonlySet<string>;
  /** The starred mods that are installed. */
  favoriteCount: number;
}) {
  // The filters, remembered as the setting says (#447). The sort is not one.
  const { filters, setFilter } = useRememberedFilters(INSTALLED_MOD_FILTERS, NO_INSTALLED_MOD_FILTERS);
  const { search, creator, preset, modType, enabled, ranked, minimumRating, maximumRating } = filters;
  const setSearch = (value: string) => setFilter("search", value);
  const setCreator = (value: string) => setFilter("creator", value);
  const setPreset = (value: InstalledModPreset) => setFilter("preset", value);
  const setModType = (value: ModTypeFilter) => setFilter("modType", value);
  const setEnabled = (value: EnabledFilter) => setFilter("enabled", value);
  const setRanked = (value: RankedFilter) => setFilter("ranked", value);
  const setMinimumRating = (value: number | null) => setFilter("minimumRating", value);
  const setMaximumRating = (value: number | null) => setFilter("maximumRating", value);
  const [sort, setSort] = useState<InstalledModSort>("state");

  const choosePreset = (next: InstalledModPreset) => {
    setPreset(next);
    if (next === "enabled") {
      setEnabled("enabled");
      setModType("all");
    } else if (next === "disabled") {
      setEnabled("disabled");
      setModType("all");
    } else if (next === "ui") {
      setModType("ui");
      setEnabled("all");
    } else if (next === "sim") {
      setModType("sim");
      setEnabled("all");
    } else if (next === "all" || next === "favorites") {
      setEnabled("all");
      setModType("all");
    }
  };

  const clearSearch = () => {
    setSearch("");
    setCreator("");
    setPreset("all");
    setSort("state");
    setModType("all");
    setEnabled("all");
    setRanked("all");
    setMinimumRating(null);
    setMaximumRating(null);
  };

  // What "More filters" holds that is not at its default. The type and the
  // state count only where they differ from what the chosen preset set them
  // to: the UI preset is a type filter already, and saying so twice would
  // send the reader looking for a filter they did not set.
  const presetType: ModTypeFilter = preset === "ui" || preset === "sim" ? preset : "all";
  const presetEnabled: EnabledFilter = preset === "enabled" || preset === "disabled" ? preset : "all";
  const hiddenFilterCount = Number(modType !== presetType)
    + Number(enabled !== presetEnabled)
    + Number(ranked !== "all")
    + Number(minimumRating !== null || maximumRating !== null);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const creatorQuery = creator.trim().toLocaleLowerCase();

    return installed
      .filter((mod) => {
        const meta = vaultFor(mod);
        const isRankedMod = meta?.ranked ?? false;
        const hasUpdate = meta && modUpdateAvailable(mod.version, meta.version);

        // The chip disappears with the last star, so the filter behind it has
        // to as well: otherwise un-starring everything leaves the list empty
        // with no visible filter to explain it.
        if (preset === "favorites" && favoriteCount > 0 && !isFavoriteMod(favorites, mod.uid)) {
          return false;
        }
        if (preset === "enabled" && !mod.enabled) return false;
        if (preset === "disabled" && mod.enabled) return false;
        if (preset === "ui" && mod.modType !== "ui") return false;
        if (preset === "sim" && mod.modType !== "sim") return false;
        if (preset === "updates" && !hasUpdate) return false;

        if (modType !== "all" && mod.modType !== modType) return false;
        if (enabled !== "all" && mod.enabled !== (enabled === "enabled")) return false;

        if (ranked === "ranked" && !isRankedMod) return false;
        if (ranked === "unranked" && isRankedMod) return false;

        if (creatorQuery) {
          const authorMatch = includesNormalized(mod.author, creatorQuery)
            || (meta && (includesNormalized(meta.author, creatorQuery) || includesNormalized(meta.uploader, creatorQuery)));
          if (!authorMatch) return false;
        }

        if (minimumRating !== null || maximumRating !== null) {
          if (!meta) return false;
          if (!isWithinNumberRange(meta.ratingTenths / 10, minimumRating, maximumRating)) return false;
        }

        if (query) {
          const matches = [
            mod.displayName,
            mod.author,
            mod.description ?? "",
            mod.uid,
            mod.folderName,
            meta?.displayName ?? "",
            meta?.description ?? "",
          ].some((val) => val.toLocaleLowerCase().includes(query));
          if (!matches) return false;
        }

        return true;
      })
      .slice()
      .sort((left, right) => {
        const metaLeft = vaultFor(left);
        const metaRight = vaultFor(right);

        switch (sort) {
          case "state":
            return (
              Number(right.enabled) - Number(left.enabled)
              || left.displayName.localeCompare(right.displayName)
            );
          case "name":
            return left.displayName.localeCompare(right.displayName);
          case "rating":
            return (metaRight?.ratingTenths ?? 0) - (metaLeft?.ratingTenths ?? 0);
          case "newest":
            return (Date.parse(metaRight?.createdAt ?? "") || 0) - (Date.parse(metaLeft?.createdAt ?? "") || 0);
          case "author":
            return (left.author ?? "").localeCompare(right.author ?? "");
        }
      });
  }, [
    installed, search, creator, preset, sort, modType, enabled, ranked,
    minimumRating, maximumRating, vaultFor, favorites, favoriteCount,
  ]);

  return {
    search,
    setSearch,
    creator,
    setCreator,
    preset,
    choosePreset,
    modType,
    setModType,
    enabled,
    setEnabled,
    ranked,
    setRanked,
    minimumRating,
    setMinimumRating,
    maximumRating,
    setMaximumRating,
    sort,
    setSort,
    clearSearch,
    hiddenFilterCount,
    filtered,
  };
}
