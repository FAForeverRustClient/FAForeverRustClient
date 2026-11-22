import { useLayoutEffect, useRef, type RefObject } from "react";

const SCROLL_FLOOR = "--tournament-scroll-floor";

function holdOffset(pane: HTMLElement, row: HTMLElement, offset: number) {
  if (offset === 0) {
    row.style.removeProperty(SCROLL_FLOOR);
    return;
  }

  const viewportTop = pane.getBoundingClientRect().top + pane.clientTop;
  const rowTop = row.getBoundingClientRect().top - viewportTop + pane.scrollTop;
  const padding = Number.parseFloat(getComputedStyle(pane).paddingBottom) || 0;
  const height = Math.max(0, Math.ceil(pane.clientHeight - rowTop + offset - padding));
  row.style.setProperty(SCROLL_FLOOR, `${height}px`);
}

/** Preserve the visible header when switching to a section with less content. */
export function useTournamentSectionScroll(
  paneRef: RefObject<HTMLDivElement>,
  rowRef: RefObject<HTMLDivElement>,
  tabsRef: RefObject<HTMLElement>,
) {
  const requested = useRef<number | null>(null);
  const held = useRef(0);

  useLayoutEffect(() => {
    const pane = paneRef.current;
    const row = rowRef.current;
    if (pane === null || row === null) return;
    const offset = requested.current;
    if (offset !== null) {
      requested.current = null;
      held.current = offset;
    }
    holdOffset(pane, row, held.current);
    if (offset !== null) pane.scrollTop = offset;
  });

  useLayoutEffect(() => {
    const pane = paneRef.current;
    const row = rowRef.current;
    if (pane === null || row === null) return;
    // The allowance can shrink on the way back up. It never gives the user
    // more room to scroll down than the position they started at.
    const onScroll = () => {
      if (pane.scrollTop >= held.current) return;
      held.current = Math.max(0, pane.scrollTop);
      holdOffset(pane, row, held.current);
    };
    const observer = new ResizeObserver(() => holdOffset(pane, row, held.current));
    observer.observe(pane);
    pane.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      pane.removeEventListener("scroll", onScroll);
    };
  }, [paneRef, rowRef]);

  return (fromTabs: boolean) => {
    const pane = paneRef.current;
    const tabs = tabsRef.current;
    if (pane === null || tabs === null) return;
    const scroll = Math.max(0, pane.scrollTop);
    // A section link may be far below the tab strip. Open at the tabs in
    // that case, so the start of the new section is visible.
    const tabsOffset = scroll + tabs.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientTop;
    requested.current = fromTabs ? scroll : Math.min(scroll, Math.max(0, tabsOffset));
  };
}
