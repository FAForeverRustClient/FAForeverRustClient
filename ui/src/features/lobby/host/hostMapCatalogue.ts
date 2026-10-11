// The host dialog's map catalogue and the map picker's filters, as pure
// functions over the store's map lists. `HostGameModal` memoises each step on
// what it depends on; see the comment there for why it is three steps.

import type { InstalledMap, VaultMap } from "../../../ipc/bindings";
import { t as translate } from "../../../i18n";
import {
  findVaultMapByFolder,
  isGeneratedMap,
  isOfficialMap,
  kilometresArea,
  OFFICIAL_BASE_MAPS,
} from "../../../shared/mapPresentation";

/** Map cells per kilometre, the engine's scale. */
const CELLS_PER_KM = 51.2;

export const toKilometres = (cells: number) => Math.round(cells / CELLS_PER_KM);

/** Bounds for the map filter's sliders. 80 km is the largest map FA ships. */
export const MAX_MAP_KM = 80;
export const MAX_MAP_PLAYERS = 16;

export type Range = { low: number | null; high: number | null };

export const NO_RANGE: Range = { low: null, high: null };

export const isBounded = (range: Range) => range.low !== null || range.high !== null;

/** A value passes when it is inside the range, or when it is simply unknown. */
export function withinRange(value: number, range: Range): boolean {
  if (value <= 0) return true;
  if (range.low !== null && value < range.low) return false;
  return !(range.high !== null && value > range.high);
}

export type HostMap = {
  displayName: string;
  folderName: string;
  maxPlayers: number;
  width: number;
  height: number;
  description?: string;
  version?: string;
  author?: string | null;
  /** Whether games on it count towards ratings. Base maps always do. */
  ranked: boolean;
};

/** Which maps the ranked filter lets through. */
export type RankedFilter = "all" | "ranked" | "unranked";

/** Everything the map picker narrows or shows the list by. */
export interface MapPickerFilters {
  mapSearch: string;
  rankedFilter: RankedFilter;
  widthKm: Range;
  heightKm: Range;
  playerCount: Range;
  filtersOpen: boolean;
  /** Which half of the list is on screen. */
  mapTab: "all" | "favorites";
}

export const NO_PICKER_FILTERS: MapPickerFilters = {
  mapSearch: "",
  rankedFilter: "all",
  widthKm: NO_RANGE,
  heightKm: NO_RANGE,
  playerCount: NO_RANGE,
  filtersOpen: false,
  mapTab: "all",
};

/** Show compact metadata for map rows. */
export function formatMapMeta(map: { maxPlayers: number; width: number; height: number }): string {
  const parts: string[] = [];
  if (map.maxPlayers > 0) {
    parts.push(translate("lobby.host.mapPlayersShort", { count: map.maxPlayers }));
  }
  if (map.width > 0 && map.height > 0) {
    parts.push(kilometresArea(toKilometres(map.width), toKilometres(map.height)));
  }
  return parts.join(" · ");
}

// The base-game table is a module constant, so its two lookup indexes are
// built once for the process rather than once per render of the dialog.
const OFFICIAL_BY_FOLDER = new Map(
  OFFICIAL_BASE_MAPS.map((base) => [base.folderName.toLowerCase(), base]),
);
const OFFICIAL_BY_NAME = new Map(
  OFFICIAL_BASE_MAPS.map((base) => [base.displayName.toLowerCase(), base]),
);

/** Map dimensions in kilometres, which is the unit players actually use. */
export function formatMapDimensions(width: number, height: number): string {
  if (width <= 0) return "";
  return kilometresArea(toKilometres(width), toKilometres(height));
}

/** The vault with a by-name index over it, rebuilt only when the vault loads. */
export interface VaultIndex {
  maps: VaultMap[];
  byName: Map<string, VaultMap>;
}

export function buildVaultIndex(vault: VaultMap[]): VaultIndex {
  return {
    maps: vault,
    byName: new Map(vault.map((map) => [map.displayName.toLowerCase(), map])),
  };
}

/**
 * The base-game maps, then every installed map with vault metadata filling the
 * gaps, keyed by lower-cased folder name. `officialDescription` is what a base
 * map says about itself, passed in so this stays free of the locale.
 */
