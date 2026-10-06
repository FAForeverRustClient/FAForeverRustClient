// The replay detail panel's pure parts: shaping a local file like a vault
// record, and reading the map generator's state for the one map it shows.

import type {
  CoopMission,
  GeneratorStatus,
  InstalledMap,
  LocalReplay,
  LocalReplayPlayer,
  LocalReplayTeam,
  VaultMap,
  VaultReplay,
} from "../../ipc/bindings";
import type { MessageKey, MessageValues } from "../../i18n";
import { isGeneratedMapPlaceholderUrl, mapPresentation, normalizeMapName } from "../../shared/mapPresentation";
import { localReplayTimestamp } from "./local/localReplayQuery";

type Translate = (key: MessageKey, values?: MessageValues) => string;

export function localReplayToVaultReplay(
  local: LocalReplay,
  mapVault: VaultMap[],
  missions: CoopMission[] = [],
): VaultReplay {
  const presentation = local.map ? mapPresentation(mapVault, local.map, missions) : null;
  const timestamp = localReplayTimestamp(local);
  return {
    uid: local.uid ?? 0,
    title: local.title || local.fileName,
    map: presentation?.displayName || local.map || local.fileName,
    mapThumbnailUrl: presentation?.thumbnailUrl || "",
    modName: local.modName || "faf",
    startTime: timestamp > 0 ? new Date(timestamp).toISOString() : "",
    replayAvailable: local.watchable,
    durationSeconds: null,
    gameDurationSeconds: null,
    quality: null,
    reviewsAverage: null,
    reviewsCount: null,
    averageRating: local.averageRating,
    gameVersion: local.gameVersion,
    teams: local.teams.map((team: LocalReplayTeam) => ({
      team: team.team === "null" ? -1 : Number.parseInt(team.team, 10) || 0,
      players: team.players.map((player: LocalReplayPlayer) => ({
        name: player.name,
        faction: player.faction,
        rating: player.rating,
        country: player.country ?? null,
        outcome: "",
        score: null,
      })),
    })),
  };
}

/**
 * The picture of a generated map, once the generator has built one. Keyed
 * the three ways `ReplayMapThumb` keys it, because the store is written
 * from whichever spelling the caller had.
 */
export function generatedPreviewFor(
  previews: Partial<Record<string, string>> | undefined,
  mapName: string,
): string | undefined {
  return previews?.[mapName]
    || previews?.[normalizeMapName(mapName)]
    || previews?.[mapName.toLowerCase()];
}

/** Whether a map folder on disk is this map, in any version. */
export function isMapInstalled(installed: InstalledMap[], mapName: string): boolean {
  return installed.some(
    (map) =>
      map.folderName.toLowerCase() === mapName.toLowerCase() ||
      map.folderName.toLowerCase().startsWith(`${mapName.toLowerCase()}.`),
  );
}

/** Whether the generator is busy at all, between being asked and finishing. */
export function isGeneratorRunning(status: GeneratorStatus): boolean {
  return status.type === "generating" ||
    status.type === "downloading" ||
    status.type === "resolvingVersion" ||
    status.type === "preparing";
}

export interface GeneratorProgress {
  label: string;
  /** Whole percent, or `null` when there is no fraction to show. */
  percent: number | null;
}

/** The progress banner's line for the generator's current step, if it has one. */
export function generatorProgress(status: GeneratorStatus, t: Translate): GeneratorProgress | null {
  switch (status.type) {
    case "resolvingVersion":
    case "preparing":
      return {
        label: t("replays.detail.preparingGenerator"),
        percent: null,
      };
    case "downloading": {
      const { version, downloadedBytes, totalBytes } = status.payload;
      if (totalBytes && totalBytes > 0) {
        const pct = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
        const dlMb = (downloadedBytes / (1024 * 1024)).toFixed(1);
        const totMb = (totalBytes / (1024 * 1024)).toFixed(1);
        return {
          label: `${t("replays.detail.downloadingGenerator", { version })} (${dlMb}/${totMb} MB)`,
          percent: pct,
        };
      }
      return {
        label: t("replays.detail.downloadingGenerator", { version }),
        percent: null,
      };
    }
    case "generating": {
      const { detail } = status.payload;
      return {
        label: detail && detail.trim().length > 0
          ? detail
          : t("lobby.details.generatingMap"),
        percent: null,
      };
    }
    default:
      return null;
  }
}

/**
 * What the heatmap draws its cells over. The placeholder a generated map
 * carries is not a preview: it is the picture that says there is no picture,
 * and the heat over it would read as heat over the map.
 */
export function heatmapPreviewUrl(
  generatedPreview: string | undefined,
  mapThumbnailUrl: string,
): string | undefined {
  return generatedPreview
    || (isGeneratedMapPlaceholderUrl(mapThumbnailUrl) ? "" : mapThumbnailUrl)
    || undefined;
}
