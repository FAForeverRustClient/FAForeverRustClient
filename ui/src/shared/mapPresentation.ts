import type { CoopFaction, CoopMission, VaultMap } from "../ipc/bindings";
import { useAppStore } from "../store/store";

export type MapPresentation = {
  displayName: string;
  thumbnailUrl: string;
  thumbnailUrls: string[];
  coopFaction?: CoopFaction;
  isCoop?: boolean;
};

// Base-game maps are not vault records, so they never appear in the vault
// lookup used by the lobby rows. Keep the same built-in catalog used by the
// reference clients and use the public preview service for their thumbnails.
export type OfficialMapInfo = {
  folderName: string;
  displayName: string;
  maxPlayers: number;
  width: number;
  height: number;
};

export const OFFICIAL_BASE_MAPS: OfficialMapInfo[] = [
  { folderName: "scmp_001", displayName: "Burial Mounds", maxPlayers: 8, width: 1024, height: 1024 },
  { folderName: "scmp_002", displayName: "Concord Lake", maxPlayers: 8, width: 1024, height: 1024 },
  { folderName: "scmp_003", displayName: "Drake's Ravine", maxPlayers: 4, width: 1024, height: 1024 },
  { folderName: "scmp_004", displayName: "Emerald Crater", maxPlayers: 4, width: 1024, height: 1024 },
  { folderName: "scmp_005", displayName: "Gentleman's Reef", maxPlayers: 7, width: 2048, height: 2048 },
  { folderName: "scmp_006", displayName: "Ian's Cross", maxPlayers: 4, width: 1024, height: 1024 },
  { folderName: "scmp_007", displayName: "Open Palms", maxPlayers: 6, width: 512, height: 512 },
  { folderName: "scmp_008", displayName: "Seraphim Glaciers", maxPlayers: 8, width: 1024, height: 1024 },
  { folderName: "scmp_009", displayName: "Seton's Clutch", maxPlayers: 8, width: 1024, height: 1024 },
  { folderName: "scmp_010", displayName: "Sung Island", maxPlayers: 5, width: 1024, height: 1024 },
  { folderName: "scmp_011", displayName: "The Great Void", maxPlayers: 8, width: 2048, height: 2048 },
  { folderName: "scmp_012", displayName: "Theta Passage", maxPlayers: 2, width: 256, height: 256 },
  { folderName: "scmp_013", displayName: "Winter Duel", maxPlayers: 2, width: 256, height: 256 },
  { folderName: "scmp_014", displayName: "The Bermuda Locket", maxPlayers: 8, width: 1024, height: 1024 },
  { folderName: "scmp_015", displayName: "Fields Of Isis", maxPlayers: 4, width: 512, height: 512 },
  { folderName: "scmp_016", displayName: "Canis River", maxPlayers: 2, width: 256, height: 256 },
  { folderName: "scmp_017", displayName: "Syrtis Major", maxPlayers: 4, width: 512, height: 512 },
  { folderName: "scmp_018", displayName: "Sentry Point", maxPlayers: 3, width: 256, height: 256 },
  { folderName: "scmp_019", displayName: "Finn's Revenge", maxPlayers: 2, width: 512, height: 512 },
  { folderName: "scmp_020", displayName: "Roanoke Abyss", maxPlayers: 6, width: 1024, height: 1024 },
  { folderName: "scmp_021", displayName: "Alpha 7 Quarantine", maxPlayers: 8, width: 2048, height: 2048 },
  { folderName: "scmp_022", displayName: "Artic Refuge", maxPlayers: 4, width: 512, height: 512 },
  { folderName: "scmp_023", displayName: "Varga Pass", maxPlayers: 2, width: 512, height: 512 },
  { folderName: "scmp_024", displayName: "Crossfire Canal", maxPlayers: 6, width: 1024, height: 1024 },
  { folderName: "scmp_025", displayName: "Saltrock Colony", maxPlayers: 6, width: 512, height: 512 },
  { folderName: "scmp_026", displayName: "Vya-3 Protectorate", maxPlayers: 4, width: 512, height: 512 },
  { folderName: "scmp_027", displayName: "The Scar", maxPlayers: 6, width: 1024, height: 1024 },
  { folderName: "scmp_028", displayName: "Hanna oasis", maxPlayers: 8, width: 2048, height: 2048 },
  { folderName: "scmp_029", displayName: "Betrayal Ocean", maxPlayers: 8, width: 4096, height: 4096 },
  { folderName: "scmp_030", displayName: "Frostmill Ruins", maxPlayers: 8, width: 4096, height: 4096 },
  { folderName: "scmp_031", displayName: "Four-Leaf Clover", maxPlayers: 4, width: 512, height: 512 },
  { folderName: "scmp_032", displayName: "The Wilderness", maxPlayers: 4, width: 512, height: 512 },
  { folderName: "scmp_033", displayName: "White Fire", maxPlayers: 6, width: 512, height: 512 },
  { folderName: "scmp_034", displayName: "High Noon", maxPlayers: 4, width: 512, height: 512 },
  { folderName: "scmp_035", displayName: "Paradise", maxPlayers: 4, width: 512, height: 512 },
  { folderName: "scmp_036", displayName: "Blasted Rock", maxPlayers: 4, width: 256, height: 256 },
  { folderName: "scmp_037", displayName: "Sludge", maxPlayers: 3, width: 256, height: 256 },
  { folderName: "scmp_038", displayName: "Ambush Pass", maxPlayers: 4, width: 256, height: 256 },
  { folderName: "scmp_039", displayName: "Four-Corners", maxPlayers: 4, width: 256, height: 256 },
  { folderName: "scmp_040", displayName: "The Ditch", maxPlayers: 6, width: 512, height: 512 },
  { folderName: "x1mp_001", displayName: "Crag Dunes", maxPlayers: 8, width: 1024, height: 1024 },
  { folderName: "x1mp_002", displayName: "Williamson's Bridge", maxPlayers: 4, width: 512, height: 512 },
  { folderName: "x1mp_003", displayName: "Snoey Triangle", maxPlayers: 3, width: 512, height: 512 },
  { folderName: "x1mp_004", displayName: "Haven Reef", maxPlayers: 8, width: 1024, height: 1024 },
  { folderName: "x1mp_005", displayName: "The Dark Heart", maxPlayers: 6, width: 1024, height: 1024 },
  { folderName: "x1mp_006", displayName: "Daroza's Sanctuary", maxPlayers: 4, width: 512, height: 512 },
  { folderName: "x1mp_007", displayName: "Strip Mine", maxPlayers: 4, width: 512, height: 512 },
  { folderName: "x1mp_008", displayName: "Thawing Glacier", maxPlayers: 4, width: 1024, height: 1024 },
  { folderName: "x1mp_009", displayName: "Liberiam Battles", maxPlayers: 6, width: 1024, height: 1024 },
  { folderName: "x1mp_010", displayName: "Shards", maxPlayers: 2, width: 256, height: 256 },
  { folderName: "x1mp_011", displayName: "Shuriken Island", maxPlayers: 4, width: 512, height: 512 },
  { folderName: "x1mp_012", displayName: "Debris", maxPlayers: 4, width: 512, height: 512 },
  { folderName: "x1mp_014", displayName: "Flooded Strip Mine", maxPlayers: 6, width: 1024, height: 1024 },
  { folderName: "x1mp_017", displayName: "Eye Of The Storm", maxPlayers: 6, width: 1024, height: 1024 },
];

