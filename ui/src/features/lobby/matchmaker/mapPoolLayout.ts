// How the matchmaker's map pool dialog lays out its tiles.
//
// The whole pool at once, without a scrollbar: a player choosing what to veto
// compares every map with every other, and a grid that scrolled hid half of
// them behind the other half. So the column count and the tile size are worked
// out from the number of maps and the room the window leaves, and a large
// pool gets smaller tiles rather than a second screen.
//
// Arithmetic rather than rendering, so it is tested on its own; the hook below
// only measures the room and hands it over.

import { useLayoutEffect, useState, type RefObject } from "react";

/** Space between two tiles, both ways. Matches `.map-pool-grid`'s `gap`. */
export const MAP_POOL_GAP = 10;

/**
 * The strip under a tile's picture: name and size line, and the name alone.
 * Both follow from `.map-pool-card-foot` in `matchmaker.css`, whose padding
 * and line heights are set in pixels so these stay true.
 */
export const MAP_POOL_FOOT = 45;
export const MAP_POOL_COMPACT_FOOT = 29;

/** Below this edge the size line goes, which buys the picture its height. */
export const MAP_POOL_COMPACT_BELOW = 128;

/**
 * Smallest tile before the dialog gives up and scrolls. A name is cut short
 * this small, and the card's tooltip carries it whole; it takes over 36 maps
 * to come down to it in a 1100x720 window.
 */
export const MAP_POOL_MIN_TILE = 64;

/** Largest tile: past this a small pool only makes the dialog emptier. */
export const MAP_POOL_MAX_TILE = 220;

export interface MapPoolLayout {
  columns: number;
  /** Edge of a tile's square picture, in pixels. */
  tile: number;
  /** Whether the tiles show the name without the size line under it. */
  compact: boolean;
}

/**
 * The columns and tile size that show `count` maps in a box of `width` by
 * `height` pixels, with the largest tiles that fit.
 *
 * Every column count is tried: the width decides how wide a tile may be, the
 * rows that count needs decide how tall, and the smaller of the two is the
 * tile. Where several counts reach the same size, which a small pool does as
 * soon as the tiles hit their ceiling, the one leaving the fewest holes in the
 * last row wins, then the wider one: a window is wider than it is tall.
 *
 * Only when not even the smallest readable tile fits does the grid keep that
 * size and leave the rest to the dialog's scrollbar.
 */
export function fitMapPool(count: number, width: number, height: number): MapPoolLayout {
  const maps = Math.max(1, count);
  // The size line goes only where the tile is small anyway: a full tile at or
  // above that edge is never traded for a slightly larger compact one.
  const full = largestTile(maps, width, height, false);
  const best = full.tile >= MAP_POOL_COMPACT_BELOW ? full : largestTile(maps, width, height, true);
  if (best.tile >= MAP_POOL_MIN_TILE) return best;
  // Too many maps for the window: the smallest tile, as many to a row as fit.
  const columns = Math.max(1, Math.min(maps, Math.floor((width + MAP_POOL_GAP) / (MAP_POOL_MIN_TILE + MAP_POOL_GAP))));
  return { columns, tile: MAP_POOL_MIN_TILE, compact: true };
}

function largestTile(maps: number, width: number, height: number, compact: boolean): MapPoolLayout {
  const foot = compact ? MAP_POOL_COMPACT_FOOT : MAP_POOL_FOOT;
  let best = { columns: 1, tile: Number.NEGATIVE_INFINITY, compact, holes: 0 };
  for (let columns = 1; columns <= maps; columns++) {
    const rows = Math.ceil(maps / columns);
    const byWidth = (width - (columns - 1) * MAP_POOL_GAP) / columns;
    const byHeight = (height - (rows - 1) * MAP_POOL_GAP) / rows - foot;
    const tile = Math.floor(Math.min(byWidth, byHeight, MAP_POOL_MAX_TILE));
    const holes = rows * columns - maps;
    const better =
      tile > best.tile ||
      (tile === best.tile && (holes < best.holes || (holes === best.holes && columns > best.columns)));
    if (better) best = { columns, tile, compact, holes };
  }
  return { columns: best.columns, tile: best.tile, compact };
}

/** Distance the dialog keeps from the window's left and right edges, and from
 *  its top and bottom. Wider at the sides, so the dialog never runs edge to
 *  edge. `.matchmaker-map-pool-modal`'s `max-width` and `max-height` are
 *  twice these. */
const WINDOW_MARGIN_X = 64;
const WINDOW_MARGIN_Y = 24;

/**
 * The layout for a pool of `count` maps whose tile grid is `gridRef`, a
 * direct child of the dialog's `.modal-panel`.
 *
 * The room for the grid is the window less the margin, less everything in the
 * dialog that is not the grid: header, bracket tabs, veto toolbar, buttons and
 * the panel's own padding. That is measured rather than assumed, because a
 * translation or a long bracket list makes it taller, and measured again
 * whenever the window or any of those parts changes size, and after every new
 * layout, so a toolbar that wraps once the dialog is narrower is counted on
 * the next pass. It settles as soon as a pass changes nothing.
 */
export function useMapPoolLayout(count: number, gridRef: RefObject<HTMLElement | null>): MapPoolLayout {
  const [layout, setLayout] = useState<MapPoolLayout>(() =>
    typeof window === "undefined"
      ? fitMapPool(count, 900, 600)
      : fitMapPool(count, window.innerWidth * 0.8, window.innerHeight * 0.5),
  );

  useLayoutEffect(() => {
    const grid = gridRef.current;
    const panel = grid?.closest<HTMLElement>(".modal-panel");
    if (!grid || !panel) return;

    const measure = () => {
      const style = getComputedStyle(panel);
      const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const borderX = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      const borderY = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      // `scrollHeight` is the panel's padding and everything in it, so taking
      // the grid away leaves the chrome around it.
      const chrome = panel.scrollHeight - grid.offsetHeight + borderY;
      const width = window.innerWidth - 2 * WINDOW_MARGIN_X - paddingX - borderX;
      const height = window.innerHeight - 2 * WINDOW_MARGIN_Y - chrome;
      const next = fitMapPool(count, width, height);
      setLayout((current) =>
        current.columns === next.columns && current.tile === next.tile && current.compact === next.compact
          ? current
          : next,
      );
    };

    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (const part of Array.from(panel.children)) {
      if (part !== grid) observer?.observe(part);
    }
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [count, gridRef, layout]);

  return layout;
}
