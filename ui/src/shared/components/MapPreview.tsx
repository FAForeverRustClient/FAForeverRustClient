// A map's picture, at thumbnail or detail size, with the FAF CDN as the
// fallback when the record carries no usable URL and an icon when that fails
// too. Shared because the lobby, the replay views, the tournament map picker
// and the vault all show the same picture and used to reach into the maps
// feature for it, which also meant the styles only existed once the vault had
// been opened.

import { useMemo, useState } from "react";
import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import { native } from "../../ipc/native";
import { mapThumbnailUrl, type MapUrlSource } from "../mapCatalogue";
import { isOfficialMap } from "../mapPresentation";
import "./map-preview.css";

export type PreviewableMap = MapUrlSource & {
  displayName?: string;
  previewUrl?: string;
};

export function MapPreview({ map, large = false }: { map: PreviewableMap; large?: boolean }) {
  const { t } = useTranslation();
  const cdnFallback = `https://content.faforever.com/maps/previews/${large ? "large" : "small"}/${encodeURIComponent(map.folderName.toLowerCase())}.png`;
  const smallUrl = mapThumbnailUrl(map);
  const largeUrl = mapThumbnailUrl(map, true);
  const primaryUrl = large
    ? (largeUrl || smallUrl || map.previewUrl)
    : (smallUrl || map.previewUrl || largeUrl);
  // A base-game map's thumbnail from the original game first, 256 pixels
  // where the preview service has 100 (`native.officialMapPreviewUrl`).
  const originalGameUrl = !large && isOfficialMap(map.folderName)
    ? native.officialMapPreviewUrl(map.folderName)
    : null;
  // Then the record's own art, then the standard FAF CDN, then the icon.
  const candidates = useMemo(
    () => [...new Set([originalGameUrl, primaryUrl, cdnFallback].filter((url): url is string => Boolean(url)))],
    [originalGameUrl, primaryUrl, cdnFallback],
  );
  // The step reached, for the candidates it was reached in: another map starts
  // its own walk in the same render, as `MapThumbnail`'s does.
  const [walk, setWalk] = useState({ candidates, index: 0 });
  const index = walk.candidates === candidates ? walk.index : 0;
  const currentUrl = candidates[index];

  if (!currentUrl) {
    return (
      <span
        className={
          large
            ? "map-vault-preview map-vault-preview-empty"
            : "map-vault-thumb map-vault-preview-empty"
        }
        aria-hidden="true"
      >
        <Icon name="maps" size={large ? 34 : 24} />
      </span>
    );
  }
  return (
    <img
      key={currentUrl}
      className={large ? "map-vault-preview" : "map-vault-thumb"}
      src={currentUrl}
      alt={t("common.mapPreview", { name: map.displayName || map.folderName })}
      loading="lazy"
      decoding="async"
      onError={() => setWalk({ candidates, index: index + 1 })}
    />
  );
}
