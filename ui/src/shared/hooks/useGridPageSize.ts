// How many cards a grid can show without scrolling.
//
// The installed lists paged at a fixed count, which on a tall window left half
// the panel empty under a pager and on a short one scrolled anyway. A page
// should be a page: as many rows as fit, and the next one after that.
//
// The arithmetic is separate from the measuring, because the arithmetic is
// what is worth a test and the measuring needs a browser.

import { useEffect, useState } from "react";

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

export interface PageFill {
  /// Cards on the page on screen.
  shown: number;
  /// Cards a full page holds: the reader's choice in Settings, or `fitted`.
  pageSize: number;
  /// Cards that fit on the panel, from `useGridPageSize`.
  fitted: number;
  totalPages: number;
}

/**
 * How many empty cells hold a short page at the height of a full one.
 *
 * A page of the installed maps is as many rows as fit, so on every full page
 * the pager sits at the foot of the panel. The last page is usually shorter,
 * and the pager used to rise to just under its last card, so the next click
 * meant for it landed on nothing. The cells take the places of the missing
 * cards. Never more than fit on the panel: a page size picked in Settings that
 * is taller than the panel would otherwise leave a screen of nothing to scroll
 * through. None while there is one page, since there is no pager to hold.
 */
export function pageFillerCount({ shown, pageSize, fitted, totalPages }: PageFill): number {
  if (totalPages <= 1) return 0;
  return Math.max(0, Math.min(pageSize, fitted) - shown);
}

/**
 * How many cards a page of a grid holds, and the ref that grid takes.
 *
 * A callback ref rather than a ref object, because the grid comes and goes:
 * an installed list draws it only while something matches, so a filter that
 * matches nothing takes it away, and clearing the filter puts a new one in its
 * place. This used to take a ref object, read it once when the view mounted,
 * and go on measuring that first grid after it had left the page. A grid off
 * the page has no columns, every later measurement then came to the minimum,
 * and the list came back four cards to a page (#470, on the installed mods,
 * which have since dropped paging). A list still loading when the view opened
 * had no grid yet, and was never measured at all. Now the grid in
 * use is the one measured, from the moment it is attached.
 *
 * `rowHeightPx` is the card's designed height, and the least a row is taken
 * to be. The first card's own height counts when it is taller: a card that
 * grows past its design would otherwise make every page a row too long, and
 * the pager under it would scroll out of view. The column count comes from
 * the resolved `grid-template-columns`, so an `auto-fill` track list is
 * counted rather than guessed at.
 */
export function useGridPageSize(
  rowHeightPx: number,
  fallback: number,
): [pageSize: number, gridRef: (grid: HTMLElement | null) => void] {
  const [pageSize, setPageSize] = useState(fallback);
  const [grid, setGrid] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!grid || typeof ResizeObserver === "undefined") return;

    const measure = () => {
      // A grid that has left the page has no layout to read, and what it
      // would say is "no columns". The page size stands until a grid is back.
      if (!grid.isConnected) return;
      const style = window.getComputedStyle(grid);
      const columns = style.gridTemplateColumns.split(" ").filter(Boolean).length;
      if (columns < 1) return;
      const rowGapPx = Number.parseFloat(style.rowGap) || 0;
      const cardHeightPx = grid.firstElementChild?.getBoundingClientRect().height ?? 0;
      const availableHeightPx = visibleRoomBelow(grid) - PAGER_RESERVE_PX;
      const next = gridCapacity({
        columns,
        availableHeightPx,
        rowHeightPx: Math.max(rowHeightPx, cardHeightPx),
        rowGapPx,
      });
      // Only on a real change. Writing state from inside a `ResizeObserver`
      // callback that then resizes the observed element is how the loop
      // warning happens.
      setPageSize((current) => (current === next ? current : next));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    // The window resizing changes the scroll area; a search panel opening
    // above the grid moves its top edge, which only the view around it
    // reports, by growing.
    const scroller = grid.closest(".content");
    if (scroller) observer.observe(scroller);
    const view = grid.closest(".content-inner")?.firstElementChild;
    if (view) observer.observe(view);
    return () => observer.disconnect();
  }, [grid, rowHeightPx]);

  return [pageSize, setGrid];
}

/**
 * How much of the scroll area's visible height is left below the grid's top
 * edge, with the area scrolled to the top: what one screen holds without
 * scrolling.
 *
 * The visible height of the scroll area, not the bottom of the panel inside
 * it. The panel grows with what it holds, so once a page was taller than the
 * screen the panel's bottom was the page's own, the page measured itself as
 * fitting, and every page stayed a screen and more tall: on the last page
 * that was a screen of empty places with the pager under them. Counted from
 * where the grid starts in the area rather than on screen, so scrolling the
 * page does not change the answer.
 */
function visibleRoomBelow(grid: HTMLElement): number {
  const scroller = grid.closest(".content");
  if (!scroller) return window.innerHeight - grid.getBoundingClientRect().top;
  const gridTop = grid.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  // The panel's own padding under its last line, which the page has to
  // leave free or the area scrolls by that much.
  const panel = grid.closest(".content-inner");
  const panelPaddingPx = panel ? Number.parseFloat(window.getComputedStyle(panel).paddingBottom) || 0 : 0;
  return scroller.clientHeight - gridTop - panelPaddingPx;
}
