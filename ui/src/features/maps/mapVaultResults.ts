// The two rules the map vault applies to a page after it arrives.
//
// Both exist because the API cannot answer them for this tab. Installed vs
// available is local knowledge the server has never had. Withdrawn versions
// it does know about, and is asked about (`latestVersion.hidden=='false'`,
// the same clause the Java client sends), but a withdrawn map came back
// through that filter anyway, so the rule is applied to what arrived rather
// than trusted to the query. The favourites preset needs it for a third
// reason: that preset answers from the catalogue index, which nothing
// filters, and a map can be withdrawn long after it was starred.
//
// The same preset is why `mapsMatchingQuery` lives here too: it answers the
// whole query locally for a set the server cannot see. And the "Recently
// downloaded" sort (#453) is a third such set, see `mapsByDownload`.

import type { MapVaultQuery, VaultMap } from "../../ipc/bindings";
import { isWithinDateRange, isWithinNumberRange } from "../../shared/filterRanges";
import { findVaultMapByFolder, mapInstalled } from "../../shared/mapPresentation";
import { matchesVaultGlob, ratingLowerBound, vaultSearchText } from "../../shared/vaultResults";

export type InstallFilter = "all" | "installed" | "available";

export interface VaultResultRules {
  /** Keep versions the author withdrew from the vault. */
  showHidden: boolean;
  /**
   * "My maps" keeps them regardless: an author is the one person who still
   * needs to see what they withdrew, and neither reference client can show
   * them.
   */
  ownMaps: boolean;
  installFilter: InstallFilter;
  /** Lower-cased installed folder names. */
  installedFolders: Set<string>;
}

export function visibleVaultMaps(source: VaultMap[], rules: VaultResultRules): VaultMap[] {
  const visible = rules.showHidden || rules.ownMaps
    ? source
    : source.filter((map) => !map.hidden);
  if (rules.installFilter === "all") return visible;
  return visible.filter(
    (map) => mapInstalled(map, rules.installedFolders) === (rules.installFilter === "installed"),
  );
}

/**
 * A map vault query answered from records already in memory, filtered and
 * sorted the way `MapVaultQuery::build_filter` and `sort_param` ask the API
 * to. The favourites preset uses it: the server cannot filter a set it does
 * not know, so the search box, author, dates, ratings, sizes and sort used to
 * do nothing there while looking as if they had.
 *
 * Every clause has its field on `VaultMap`, so nothing in the form goes
 * unapplied. The one approximation is the rating sort, whose server-side
 * property is not carried by the record: see `ratingLowerBound`. The page
 * number is ignored; the caller pages the result.
 */
export function mapsMatchingQuery(source: readonly VaultMap[], query: MapVaultQuery): VaultMap[] {
  const search = vaultSearchText(query.search.trim());
  const author = vaultSearchText(query.author.trim());
  const minRating = query.minRatingTenths;
  const maxRating = query.maxRatingTenths;
  const matches = source.filter((map) => {
    if (!query.includeHidden && map.hidden) return false;
    if (query.recommended && !map.recommended) return false;
    // `displayName` only, as the server matches it.
    if (search && !matchesVaultGlob(map.displayName, search)) return false;
    // A map with no uploader on record has no `author.login` to match.
    if (query.author.trim() && (map.author === null || !matchesVaultGlob(map.author, author))) return false;
    if (query.authorId !== null && map.authorId !== query.authorId) return false;
    if (query.ranked !== null && map.ranked !== query.ranked) return false;
    // An unreviewed map has no review summary, so a rating bound excludes it
    // on the server as well.
    if (minRating !== null || maxRating !== null) {
      if (map.reviews <= 0 || !isWithinNumberRange(map.ratingTenths, minRating, maxRating)) return false;
    }
    if (!isWithinNumberRange(map.maxPlayers, query.minPlayers, query.maxPlayers)) return false;
    if (query.width > 0 && map.width !== query.width) return false;
    if (query.height > 0 && map.height !== query.height) return false;
    return isWithinDateRange(map.createdAt, query.after, query.before);
  });
  return sortMaps(matches, query);
}

function sortMaps(maps: VaultMap[], query: MapVaultQuery): VaultMap[] {
  const direction = query.sortDescending ? -1 : 1;
  // Each key computed once per map rather than once per comparison.
  const keys = new Map<VaultMap, number>();
  if (query.sortBy !== "name") {
    for (const map of maps) keys.set(map, mapSortKey(map, query.sortBy));
  }
  return maps.sort((left, right) => {
    const primary = query.sortBy === "name"
      ? left.displayName.localeCompare(right.displayName)
      : (keys.get(left) ?? 0) - (keys.get(right) ?? 0);
    // Ties fall back to the name, so the order is the same on every render.
    return primary * direction || left.displayName.localeCompare(right.displayName);
  });
}

function mapSortKey(map: VaultMap, sortBy: MapVaultQuery["sortBy"]): number {
  switch (sortBy) {
    case "rating":
      return ratingLowerBound(map.ratingTenths, map.reviews);
    case "newest":
      return Date.parse(map.createdAt) || 0;
    case "played":
      return map.gamesPlayed;
    // The server sorts "size" on `latestVersion.width` alone.
    case "size":
      return map.width;
    case "name":
      return 0;
  }
}

/**
 * The vault maps that are on disk, matching `query`, the one downloaded last
 * first (#453). What the server cannot answer: when a map arrived is a fact
 * about this computer's map folder.
 *
 * An installed older version stands for its map, which is how the catalogue
 * lists it (#416), and a map whose folder gave no time sorts last. The
 * "recommended" flag is not applied: it is the preset the tab opens on, not a
 * choice, and it would hide most of what was downloaded.
 */
export function mapsByDownload(
  source: VaultMap[],
  installed: readonly { folderName: string; installedAt?: string | null }[],
  query: MapVaultQuery,
): VaultMap[] {
  const downloadedAt = new Map<VaultMap, number>();
  for (const map of installed) {
    const record = findVaultMapByFolder(source, map.folderName);
    if (!record) continue;
    const at = Date.parse(map.installedAt ?? "") || 0;
    downloadedAt.set(record, Math.max(downloadedAt.get(record) ?? -1, at));
  }
  return mapsMatchingQuery(source.filter((map) => downloadedAt.has(map)), { ...query, recommended: false })
    .sort((left, right) => (downloadedAt.get(right) ?? 0) - (downloadedAt.get(left) ?? 0)
      || left.displayName.localeCompare(right.displayName));
}
