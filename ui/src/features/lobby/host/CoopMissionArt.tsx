// A mission's preview art, with the faction crest as the standing fallback.
//
// Local first here, unlike everywhere else: the campaign's remote thumbnails
// are known to be missing. The FAF API mints a `thumbnailUrl` from the folder
// name and `content.faforever.com/maps/previews/` holds no image for a single
// campaign mission, so trying them first would only buy three 404s per
// mission the user clicks. The installed map folder does carry the art.

import { useEffect, useMemo, useState } from "react";
import type { CoopMission, CoopScenario, VaultMap } from "../../../ipc/bindings";
import { FactionIcon } from "../../../shared/FactionIcon";
import { inferCoopFaction, mapThumbnailCandidates } from "../../../shared/mapPresentation";
import { useLocalMapPreview } from "../../../shared/useLocalMapPreview";
import { useTranslation } from "../../../i18n/useTranslation";

const COOP_FACTION_NUMBERS: Record<string, number> = {
  uef: 1,
  aeon: 2,
  cybran: 3,
  seraphim: 4,
  custom: 5,
};

function secureImageUrl(url: string): string {
  return url.trim().replace(/^http:\/\//i, "https://");
}

/** Remote candidates for a mission, best size first. */
export function coopPreviewCandidates(mission: CoopMission, vault: VaultMap[]): string[] {
  return [
    ...new Set(
      [
        ...mapThumbnailCandidates(vault, mission.mapFolderName, true),
        mission.thumbnailUrlLarge,
        mission.thumbnailUrlSmall,
        ...mapThumbnailCandidates(vault, mission.mapFolderName),
      ]
        .map(secureImageUrl)
        .filter(Boolean),
    ),
  ];
}

interface Props {
  mission: CoopMission;
  scenario?: CoopScenario;
  vault: VaultMap[];
  className?: string;
}

export function CoopMissionArt({ mission, scenario, vault, className }: Props) {
  const { t } = useTranslation();
  const localPreview = useLocalMapPreview(mission.mapFolderName, true, true);
  const candidates = useMemo(
    () => [...(localPreview ? [localPreview] : []), ...coopPreviewCandidates(mission, vault)],
    [localPreview, mission, vault],
  );
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadedUrl(null);

    if (candidates.length === 0) return;

    let index = 0;
    const tryNext = () => {
      if (cancelled || index >= candidates.length) return;
      const src = candidates[index++];
      const img = new window.Image();
      img.onload = () => {
        if (!cancelled) setLoadedUrl(src);
      };
      img.onerror = () => {
        if (!cancelled) tryNext();
      };
      img.src = src;
    };

    tryNext();

    return () => {
      cancelled = true;
    };
  }, [candidates]);

  const faction = scenario?.faction ?? inferCoopFaction(mission.mapFolderName);
  const factionId = COOP_FACTION_NUMBERS[faction] ?? 1;

  if (loadedUrl) {
    return (
      <img
        className={className}
        src={loadedUrl}
        alt={`${mission.name} preview`}
        loading="lazy"
        decoding="async"
      />
    );
  }

  return (
    <div
      className={`${className ?? ""} coop-mission-art-fallback`}
      data-faction={faction}
      role="img"
      aria-label={t("lobby.coop.previewUnavailable", { mission: mission.name })}
    >
      <FactionIcon faction={factionId} size={40} />
    </div>
  );
}