// Base-game maps are not vault records, so they never appear in the vault
// lookup used by the lobby rows. Keep the same built-in catalog used by the
// reference clients and use the public preview service for their thumbnails.
const OFFICIAL_MAPS: Record<string, string> = Object.fromEntries(
  OFFICIAL_BASE_MAPS.map((m) => [m.folderName, m.displayName]),
);

const OFFICIAL_MAP_KEYS_BY_DISPLAY_NAME = new Map(
  Object.entries(OFFICIAL_MAPS).map(([key, displayName]) => [displayName.toLocaleLowerCase(), key]),
);

type VaultMapLookup = {
  byBaseName: Map<string, VaultMap>;
  byDisplayName: Map<string, VaultMap>;
  byFolderName: Map<string, VaultMap>;
};

const VAULT_MAP_LOOKUPS = new WeakMap<VaultMap[], VaultMapLookup>();

function secureUrl(url: string): string {
  return url.trim().replace(/^http:\/\//i, "https://");
}

function uniqueUrls(urls: Array<string | undefined>): string[] {
  return [...new Set(urls.map((url) => secureUrl(url ?? "")).filter(Boolean))];
}

/**
 * Lobby payloads normally contain a map folder, but older servers and test
 * environments may send a scenario path. Reduce all of those forms to the
 * folder name used by the preview service and vault catalogue.
 */
function normalizeMapName(mapName: string): string {
  const normalized = mapName.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  const fileName = parts[parts.length - 1] ?? normalized;
  if (/_scenario\.lua$/i.test(fileName) && parts.length > 1) {
    return parts[parts.length - 2].toLocaleLowerCase();
  }
  return fileName
    .replace(/_scenario\.lua$/i, "")
    .replace(/\.(zip|fafmap)$/i, "")
    .toLocaleLowerCase();
}

function baseMapName(mapName: string): string {
  return normalizeMapName(mapName).replace(/\.v\d+$/i, "");
}

function findCoopMission(mapName: string, missions?: CoopMission[]): CoopMission | undefined {
  const coopMissions = missions ?? (typeof window !== "undefined" ? useAppStore.getState?.()?.state?.coop?.missions : []);
  if (!coopMissions || coopMissions.length === 0) return undefined;
  const normalized = normalizeMapName(mapName);
  const baseName = baseMapName(mapName);
  return coopMissions.find((m) => {
    const folder = normalizeMapName(m.mapFolderName);
    const missionBase = baseMapName(m.mapFolderName);
    return (
      folder === normalized ||
      folder === baseName ||
      missionBase === normalized ||
      missionBase === baseName ||
      m.name.toLocaleLowerCase() === mapName.trim().toLocaleLowerCase()
    );
  });
}

function vaultMapLookup(vault: VaultMap[]): VaultMapLookup {
  const cached = VAULT_MAP_LOOKUPS.get(vault);
  if (cached) return cached;

  const lookup: VaultMapLookup = {
    byBaseName: new Map(),
    byDisplayName: new Map(),
    byFolderName: new Map(),
  };
  for (const map of vault) {
    const folderName = normalizeMapName(map.folderName);
    // Preserve Array.find's first-match behavior when aliases collide.
    if (!lookup.byFolderName.has(folderName)) lookup.byFolderName.set(folderName, map);
    const baseName = baseMapName(folderName);
    if (!lookup.byBaseName.has(baseName)) lookup.byBaseName.set(baseName, map);
    const displayName = map.displayName.toLocaleLowerCase();
    if (!lookup.byDisplayName.has(displayName)) lookup.byDisplayName.set(displayName, map);
  }
  VAULT_MAP_LOOKUPS.set(vault, lookup);
  return lookup;
}

/** Twin of `faf_domain::protocol::map_generator::is_generated_map`. */
export function isGeneratedMap(mapName: string): boolean {
  return /^neroxis_map_generator_\d{1,3}\.\d{1,3}\.\d{1,3}_.+/i.test(normalizeMapName(mapName));
}

function fallbackDisplayName(mapName: string): string {
  return baseMapName(mapName)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter: string) => letter.toLocaleUpperCase());
}

