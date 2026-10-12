import type { MapVaultQuery } from "../../ipc/bindings";
import type { RankedFilter } from "./mapFilterDraft";
import type { InstallFilter } from "./mapVaultResults";
import { EMPTY_MAP_QUERY, sameVaultSearch } from "../../shared/vaultQuery";

export type VaultSort = "rating" | "newest" | "played" | "name" | "size" | "downloaded";
export type VaultPreset = "recommended" | "favorites" | "mine" | "rating" | "newest" | "played" | "all";



export const VAULT_SORTS: readonly VaultSort[] = ["rating", "newest", "played", "name", "size", "downloaded"];

/** The sort a preset brings with it when nothing else has been chosen. */
export function presetSort(preset: VaultPreset): VaultSort {
  if (preset === "newest" || preset === "mine") return "newest";
  if (preset === "played") return "played";
  if (preset === "all") return "name";
  return "rating";
}

export function storedVaultSort(value: string): VaultSort | null {
  return (VAULT_SORTS as readonly string[]).includes(value) ? (value as VaultSort) : null;
}

export interface MapFilterState {
  search: string;
  author: string;
  sort: VaultSort;
  ranked: RankedFilter;
  installFilter: InstallFilter;
  createdAfter: string;
  createdBefore: string;
  /** Show versions the author withdrew from the vault. Off by default. */
  showHidden: boolean;
  minimumRating: number | null;
  maximumRating: number | null;
  minimumPlayers: number | null;
  maximumPlayers: number | null;
  width: number;
  height: number;
}

/**
 * The tab's filter state as the API query it stands for.
 *
 * The presets are sorts plus two flags the API models elsewhere: `recommended`
 * on the map itself, and `mine`, which narrows to one author (mirrors Java's
 * `SearchType.OWN`, which filters `map.author.id`) and always asks for hidden
 * versions, because an author is the one person who needs to see what they
 * withdrew. Everywhere else the "Withdrawn versions" filter decides.
 * `favorites` has no server equivalent and is handled by the caller.
 */
export function mapVaultQuery(
  applied: MapFilterState,
  preset: VaultPreset,
  page: number,
  playerId: number | null,
  pageSize: number,
): MapVaultQuery {
  const sortBy: MapVaultQuery["sortBy"] = applied.sort === "size" ? "size"
    : applied.sort === "name" ? "name"
      : applied.sort === "played" ? "played"
        : applied.sort === "newest" ? "newest"
          : "rating";
  const mine = preset === "mine" && playerId !== null;
  return {
    ...EMPTY_MAP_QUERY,
    search: applied.search.trim(),
    author: applied.author.trim(),
    authorId: mine ? playerId : null,
    includeHidden: mine || applied.showHidden,
    ranked: applied.ranked === "all" ? null : applied.ranked === "ranked",
    recommended: preset === "recommended",
    // The domain carries review scores in tenths so the whole state stays
    // comparable; the sliders are in stars.
    minRatingTenths: applied.minimumRating === null ? null : Math.round(applied.minimumRating * 10),
    maxRatingTenths: applied.maximumRating === null ? null : Math.round(applied.maximumRating * 10),
    minPlayers: applied.minimumPlayers,
    maxPlayers: applied.maximumPlayers,
    width: applied.width,
    height: applied.height,
    after: applied.createdAfter,
    before: applied.createdBefore,
    sortBy,
    // Name ascending, everything else best/newest/most first.
    sortDescending: sortBy !== "name",
    page,
    pageSize: pageSize,
  };
}

/**
 * The filter form a query was built from, read back from the query, so the
 * vault comes back from another tab with its search where it was left. The
 * twin of `modFilterFromQuery` in ModsView, which explains why. `null` when
 * nothing has been searched this session. The install filter is applied in
 * the client and not carried by the query, so it starts at "all" again.
 */
export function mapFilterFromQuery(query: MapVaultQuery, preset: VaultPreset): MapFilterState | null {
  if (sameVaultSearch(query, EMPTY_MAP_QUERY) && query.page === EMPTY_MAP_QUERY.page) return null;
  return {
    search: query.search,
    author: query.author,
    sort: query.sortBy,
    ranked: query.ranked === null ? "all" : query.ranked ? "ranked" : "unranked",
    installFilter: "all",
    createdAfter: query.after,
    createdBefore: query.before,
    // "My maps" always asks for withdrawn versions; that is the preset's, not
    // the "Withdrawn versions" box's.
    showHidden: preset !== "mine" && query.includeHidden,
    minimumRating: query.minRatingTenths === null ? null : query.minRatingTenths / 10,
    maximumRating: query.maxRatingTenths === null ? null : query.maxRatingTenths / 10,
    minimumPlayers: query.minPlayers,
    maximumPlayers: query.maxPlayers,
    width: query.width,
    height: query.height,
  };
}

