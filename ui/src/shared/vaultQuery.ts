import type { MapVaultQuery, ModVaultQuery } from "../ipc/bindings";

/**
 * The unfiltered first page, matching `MapVaultQuery::default()` in the domain.
 *
 * These two must stay identical: the conformance fixture compares the store's
 * initial state against `AppState::default()` field by field, so a drift here
 * fails that test rather than shipping.
 */
export const EMPTY_MAP_QUERY: MapVaultQuery = {
  search: "",
  author: "",
  ranked: null,
  recommended: false,
  minRatingTenths: null,
  maxRatingTenths: null,
  minPlayers: null,
  maxPlayers: null,
  width: 0,
  height: 0,
  after: "",
  before: "",
  sortBy: "rating",
  sortDescending: true,
  page: 1,
  pageSize: 36,
};

export const EMPTY_MOD_QUERY: ModVaultQuery = {
  search: "",
  author: "",
  modType: "",
  ranked: null,
  recommended: false,
  minRatingTenths: null,
  maxRatingTenths: null,
  dateFieldUpdated: true,
  after: "",
  before: "",
  sortBy: "rating",
  sortDescending: true,
  page: 1,
  pageSize: 36,
};

/**
 * How many filters the user set beyond the plain search box, for the "N active"
 * badge on the advanced panel. Sort, page and page size are not filters.
 */
export function activeMapFilterCount(query: MapVaultQuery): number {
  return [
    query.author !== "",
    query.ranked !== null,
    query.minRatingTenths !== null || query.maxRatingTenths !== null,
    query.minPlayers !== null || query.maxPlayers !== null,
    query.width > 0,
    query.height > 0,
    query.after !== "" || query.before !== "",
  ].filter(Boolean).length;
}

export function activeModFilterCount(query: ModVaultQuery): number {
  return [
    query.author !== "",
    query.modType !== "",
    query.ranked !== null,
    query.minRatingTenths !== null || query.maxRatingTenths !== null,
    query.after !== "" || query.before !== "",
  ].filter(Boolean).length;
}