export function findVaultMap(vault: VaultMap[], mapName: string): VaultMap | undefined {
  const normalized = normalizeMapName(mapName);
  const baseName = baseMapName(mapName);
  const lookup = vaultMapLookup(vault);
  return lookup.byFolderName.get(normalized)
    ?? lookup.byBaseName.get(baseName)
    ?? lookup.byDisplayName.get(mapName.trim().toLocaleLowerCase());
}

export function mapThumbnailCandidates(
  vault: VaultMap[],
  mapName: string,
  large = false,
  missions?: CoopMission[],
  customGeneratedPreview?: string,
): string[] {
  const vaultMap = findVaultMap(vault, mapName);
  const coopMission = findCoopMission(mapName, missions);
  const normalized = normalizeMapName(mapName);
  const baseName = baseMapName(mapName);
  const officialKey = OFFICIAL_MAPS[baseName]
    ? baseName
    : OFFICIAL_MAP_KEYS_BY_DISPLAY_NAME.get(mapName.trim().toLocaleLowerCase());
  const size = large ? "large" : "small";

  const isGen = isGeneratedMap(mapName);
  const generatedPreview =
    customGeneratedPreview ??
    (isGen
      ? typeof window !== "undefined"
        ? useAppStore.getState?.()?.state?.mapGenerator?.previews?.[mapName] ||
          useAppStore.getState?.()?.state?.mapGenerator?.previews?.[normalized]
        : undefined
      : undefined);

  return uniqueUrls([
    generatedPreview,
    large ? coopMission?.thumbnailUrlLarge : coopMission?.thumbnailUrlSmall,
    large ? coopMission?.thumbnailUrlSmall : coopMission?.thumbnailUrlLarge,
    large ? vaultMap?.thumbnailUrlLarge : vaultMap?.thumbnailUrl,
    large ? vaultMap?.thumbnailUrl : vaultMap?.thumbnailUrlLarge,
    officialKey
      ? `https://content.faforever.com/maps/previews/${size}/${officialKey}.png`
      : undefined,
    normalized && !normalized.includes(" ")
      ? `https://content.faforever.com/maps/previews/${size}/${encodeURIComponent(normalized)}.png`
      : undefined,
    baseName !== normalized && !baseName.includes(" ")
      ? `https://content.faforever.com/maps/previews/${size}/${encodeURIComponent(baseName)}.png`
      : undefined,
    isGen ? "/generated-map.svg" : undefined,
  ]);
}

