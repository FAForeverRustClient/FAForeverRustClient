// How many cards a grid can show without scrolling.
//
// The installed lists paged at a fixed count, which on a tall window left half
// the panel empty under a pager and on a short one scrolled anyway. A page
// should be a page: as many rows as fit, and the next one after that.
//
// The arithmetic is separate from the measuring, because the arithmetic is
// what is worth a test and the measuring needs a browser.

import { useEffect, useState, type RefObject } from "react";

/// Height left for the pager under the grid, so the last row is not hidden
/// behind it. Matches `.vault-pagination`'s own height plus its margin.
const PAGER_RESERVE_PX = 56;

/// Never fewer than this, whatever a very short window measures: a page of one
/// card with a pager under it is worse than a little scrolling.
const MIN_PAGE_SIZE = 4;

export interface GridMetrics {
  /// Tracks the grid resolved to, which `auto-fill` decides from the width.
  columns: number;
  /// Room between the top of the grid and the bottom of the panel.
  availableHeightPx: number;
  /// What one card occupies, without the gap under it.
  rowHeightPx: number;
  rowGapPx: number;
}

/**
 * How many cards fill the space, rounded down to whole rows.
 *
 * Whole rows on purpose: a page that ends halfway through a row leaves a
 * ragged edge above the pager and makes the count depend on the window's
 * width in a way nobody can predict.
 */
export function gridCapacity({
  columns,
  availableHeightPx,
  rowHeightPx,
  rowGapPx,
}: GridMetrics): number {
  if (columns < 1 || rowHeightPx <= 0) return MIN_PAGE_SIZE;
  // The last row needs no gap under it, so the space is one gap larger than a
  // naive division assumes.
  const rows = Math.floor((availableHeightPx + rowGapPx) / (rowHeightPx + rowGapPx));
  return Math.max(MIN_PAGE_SIZE, columns * Math.max(1, rows));
}

/**
 * Measure the grid `ref` points at and answer how many cards a page holds.
 *
 * `rowHeightPx` is the card's designed height, because the grid is empty on
 * the first measurement and there is nothing to read a height off yet. The
 * column count comes from the resolved `grid-template-columns`, so an
 * `auto-fill` track list is counted rather than guessed at.
 */
export function useGridPageSize(
  ref: RefObject<HTMLElement | null>,
  rowHeightPx: number,
  fallback: number,
): number {
  const [pageSize, setPageSize] = useState(fallback);

  useEffect(() => {
    const grid = ref.current;
    if (!grid || typeof ResizeObserver === "undefined") return;

    const measure = () => {
      const style = window.getComputedStyle(grid);
      const columns = style.gridTemplateColumns.split(" ").filter(Boolean).length;
      const rowGapPx = Number.parseFloat(style.rowGap) || 0;
      // The panel the grid sits in, not the grid: the grid's own height is
      // what this decides, so reading it back would be circular. The grid's
      // top edge does not depend on how many cards are in it, because nothing
      // below it pushes back.
      const panel = grid.closest(".content-inner") ?? document.documentElement;
      const availableHeightPx =
        panel.getBoundingClientRect().bottom
        - grid.getBoundingClientRect().top
        - PAGER_RESERVE_PX;
      const next = gridCapacity({ columns, availableHeightPx, rowHeightPx, rowGapPx });
      // Only on a real change. Writing state from inside a `ResizeObserver`
      // callback that then resizes the observed element is how the loop
      // warning happens.
      setPageSize((current) => (current === next ? current : next));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    const panel = grid.closest(".content-inner");
    if (panel) observer.observe(panel);
    return () => observer.disconnect();
  }, [ref, rowHeightPx]);

  return pageSize;
}