export function buildHostCatalogue(
  installedMaps: InstalledMap[],
  vaultIndex: VaultIndex,
  officialDescription: string,
): Map<string, HostMap> {
  const mapByFolder = new Map<string, HostMap>();

  // 1. Official base-game maps
  for (const base of OFFICIAL_BASE_MAPS) {
    mapByFolder.set(base.folderName.toLowerCase(), {
      displayName: base.displayName,
      folderName: base.folderName,
      maxPlayers: base.maxPlayers,
      width: base.width,
      height: base.height,
      version: "1.0",
      ranked: true,
      description: officialDescription,
    });
  }

  // 2. Locally installed maps, with vault metadata filling the gaps
  for (const installed of installedMaps) {
    const key = installed.folderName.toLowerCase();
    const baseKey = key.replace(/\.v\d+$/i, "");
    const nameKey = installed.displayName.toLowerCase();

    // By base name when the exact version is not in the catalogue, which
    // holds only each map's latest. The old base-name probe asked a map
    // keyed by *versioned* folders for an unversioned key, so it never hit,
    // and an older installed version only found its record when the name
    // derived from its folder happened to equal the vault's title (#416).
    const vaultMeta =
      findVaultMapByFolder(vaultIndex.maps, installed.folderName)
      ?? vaultIndex.byName.get(nameKey);
    const officialMeta =
      OFFICIAL_BY_FOLDER.get(key)
      ?? OFFICIAL_BY_FOLDER.get(baseKey)
      ?? OFFICIAL_BY_NAME.get(nameKey);
    const existing = mapByFolder.get(key) ?? mapByFolder.get(baseKey);

    const maxPlayers =
      (installed.maxPlayers && installed.maxPlayers > 0 ? installed.maxPlayers : 0) ||
      vaultMeta?.maxPlayers ||
      officialMeta?.maxPlayers ||
      existing?.maxPlayers ||
      0;

    const width =
      (installed.width && installed.width > 0 ? installed.width : 0) ||
      vaultMeta?.width ||
      officialMeta?.width ||
      existing?.width ||
      0;

    const height =
      (installed.height && installed.height > 0 ? installed.height : 0) ||
      vaultMeta?.height ||
      officialMeta?.height ||
      existing?.height ||
      0;

    const description =
      installed.description ||
      vaultMeta?.description ||
      existing?.description ||
      undefined;

    const version = installed.version || vaultMeta?.version || existing?.version;

    mapByFolder.set(key, {
      displayName: vaultMeta?.displayName ?? officialMeta?.displayName ?? installed.displayName,
      folderName: installed.folderName,
      maxPlayers,
      width,
      height,
      version: version ?? undefined,
      // The vault knows; a base map the vault has never heard of is rated by
      // definition. Same rule the Maps tab's installed list uses.
      ranked: vaultMeta?.ranked ?? isOfficialMap(installed.folderName),
      description,
      author: vaultMeta?.author,
    });
  }

  return mapByFolder;
}

/**
 * The catalogue as a list, plus the generated maps it cannot know about: the
 * one just selected and any starred one. `generatedDescription` is what such
 * an entry says about itself.
 */
export function withUncataloguedMaps(
  catalogue: Map<string, HostMap>,
  selectedMap: string | null | undefined,
  favoriteMaps: string[],
  generatedDescription: string,
): HostMap[] {
  const all = Array.from(catalogue.values());
  if (selectedMap && !catalogue.has(selectedMap.toLowerCase())) {
    all.push({
      displayName: selectedMap,
      folderName: selectedMap,
      maxPlayers: 16,
      width: 1024,
      height: 1024,
      version: "1.0",
      // A generated map exists in no vault, so it is rated by nothing.
      ranked: false,
      description: generatedDescription,
    });
  }
  // A generated map starred from a game's preview (#394) is in no vault and
  // usually not on disk either, and hosting it by name generates it again.
  // So it is listed from the favourites alone, or the star would lead
  // nowhere.
  for (const favorite of favoriteMaps) {
    const key = favorite.toLowerCase();
    if (!isGeneratedMap(favorite) || catalogue.has(key) || key === selectedMap?.toLowerCase()) continue;
    all.push({
      displayName: favorite,
      folderName: favorite,
      maxPlayers: 16,
      width: 1024,
      height: 1024,
      version: "1.0",
      ranked: false,
      description: generatedDescription,
    });
  }
  return all;
}

/** The search box and the filter popover applied, sorted by name. */
export function filterHostMaps(
  maps: HostMap[],
  filters: Pick<MapPickerFilters, "mapSearch" | "rankedFilter" | "widthKm" | "heightKm" | "playerCount">,
): HostMap[] {
  const { mapSearch, rankedFilter, widthKm, heightKm, playerCount } = filters;
  const search = mapSearch.trim().toLocaleLowerCase();
  const matches = (name: string) => !search || name.toLocaleLowerCase().includes(search);
  return maps
    .filter((map) => matches(map.displayName) || matches(map.folderName))
    .filter(
      (map) =>
        withinRange(map.maxPlayers, playerCount) &&
        withinRange(toKilometres(map.width), widthKm) &&
        withinRange(toKilometres(map.height), heightKm),
    )
    // Filters rather than tabs, which is what the thread asked for: a host
    // who only ever starts rated games wants that to be one setting, not a
    // section they have to be in.
    .filter((map) => rankedFilter === "all" || map.ranked === (rankedFilter === "ranked"))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

/**
 * The map the dialog is about to host.
 *
 * Resolved against every map rather than the visible half, so switching to
 * Favourites with an unstarred map selected does not quietly change the map
 * you were about to host. The fallbacks only matter when nothing is chosen.
 */
export function resolveChosenMap(
  availableMaps: HostMap[],
  visibleMaps: HostMap[],
  selectedMap: string | null | undefined,
): HostMap | undefined {
  return availableMaps.find((map) => map.folderName.toLowerCase() === selectedMap?.toLowerCase())
    ?? availableMaps.find((map) => map.folderName === selectedMap)
    ?? visibleMaps[0]
    ?? availableMaps[0];
}

/** Shown on the filter button so a narrowed list is never a mystery. */
export function activeFilterCount(
  filters: Pick<MapPickerFilters, "rankedFilter" | "widthKm" | "heightKm" | "playerCount">,
): number {
  const { widthKm, heightKm, playerCount, rankedFilter } = filters;
  return [widthKm, heightKm, playerCount].filter(isBounded).length + (rankedFilter === "all" ? 0 : 1);
}
