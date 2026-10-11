import type { ModVaultQuery } from "../../ipc/bindings";
import type { ModInstallFilter } from "./modVaultResults";
import type { MessageKey } from "../../i18n";
import { EMPTY_MOD_QUERY, sameVaultSearch } from "../../shared/vaultQuery";

export type ModSort = "rating" | "newest" | "updated" | "name";
export type ModTypeFilter = "all" | "ui" | "sim";
export type RankedFilter = "all" | "ranked" | "unranked";
export type InstallFilter = ModInstallFilter;
export type ModPreset = "recommended" | "favorites" | "mine" | "rating" | "ui" | "newest" | "all";
export type DateField = "updated" | "uploaded";

export const MOD_SORTS: readonly ModSort[] = ["rating", "newest", "updated", "name"];

/** The sort a preset brings with it when nothing else has been chosen. */
export function presetSort(preset: ModPreset): ModSort {
  if (preset === "newest" || preset === "mine") return "newest";
  if (preset === "all") return "name";
  return "rating";
}

export function storedModSort(value: string): ModSort | null {
  return (MOD_SORTS as readonly string[]).includes(value) ? (value as ModSort) : null;
}
export const MOD_PRESETS: Array<[ModPreset, MessageKey]> = [
  ["recommended", "mods.view.preset.recommended"],
  ["favorites", "mods.view.preset.favorites"],
  // Only once there is an id to filter on: see `modVaultQuery`.
  ["mine", "mods.view.preset.mine"],
  ["rating", "mods.view.preset.rating"],
  ["ui", "mods.view.preset.ui"],
  ["newest", "mods.view.preset.newest"],
  ["all", "mods.view.preset.all"],
];

/**
 * Where the search box is allowed to match.
 *
 * "name" is the floor, and the reported bug: searching "reui" against the
 * description returned every mod that mentions ReUI in prose, with the mods
 * actually called ReUI somewhere in the middle of them. Prose is still worth
 * searching, so it is a choice in the search panel rather than a default.
 */
export type ModSearchScope = "name" | "description" | "exact";

export interface ModFilterState {
  search: string;
  searchScope: ModSearchScope;
  creator: string;
  sort: ModSort;
  modType: ModTypeFilter;
  ranked: RankedFilter;
  installFilter: InstallFilter;
  dateField: DateField;
  dateAfter: string;
  dateBefore: string;
  minimumRating: number | null;
  maximumRating: number | null;
}

/**
 * The tab's filter state as the API query it stands for. See `MapsView`.
 */
export function modVaultQuery(
  applied: ModFilterState,
  preset: ModPreset,
  page: number,
  playerId: number | null,
  pageSize: number,
): ModVaultQuery {
  const sortBy: ModVaultQuery["sortBy"] = applied.sort === "newest" ? "newest"
    : applied.sort === "updated" ? "updated"
      : applied.sort === "name" ? "name"
        : "rating";
  // The `ui` preset is a type filter, not a sort.
  const modType = preset === "ui" ? "ui" : applied.modType === "all" ? "" : applied.modType;
  return {
    ...EMPTY_MOD_QUERY,
    search: applied.search.trim(),
    exactName: applied.searchScope === "exact",
    searchDescriptions: applied.searchScope === "description",
    author: applied.creator.trim(),
    // The uploader, not the declared author: see `ModVaultQuery::uploader_id`.
    // Unlike the map vault this asks for no hidden versions, because nothing
    // here could put one back (`ModVersion.hidden` is an administrator's field
    // alone), so listing them would only be a dead end.
    uploaderId: preset === "mine" && playerId !== null ? playerId : null,
    modType,
    ranked: applied.ranked === "all" ? null : applied.ranked === "ranked",
    recommended: preset === "recommended",
    minRatingTenths: applied.minimumRating === null ? null : Math.round(applied.minimumRating * 10),
    maxRatingTenths: applied.maximumRating === null ? null : Math.round(applied.maximumRating * 10),
    dateFieldUpdated: applied.dateField === "updated",
    after: applied.dateAfter,
    before: applied.dateBefore,
    sortBy,
    sortDescending: sortBy !== "name",
    page,
    pageSize,
  };
}

/**
 * The filter form a query was built from, read back from the query.
 *
 * Tabs are unmounted when they lose focus, so a form kept only in this view
 * was empty again every time the reader came back. The last query the backend
 * ran (`state.mods.browseQuery`) outlives the view, as the replay tab's
 * `vaultQuery` does, so the form is seeded from it. `null` when nothing has
 * been searched this session, which leaves the defaults in place.
 *
 * The install filter is not part of the query (it is applied to the page in
 * the client), so it starts at "all" again.
 */
export function modFilterFromQuery(query: ModVaultQuery, preset: ModPreset): ModFilterState | null {
  if (sameVaultSearch(query, EMPTY_MOD_QUERY) && query.page === EMPTY_MOD_QUERY.page) return null;
  return {
    search: query.search,
    searchScope: query.exactName ? "exact" : query.searchDescriptions ? "description" : "name",
    creator: query.author,
    sort: query.sortBy,
    // The `ui` preset is sent as a type filter; it is the preset's, not the form's.
    modType: preset === "ui" || (query.modType !== "ui" && query.modType !== "sim") ? "all" : query.modType,
    ranked: query.ranked === null ? "all" : query.ranked ? "ranked" : "unranked",
    installFilter: "all",
    dateField: query.dateFieldUpdated ? "updated" : "uploaded",
    dateAfter: query.after,
    dateBefore: query.before,
    minimumRating: query.minRatingTenths === null ? null : query.minRatingTenths / 10,
    maximumRating: query.maxRatingTenths === null ? null : query.maxRatingTenths / 10,
  };
}

