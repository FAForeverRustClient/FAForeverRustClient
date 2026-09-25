// A map's picture, at thumbnail or detail size, with the FAF CDN as the
// fallback when the record carries no usable URL and an icon when that fails
// too. Shared because the lobby, the replay views, the tournament map picker
// and the vault all show the same picture and used to reach into the maps
// feature for it, which also meant the styles only existed once the vault had
// been opened.

import { useEffect, useState } from "react";
import { Icon } from "../../design-system/Icon";
import "./map-preview.css";

export type PreviewableMap = {
  folderName: string;
  displayName?: string;
  thumbnailUrl?: string;
  thumbnailUrlLarge?: string;
  previewUrl?: string;
};

export function MapPreview({ map, large = false }: { map: PreviewableMap; large?: boolean }) {
  const cdnFallback = `https://content.faforever.com/maps/previews/${large ? "large" : "small"}/${encodeURIComponent(map.folderName.toLowerCase())}.png`;
  const primaryUrl = large
    ? (map.thumbnailUrlLarge || map.thumbnailUrl || map.previewUrl)
    : (map.thumbnailUrl || map.previewUrl || map.thumbnailUrlLarge);
  const [currentUrl, setCurrentUrl] = useState<string | null>(primaryUrl || cdnFallback);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setCurrentUrl(primaryUrl || cdnFallback);
    setFailed(false);
  }, [primaryUrl, cdnFallback]);

  const handleError = () => {
    if (currentUrl && currentUrl !== cdnFallback) {
      // Try the standard FAF CDN fallback before failing to the placeholder icon
      setCurrentUrl(cdnFallback);
    } else {
      setFailed(true);
    }
  };

  if (!currentUrl || failed) {
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
      className={large ? "map-vault-preview" : "map-vault-thumb"}
      src={currentUrl}
      alt={`${map.displayName || map.folderName} preview`}
      loading="lazy"
      decoding="async"
      onError={handleError}
    />
  );
}
