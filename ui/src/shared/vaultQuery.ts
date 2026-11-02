import type { MapVaultQuery, ModVaultQuery } from "../ipc/bindings";
import { INITIAL_STATE } from "../ipc/initialState";

/**
 * The unfiltered first page of the map vault, highest rated first.
 *
 * Read from the generated initial state rather than written out here: the
 * slice's `browseQuery` starts as `MapVaultQuery::default()`, so a change to
 * that default reaches the filters with the next `pnpm run bindings`.
 */
export const EMPTY_MAP_QUERY: MapVaultQuery = INITIAL_STATE.maps.browseQuery;

/** The mod vault's counterpart: `ModVaultQuery::default()`, read the same way. */
export const EMPTY_MOD_QUERY: ModVaultQuery = INITIAL_STATE.mods.browseQuery;

/**
 * Whether a page count reported for one search answers the search being asked
 * for now.
 *
 * The vault tabs page on the server: the tab sends a query, the reply carries
 * one page of results plus how many pages the whole search has, and the reply
 * also carries the query it belongs to. Between sending and arriving, the count
 * in state is the *previous* search's. That is invisible while paging inside
 * one filter and wrong the moment the filter changes: switching from a category
 * with twenty pages to one with a single page left the pager sitting there with
 * twenty buttons, and clicking one of them searched page 4 of a search that has
 * no page 4.
 *
 * So the count is used only while it belongs to the search on screen. Every
 * field but the page number takes part, which is what lets a page change keep
 * the pager rather than making it blink away and back on every click.
 */
export function sameVaultSearch<Query extends { page: number }>(
  reported: Query,
  wanted: Query,
): boolean {
  return searchIdentity(reported) === searchIdentity(wanted);
}

/// Every field except the page, in a stable order: one side is built here and
/// the other arrives from the backend, and object key order is not a promise
/// either of them makes.
function searchIdentity<Query extends { page: number }>(query: Query): string {
  const entries = Object.entries({ ...query, page: 0 });
  entries.sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

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
    query.exactName,
    query.author !== "",
    query.modType !== "",
    query.ranked !== null,
    query.minRatingTenths !== null || query.maxRatingTenths !== null,
    query.after !== "" || query.before !== "",
  ].filter(Boolean).length;
}