export function inferCoopFaction(mapName: string): CoopFaction {
  const normalized = normalizeMapName(mapName);
  if (normalized.includes("scca_coop_e") || normalized.includes("uef")) return "uef";
  if (normalized.includes("scca_coop_c") || normalized.includes("cybran")) return "cybran";
  if (normalized.includes("scca_coop_a") || normalized.includes("aeon")) return "aeon";
  if (normalized.includes("x1ca_coop_") || normalized.includes("seraphim")) return "seraphim";
  return "custom";
}

export function mapPresentation(vault: VaultMap[], mapName: string, missions?: CoopMission[]): MapPresentation {
  const vaultMap = findVaultMap(vault, mapName);
  const coopMission = findCoopMission(mapName, missions);
  const baseName = baseMapName(mapName);
  const officialEntry = OFFICIAL_MAPS[baseName]
    ? ([baseName, OFFICIAL_MAPS[baseName]] as const)
    : (() => {
        const key = OFFICIAL_MAP_KEYS_BY_DISPLAY_NAME.get(mapName.trim().toLocaleLowerCase());
        return key ? ([key, OFFICIAL_MAPS[key]] as const) : undefined;
      })();
  const thumbnailUrls = mapThumbnailCandidates(vault, mapName, false, missions);

  if (coopMission) {
    const coopFaction = coopMission.scenarioId
      ? (typeof window !== "undefined"
          ? useAppStore.getState?.()?.state?.coop?.scenarios?.find((s) => s.id === coopMission.scenarioId)?.faction
          : undefined) ?? inferCoopFaction(coopMission.mapFolderName)
      : inferCoopFaction(coopMission.mapFolderName);
    return {
      displayName: coopMission.name,
      thumbnailUrl: thumbnailUrls[0] ?? "",
      thumbnailUrls,
      isCoop: true,
      coopFaction,
    };
  }

  const isCoopMap = /^(scca_coop_|x1ca_coop_)/i.test(normalizeMapName(mapName)) || mapName.toLowerCase().includes("coop");
  if (isCoopMap) {
    return {
      displayName: fallbackDisplayName(mapName),
      thumbnailUrl: thumbnailUrls[0] ?? "",
      thumbnailUrls,
      isCoop: true,
      coopFaction: inferCoopFaction(mapName),
    };
  }

  if (officialEntry) {
    return {
      displayName: officialEntry[1],
      thumbnailUrl: thumbnailUrls[0] ?? "",
      thumbnailUrls,
    };
  }
  if (vaultMap) {
    return {
      displayName: vaultMap.displayName,
      thumbnailUrl: thumbnailUrls[0] ?? "",
      thumbnailUrls,
    };
  }

  return {
    displayName: fallbackDisplayName(mapName),
    thumbnailUrl: thumbnailUrls[0] ?? "",
    thumbnailUrls,
  };
}
