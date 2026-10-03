// The rules the mod vault applies on the client, as pure functions.
//
// The install filter is local knowledge the server has never had, so it is
// applied to whatever list is on screen: one server page in every preset but
// favourites, the whole favourites list in that one. `modsMatchingQuery` is
// the favourites preset's stand-in for the server: the API cannot filter a set
// it does not know, so the query is answered from the catalogue index instead.
// Twin of `maps/mapVaultResults.ts`.

import type { InstalledMod, ModVaultQuery, VaultMod } from "../../ipc/bindings";
import { isWithinDateRange, isWithinNumberRange } from "../../shared/filterRanges";
import { matchesVaultGlob, ratingLowerBound, vaultSearchText } from "../../shared/vaultResults";
import { modUpdateAvailable } from "./modVersions";

export type ModInstallFilter = "all" | "installed" | "available" | "updates";

export function modsPassingInstallFilter(
  source: readonly VaultMod[],
  filter: ModInstallFilter,
  installedFor: (mod: VaultMod) => InstalledMod | undefined,
): VaultMod[] {
  if (filter === "all") return [...source];
  return source.filter((mod) => {
    const installedMod = installedFor(mod);
    if (filter === "installed") return Boolean(installedMod);
    if (filter === "updates") {
      return Boolean(installedMod && modUpdateAvailable(installedMod.version, mod.version));
    }
    return !installedMod;
  });
}

/**
 * A mod vault query answered from records already in memory, filtered and
 * sorted the way `ModVaultQuery::build_filter` and `sort_param` ask the API
 * to. Every clause has its field on `VaultMod`, so nothing in the form goes
 * unapplied; the rating sort is the one approximation (see
 * `ratingLowerBound`). The page number is ignored; the caller pages the result.
 */
export function modsMatchingQuery(source: readonly VaultMod[], query: ModVaultQuery): VaultMod[] {
  const words = searchWords(query);
  const author = vaultSearchText(query.author.trim());
  const minRating = query.minRatingTenths;
  const maxRating = query.maxRatingTenths;
  const matches = source.filter((mod) => {
    if (query.recommended && !mod.recommended) return false;
    if (!matchesSearch(mod, query, words)) return false;
    if (query.author.trim() && !matchesVaultGlob(mod.author, author)) return false;
    if (query.uploaderId !== null && mod.uploaderId !== query.uploaderId) return false;
    if (query.modType && mod.modType !== query.modType) return false;
    if (query.ranked !== null && mod.ranked !== query.ranked) return false;
    // An unreviewed mod has no review summary, so a rating bound excludes it
    // on the server as well.
    if (minRating !== null || maxRating !== null) {
      if (mod.reviews <= 0 || !isWithinNumberRange(mod.ratingTenths, minRating, maxRating)) return false;
    }
    const date = query.dateFieldUpdated ? mod.updatedAt : mod.createdAt;
    return isWithinDateRange(date, query.after, query.before);
  });
  return sortMods(matches, query);
}

/**
 * The search box as the server splits it: every word has to match, and a
 * word made only of stripped characters is dropped rather than matching
 * everything. See `ModVaultQuery::search_clauses`.
 */
function searchWords(query: ModVaultQuery): string[] {
  if (query.exactName) {
    const whole = vaultSearchText(query.search.trim());
    return whole ? [whole] : [];
  }
  return query.search
    .split(/\s+/)
    .map(vaultSearchText)
    .filter((word) => word !== "");
}

function matchesSearch(mod: VaultMod, query: ModVaultQuery, words: string[]): boolean {
  if (words.length === 0) return true;
  // Exact is narrower than either scope, so it wins, as it does server side.
  if (query.exactName) return mod.displayName.toLocaleLowerCase() === words[0];
  return words.every((word) => matchesVaultGlob(mod.displayName, word)
    || (query.searchDescriptions
      && (matchesVaultGlob(mod.description, word) || matchesVaultGlob(mod.uid, word))));
}

function sortMods(mods: VaultMod[], query: ModVaultQuery): VaultMod[] {
  const direction = query.sortDescending ? -1 : 1;
  const keys = new Map<VaultMod, number>();
  if (query.sortBy !== "name") {
    for (const mod of mods) keys.set(mod, modSortKey(mod, query.sortBy));
  }
  return mods.sort((left, right) => {
    const primary = query.sortBy === "name"
      ? left.displayName.localeCompare(right.displayName)
      : (keys.get(left) ?? 0) - (keys.get(right) ?? 0);
    return primary * direction || left.displayName.localeCompare(right.displayName);
  });
}

function modSortKey(mod: VaultMod, sortBy: ModVaultQuery["sortBy"]): number {
  switch (sortBy) {
    case "rating":
      return ratingLowerBound(mod.ratingTenths, mod.reviews);
    case "newest":
      return Date.parse(mod.createdAt) || 0;
    case "updated":
      return Date.parse(mod.updatedAt) || 0;
    case "name":
      return 0;
  }
}
