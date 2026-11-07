import type { MapUrls } from "../ipc/bindings";

/** Full search results, compact catalogue records and installed-map art share these accessors. */
export type MapUrlSource = {
  folderName: string;
  mapId?: number;
  urls?: Partial<MapUrls> | null;
  thumbnailUrl?: string;
  thumbnailUrlLarge?: string;
  downloadUrl?: string;
};

/** Compact records omit exactly the URL the API builds from the raw folder. */
export function mapThumbnailUrl(map: MapUrlSource, large = false): string {
  const full = large ? map.thumbnailUrlLarge : map.thumbnailUrl;
  if (full !== undefined) return full;
  if (map.mapId === undefined) return "";
  const override = large ? map.urls?.thumbnailUrlLarge : map.urls?.thumbnailUrl;
  return override ?? `https://content.faforever.com/maps/previews/${large ? "large" : "small"}/${map.folderName}.png`;
}

export function mapDownloadUrl(map: MapUrlSource): string {
  if (map.downloadUrl !== undefined) return map.downloadUrl;
  if (map.mapId === undefined) return "";
  return map.urls?.downloadUrl ?? `https://content.faforever.com/maps/${map.folderName}.zip`;
}
