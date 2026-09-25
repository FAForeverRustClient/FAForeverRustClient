import { useEffect, useMemo, useState } from "react";
import { Icon } from "../../design-system/Icon";
import type { VaultMap } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { FactionIcon } from "./FactionIcon";
import {
  isGeneratedMap,
  mapPresentation,
  mapThumbnailCandidates,
  normalizeMapName,
} from "../mapPresentation";
import { firstLiveCandidate, markThumbnailMissing } from "../thumbnailCache";
import { useLocalMapPreview } from "../hooks/useLocalMapPreview";
import { useVaultFolderLookup } from "../hooks/useVaultFolderLookup";
import "./map-thumbnail.css";

const COOP_FACTION_IDS: Record<string, number> = {
  uef: 1,
  aeon: 2,
  cybran: 3,
  seraphim: 4,
  custom: 5,
};

interface Props {
  mapName: string;
  vault: VaultMap[];
  className?: string;
  placeholderClassName?: string;
  large?: boolean;
  /** Prefer the clean FAF small/large preview over potentially stale vault art. */
  preferCanonicalPreview?: boolean;
  /**
   * Art the caller already holds for this map, such as a replay listing's
   * `mapVersion.thumbnailUrlSmall`. Tried in the order `mapThumbnailCandidates`
   * gives it: first for a small request, last for a large one.
   */
  url?: string | null;
  /** The placeholder icon's size, when the default for the frame is wrong. */
  iconSize?: number;
}

/** Map art with ordered fallbacks for stale, missing, and not-yet-loaded vault data. */
export function MapThumbnail({
  mapName,
  vault,
  className,
  placeholderClassName,
  large = false,
  preferCanonicalPreview = false,
  url: ownUrl,
  iconSize,
}: Props) {
  // Subscribed rather than read through the shared fallback: the mission
  // catalogue loads after a tile renders, and a mission's own folder is the
  // only place a campaign map's art exists.
  const missions = useAppStore((state) => state.state.coop.missions);
  const presentation = mapPresentation(vault, mapName, missions);
  const isGenerated = isGeneratedMap(mapName);
  const normalized = normalizeMapName(mapName);
  const generatedPreview = useAppStore((state) =>
    isGenerated
      ? state.state.mapGenerator.previews?.[mapName] ||
        state.state.mapGenerator.previews?.[normalized] ||
        state.state.mapGenerator.previews?.[mapName.toLowerCase()]
      : undefined,
  );
  const candidates = useMemo(
    () => mapThumbnailCandidates(vault, mapName, large, missions, generatedPreview, ownUrl || undefined, preferCanonicalPreview),
    [generatedPreview, large, mapName, missions, ownUrl, preferCanonicalPreview, vault],
  );
  const [candidateIndex, setCandidateIndex] = useState(() => firstLiveCandidate(candidates));

  useEffect(() => setCandidateIndex(firstLiveCandidate(candidates)), [candidates]);

  const url = candidates[candidateIndex];
  // Only once every remote candidate has 404'd. Kept out of `candidates` on
  // purpose: appending it there would reset the walk and replay those misses.
  const localPreview = useLocalMapPreview(mapName, !url, large);
  // Last of all, a map the catalogue does not list: a version withdrawn from
  // the vault is still played. Its record, once found, lands in the vault the
  // caller passes in, and the candidates above start over with its art.
  useVaultFolderLookup(mapName, !url && !localPreview && !isGenerated && !presentation.isCoop);

  if (!url) {
    if (localPreview) {
      return (
        <img
          className={className}
          src={localPreview}
          alt={`${presentation.displayName} preview`}
          loading="lazy"
          decoding="async"
        />
      );
    }
    if (presentation.isCoop) {
      const faction = presentation.coopFaction ?? "uef";
      const isCustomFaction = faction === "custom";
      const factionId = COOP_FACTION_IDS[faction] ?? 1;

      return (
        <span
          className={`${placeholderClassName} coop-map-tile-badge`}
          data-faction={faction}
          aria-label={`${presentation.displayName} preview`}
        >
          {isCustomFaction ? (
            <Icon name="maps" size={iconSize ?? (large ? 34 : 20)} />
          ) : (
            <FactionIcon faction={factionId} size={iconSize ?? (large ? 36 : 22)} />
          )}
        </span>
      );
    }

    return (
      <span className={placeholderClassName} aria-label={`${presentation.displayName} preview unavailable`}>
        <Icon name="maps" size={iconSize ?? (large ? 34 : 18)} />
      </span>
    );
  }

  return (
    <img
      className={className}
      src={url}
      alt={`${presentation.displayName} preview`}
      loading="lazy"
      decoding="async"
      onError={() => {
        markThumbnailMissing(url);
        // Never the same index twice: `url` is the candidate at the current
        // index, so skipping every remembered miss lands strictly past it.
        setCandidateIndex(firstLiveCandidate(candidates));
      }}
    />
  );
}
