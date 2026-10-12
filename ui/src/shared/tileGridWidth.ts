// How wide the custom games tile grid was when it was last on screen, for the
// Settings tab to say when the chosen tiles per row squeeze the tiles.
//
// The setting is obeyed exactly: picking five draws five, however narrow they
// come out. Quietly showing fewer than were picked read as a setting that did
// nothing, so the grid does as told and Settings says what it costs.
//
// A module rather than the store: this is a measurement of the window on this
// machine, not a setting or anything the backend knows, and its one reader is
// a warning.

import { useSyncExternalStore } from "react";

/**
 * The narrowest a tile still reads well. Below it the title is down to a few
 * words and the bottom line (the slots, the count, the rating and the age)
 * runs out of room: at 320 px it was 7 px short.
 */
export const COMFORTABLE_TILE_PX = 340;

/** The gap between two tiles, `--space-3` on `.game-tile-grid`. */
const TILE_GAP_PX = 12;

let lastWidth = 0;
const listeners = new Set<() => void>();

/**
 * Record the grid's content width. A hidden grid measures 0, and that keeps
 * the last real width rather than forgetting it: the tab is hidden whenever
 * Settings is the one being read.
 */
export function rememberTileGridWidth(width: number): void {
  const rounded = Math.round(width);
  if (rounded <= 0 || rounded === lastWidth) return;
  lastWidth = rounded;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The grid's width when last on screen, or 0 before tiles have been shown. */
export function useTileGridWidth(): number {
  return useSyncExternalStore(subscribe, () => lastWidth, () => 0);
}

/** How wide each tile is with `columns` of them in a grid `width` wide. */
export function tileWidthFor(width: number, columns: number): number {
  return (width - (columns - 1) * TILE_GAP_PX) / columns;
}

/** The most tiles per row that stay at least comfortable, and never fewer than one. */
export function comfortableTileColumns(width: number): number {
  return Math.max(1, Math.floor((width + TILE_GAP_PX) / (COMFORTABLE_TILE_PX + TILE_GAP_PX)));
}
