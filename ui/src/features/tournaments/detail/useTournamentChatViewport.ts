import { useCallback, useLayoutEffect, type RefObject } from "react";

/** Keep the chat's bottom inside the pane without shrinking its scroll range. */
export function useTournamentChatViewport(
  paneRef: RefObject<HTMLDivElement | null>,
  rowRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  const resize = useCallback(() => {
    const pane = paneRef.current;
    const row = rowRef.current;
    if (pane === null || row === null) return;
    const bottom = pane.getBoundingClientRect().top + pane.clientTop + pane.clientHeight;
    const padding = Number.parseFloat(getComputedStyle(pane).paddingBottom) || 0;
    const height = Math.max(0, Math.floor(bottom - row.getBoundingClientRect().top - padding));
    const value = `${height}px`;
    if (row.style.getPropertyValue("--tournament-chat-height") !== value) {
      row.style.setProperty("--tournament-chat-height", value);
    }
  }, [paneRef, rowRef]);
  useLayoutEffect(() => { if (enabled) resize(); });
  useLayoutEffect(() => {
    const pane = paneRef.current;
    const row = rowRef.current;
    if (!enabled || pane === null || row === null) return;
    const observer = new ResizeObserver(resize);
    observer.observe(pane);
    for (const child of pane.children) {
      if (child !== row) observer.observe(child);
    }
    pane.addEventListener("scroll", resize, { passive: true });
    window.addEventListener("resize", resize);
    resize();
    return () => {
      observer.disconnect();
      pane.removeEventListener("scroll", resize);
      window.removeEventListener("resize", resize);
      row.style.removeProperty("--tournament-chat-height");
    };
  }, [paneRef, rowRef, enabled, resize]);
}
