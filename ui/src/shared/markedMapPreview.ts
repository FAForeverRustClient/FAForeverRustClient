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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`could not load ${src.slice(0, 40)}`));
    image.src = src;
  });
}

/** Draw the picture and its icons, as a PNG data URL. */
async function composeMarkedPreview(preview: MarkedMapPreview): Promise<string> {
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
  if (!context) throw new Error("no 2d canvas context");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(base, 0, 0, width, height);
  const icons: Record<MarkerKind, HTMLImageElement> = { hydro, mass, spawn: army };
  for (const placement of markerPlacements(preview, width, height)) {
    context.drawImage(icons[placement.kind], placement.x, placement.y, placement.width, placement.height);
  }
  return canvas.toDataURL("image/png");
}

/// Drawn pictures by map folder. A dialog reopened on the same map should not
/// read three files again, and a handful is all anybody flips between.
const drawn = new Map<string, Promise<string | null>>();
const MAX_DRAWN = 8;

function markedPreview(folderName: string): Promise<string | null> {
  const known = drawn.get(folderName);
  if (known) return known;
  const pending = native
    .readMarkedMapPreview(folderName)
    .then(composeMarkedPreview)
    // Not installed, a file missing, or a webview that cannot draw: the
    // caller keeps the picture it already had.
    .catch(() => null);
  drawn.set(folderName, pending);
  if (drawn.size > MAX_DRAWN) {
    const oldest = drawn.keys().next().value;
    if (oldest !== undefined) drawn.delete(oldest);
  }
  return pending;
}

/**
 * The drawn picture of the installed map `folderName`, or `null` while it is
 * being drawn, when it cannot be, or when there is no folder to ask about.
 */
export function useMarkedMapPreview(folderName: string | null): string | null {
  const [url, setUrl] = useState<{ folder: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!folderName) return;
    let current = true;
    void markedPreview(folderName).then((result) => {
      if (current) setUrl({ folder: folderName, url: result });
    });
    return () => {
      current = false;
    };
  }, [folderName]);
  return url && url.folder === folderName ? url.url : null;
}
