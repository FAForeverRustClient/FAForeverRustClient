import { useMemo, useState } from "react";
import { Icon } from "../../design-system/Icon";
import type { VaultMap } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import { FactionIcon } from "./FactionIcon";
import {
  isGeneratedMap,
  mapPresentation,
  mapThumbnailCandidates,
} from "../mapPresentation";
import { useGeneratedMapArt } from "../markedMapPreview";
import { firstLiveCandidate, markThumbnailMissing } from "../thumbnailCache";
import { useGeneratedMapPreview } from "../hooks/useGeneratedMapPreview";
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
  const { t } = useTranslation();
  // Subscribed rather than read through the shared fallback: the mission
  // catalogue loads after a tile renders, and a mission's own folder is the
  // only place a campaign map's art exists.
  const missions = useAppStore((state) => state.state.coop.missions);
  const presentation = mapPresentation(vault, mapName, missions);
  const isGenerated = isGeneratedMap(mapName);
  // A generated map's picture: FAF's icons on its terrain once drawn, the
  // generator's own preview until then (`useGeneratedMapArt`).
  const generatedPreview = useGeneratedMapArt(isGenerated ? mapName : null);
  useGeneratedMapPreview(mapName, isGenerated, Boolean(generatedPreview));
  const candidates = useMemo(
    () => mapThumbnailCandidates(vault, mapName, large, missions, generatedPreview, ownUrl || undefined, preferCanonicalPreview),
    [generatedPreview, large, mapName, missions, ownUrl, preferCanonicalPreview, vault],
  );
  // Which candidate is shown, for the candidates it was worked out for. A new
  // map starts its own walk in the same render (#642): the walk used to be
  // reset in an effect after it, so stepping through a list drew the next
  // map's name with the last one's index, and the picture lagged behind.
  const [walk, setWalk] = useState(() => ({ candidates, index: firstLiveCandidate(candidates) }));
  const candidateIndex = walk.candidates === candidates ? walk.index : firstLiveCandidate(candidates);

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
          alt={t("common.mapPreview", { name: presentation.displayName })}
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
          aria-label={t("common.mapPreview", { name: presentation.displayName })}
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
      <span className={placeholderClassName} aria-label={t("common.mapPreviewUnavailable", { name: presentation.displayName })}>
        <Icon name="maps" size={iconSize ?? (large ? 34 : 18)} />
      </span>
    );
  }

  return (
    <img
      // One element per picture: with a changed `src` the browser keeps the
      // previous map on screen until the next one has loaded, which is the
      // preview showing one map under another's name (#642).
      key={url}
      className={className}
      src={url}
      alt={t("common.mapPreview", { name: presentation.displayName })}
      loading="lazy"
      decoding="async"
      onError={() => {
        markThumbnailMissing(url);
        // Never the same index twice: `url` is the candidate at the current
        // index, so skipping every remembered miss lands strictly past it.
        setWalk({ candidates, index: firstLiveCandidate(candidates) });
      }}
    />
  );
}
