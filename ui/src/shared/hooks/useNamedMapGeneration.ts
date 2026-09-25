import { useCallback } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { isGeneratedMap, normalizeMapName } from "../mapPresentation";
import type { GeneratorStatus } from "../../ipc/bindings";

export interface NamedMapGeneration {
  isGenerated: boolean;
  installed: boolean;
  hasPreview: boolean;
  isGenerating: boolean;
  canGenerate: boolean;
  generate: () => void;
  status: GeneratorStatus;
  progress: { label: string; percent: number | null } | null;
  generateLabel: string;
}

/**
 * Reusable hook to handle Neroxis generated map detection, installation check,
 * and triggering named map generation with progress tracking.
 */
export function useNamedMapGeneration(mapName: string | undefined | null): NamedMapGeneration {
  const { t } = useTranslation();
  const maps = useAppStore((state) => state.state.maps);
  const mapGenStatus = useAppStore((state) => state.state.mapGenerator.status);
  const mapGenPreviews = useAppStore((state) => state.state.mapGenerator.previews);

  const name = mapName?.trim() ?? "";
  const isGenerated = isGeneratedMap(name);
  const normalized = normalizeMapName(name);

  const hasPreview = !!(
    mapGenPreviews?.[name] ||
    mapGenPreviews?.[normalized] ||
    mapGenPreviews?.[name.toLowerCase()]
  );

  const installed = maps.installed.some(
    (map) =>
      map.folderName.toLowerCase() === name.toLowerCase() ||
      map.folderName.toLowerCase().startsWith(`${name.toLowerCase()}.`),
  );

  const isGenerating =
    mapGenStatus.type === "generating" ||
    mapGenStatus.type === "downloading" ||
    mapGenStatus.type === "resolvingVersion" ||
    mapGenStatus.type === "preparing";

  const canGenerate = isGenerated && !installed && !hasPreview;

  const generate = useCallback(() => {
    if (!name) return;
    ipc.send({
      kind: "MapGenerator",
      command: {
        type: "generateNamed",
        payload: { mapName: name },
      },
    });
  }, [name]);

  const progress = (() => {
    switch (mapGenStatus.type) {
      case "resolvingVersion":
      case "preparing":
        return {
          label: t("replays.detail.preparingGenerator"),
          percent: null,
        };
      case "downloading": {
        const { version, downloadedBytes, totalBytes } = mapGenStatus.payload;
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
      case "generating":
        return {
          label: t("lobby.browser.generatingMap"),
          percent: null,
        };
      default:
        return null;
    }
  })();

  const generateLabel = isGenerating
    ? t("lobby.browser.generatingMap")
    : t("lobby.browser.generateMap");

  return {
    isGenerated,
    installed,
    hasPreview,
    isGenerating,
    canGenerate,
    generate,
    status: mapGenStatus,
    progress,
    generateLabel,
  };
}
