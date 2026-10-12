// A map's picture with FAF's own mass, hydro and spawn icons drawn on it, for
// the large map preview of a generated map.
//
// The generator bakes its markers into the preview it writes, as green and
// yellow dots that are not the icons the vault's previews use and sit a pixel
// off their markers. The backend reads the `.scmap`'s clean picture and the
// markers' positions instead (`infra::map_markers`), and they are drawn here
// in the vault previews' order: hydros, then mass, then the spawns on top.
//
// One picture rather than icons laid over an `<img>`: the zoom moves whatever
// is inside it, and Copy image copies the first `<img>` it finds, which would
// have been the terrain without a single marker on it.

import { useEffect, useState } from "react";
import { native, type MarkedMapPreview } from "../ipc/native";
import { useAppStore } from "../store/store";
import { baseMapName, isGeneratedMap, normalizeMapName } from "./mapPresentation";
import { installedBases } from "./hooks/useLocalMapPreview";
import armyIcon from "./assets/map-markers/army.png";
import hydroIcon from "./assets/map-markers/hydro.png";
import massIcon from "./assets/map-markers/mass.png";

/// The drawn picture's width. The `.scmap` carries 256 pixels, which at the
/// dialog's size left the icons a few pixels across; four times that keeps a
/// 20 px icon at its own resolution.
export const MARKED_PREVIEW_WIDTH = 1024;

export type MarkerKind = "hydro" | "mass" | "spawn";

/// Each icon's size on the drawn picture. Hydros a little larger than mass, as
/// the Python client draws them (10 to 8); the army mark is 10 by 12.
const ICON_SIZE: Record<MarkerKind, { width: number; height: number }> = {
  hydro: { width: 25, height: 25 },
  mass: { width: 20, height: 20 },
  spawn: { width: 15, height: 18 },
};

export interface MarkerPlacement {
  kind: MarkerKind;
  /** The icon's top left corner on the drawn picture, in pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where each icon goes on a picture `width` by `height` pixels, centred on its
 * marker, in drawing order. Markers are in map units over the whole map, which
 * the picture covers whole, so each axis scales on its own.
 */
export function markerPlacements(
  preview: Pick<MarkedMapPreview, "width" | "height" | "mass" | "hydro" | "spawns">,
  width: number,
  height: number,
): MarkerPlacement[] {
  const scaleX = width / preview.width;
  const scaleY = height / preview.height;
  const place = (kind: MarkerKind) => ([x, z]: [number, number]): MarkerPlacement => {
    const size = ICON_SIZE[kind];
    return {
      kind,
      x: x * scaleX - size.width / 2,
      y: z * scaleY - size.height / 2,
      width: size.width,
      height: size.height,
    };
  };
  return [
    ...preview.hydro.map(place("hydro")),
    ...preview.mass.map(place("mass")),
    ...preview.spawns.map(place("spawn")),
  ];
}

/// Rejects with the image's error event: nothing here is shown, since a
/// picture that does not load leaves the caller's own one in place.
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

/**
 * Draw the picture and its icons, as an object URL for a PNG; `null` without
 * a 2d canvas. An object URL rather than a data URL: a 1024 px picture is a
 * megabyte or two, and as base64 in a string it would be held twice over for
 * every tile that shows one.
 */
async function composeMarkedPreview(preview: MarkedMapPreview): Promise<string | null> {
  const [base, hydro, mass, army] = await Promise.all([
    loadImage(preview.image),
    loadImage(hydroIcon),
    loadImage(massIcon),
    loadImage(armyIcon),
  ]);
  const width = MARKED_PREVIEW_WIDTH;
  const height = Math.round(width * (base.naturalHeight / base.naturalWidth));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(base, 0, 0, width, height);
  const icons: Record<MarkerKind, HTMLImageElement> = { hydro, mass, spawn: army };
  for (const placement of markerPlacements(preview, width, height)) {
    context.drawImage(icons[placement.kind], placement.x, placement.y, placement.width, placement.height);
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? URL.createObjectURL(blob) : null;
}

/// Drawn pictures by map folder, lowercased, oldest first. Enough for a page
/// of tiles and the dialogs opened from them; an evicted one is drawn again.
const drawn = new Map<string, string>();
const MAX_DRAWN = 32;

/// Folders being drawn, so that twenty tiles of one map ask once.
const pending = new Map<string, Promise<string | null>>();

/// When a folder last failed. Not for good: a map is asked about before the
/// generator has finished writing it, and a tournament map, which the
/// backend refuses, would otherwise be asked about again by every tile.
const failedAt = new Map<string, number>();
const RETRY_AFTER_MS = 10_000;

function remember(key: string, url: string): void {
  drawn.set(key, url);
  while (drawn.size > MAX_DRAWN) {
    const [oldest, oldUrl] = drawn.entries().next().value as [string, string];
    drawn.delete(oldest);
    // A tile still showing it keeps the picture it has decoded.
    URL.revokeObjectURL(oldUrl);
  }
}

function markedPreview(key: string, now = Date.now()): Promise<string | null> {
  const known = drawn.get(key);
  if (known) return Promise.resolve(known);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const failed = failedAt.get(key);
  if (failed !== undefined && now - failed < RETRY_AFTER_MS) return Promise.resolve(null);
  // Started inside a `then`, so that a shell without the command (a test's
  // stand-in, say) fails the same quiet way a missing file does.
  const request = Promise.resolve()
    .then(() => native.readMarkedMapPreview(key))
    .then(composeMarkedPreview)
    // Not on disk yet, a file missing, a map whose layout the generator
    // hides, or a webview that cannot draw: the caller keeps its picture.
    .catch(() => null)
    .then((url) => {
      pending.delete(key);
      if (url) {
        failedAt.delete(key);
        remember(key, url);
      } else {
        failedAt.set(key, Date.now());
      }
      return url;
    });
  pending.set(key, request);
  return request;
}

/**
 * The drawn picture of the map in folder `folderName`, or `null` while it is
 * being drawn, when it cannot be, or when there is no folder to ask about.
 * `retryKey` asks again when it changes: the generator's own picture arriving
 * is the sign that a freshly generated map is on disk now.
 */
export function useMarkedMapPreview(folderName: string | null, retryKey?: unknown): string | null {
  const key = folderName ? folderName.toLowerCase() : null;
  const [url, setUrl] = useState<{ key: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!key || drawn.has(key)) return;
    let current = true;
    void markedPreview(key).then((result) => {
      if (current) setUrl({ key, url: result });
    });
    return () => {
      current = false;
    };
  }, [key, retryKey]);
  if (!key) return null;
  // Already drawn, by this tile or another: shown on the first render rather
  // than after a flash of the generator's own picture.
  return drawn.get(key) ?? (url && url.key === key ? url.url : null);
}

/**
 * The picture to show for a generated map: FAF's icons on the `.scmap`'s
 * terrain once that is drawn, and until then, or where it cannot be (a map not
 * on disk, or a tournament, blind or unexplored one), the generator's own
 * preview. `undefined` when there is neither, and for any other map.
 *
 * The one place every view gets a generated map's picture from, so that a
 * tile, the host dialog and the generator window cannot disagree about it.
 */
export function useGeneratedMapArt(mapName: string | null | undefined): string | undefined {
  const name = mapName?.trim() ?? "";
  const generated = isGeneratedMap(name);
  const normalized = normalizeMapName(name);
  const raw = useAppStore((state) =>
    generated
      ? state.state.mapGenerator.previews?.[name] ||
        state.state.mapGenerator.previews?.[normalized] ||
        state.state.mapGenerator.previews?.[name.toLowerCase()]
      : undefined,
  );
  const installed = useAppStore((state) =>
    generated ? installedBases(state.state.maps.installed).has(baseMapName(name)) : false,
  );
  // On disk: in the installed list, or the generator has just written its
  // picture, which it does into the map's own folder.
  const marked = useMarkedMapPreview(generated && (installed || raw) ? name : null, raw);
  return marked ?? raw ?? undefined;
}

/** Test seam: the module-level caches would otherwise leak between cases. */
export function resetMarkedMapPreviews(): void {
  for (const url of drawn.values()) URL.revokeObjectURL(url);
  drawn.clear();
  pending.clear();
  failedAt.clear();
}
