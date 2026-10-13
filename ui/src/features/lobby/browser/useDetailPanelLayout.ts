// The details panel beside the custom games list: how wide it is, whether it
// is folded away, and whether an empty one steps aside so the list keeps its
// columns. Which game it shows is the Play tab's; a click picks one through
// `selectGame` here, so the panel can wait out a double click first.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CustomGameBrowserPreferences, Game, JoinState } from "../../../ipc/bindings";
import type { GameViewMode } from "../../../shared/gameRules";
import { useAppStore } from "../../../store/store";
import { columnWidths, detailWidth, emptyDetailGivesWay, withDetailResized } from "./browserLayout";

/**
 * How long a click waits for a second one: Windows' default double-click
 * time, which the webview follows. See `selectGame` below.
 */
const DOUBLE_CLICK_MS = 500;

export type DetailPanelLayout = ReturnType<typeof useDetailPanelLayout>;

export function useDetailPanelLayout({
  selected,
  join,
  gameView,
  gameBrowser,
  setSelectedId,
  updateGameBrowser,
}: {
  /** The game the player picked, while the list still shows it. */
  selected: Game | null;
  join: JoinState;
  gameView: GameViewMode;
  gameBrowser: CustomGameBrowserPreferences;
  /** The Play tab's own setter: stable, so `selectGame` is too. */
  setSelectedId: (id: number | null) => void;
  updateGameBrowser: (changes: Partial<CustomGameBrowserPreferences>) => void;
}) {
  // Same shape as the list's column drag: the saved width seeds a local copy,
  // the drag moves the copy, and letting go persists it. A settings write per
  // pointer move would be a backend round trip per pixel.
  const savedDetailWidth = useAppStore(
    (state) => state.state.settings.browsing.customGamesBrowser.detailWidth,
  );
  const [draggedDetailWidth, setDraggedDetailWidth] = useState<number | null>(null);
  const detailDragOrigin = useRef<number | null>(null);
  const detailHidden = useAppStore(
    (state) => state.state.settings.browsing.customGamesBrowser.detailHidden,
  );
  const currentDetailWidth = draggedDetailWidth ?? detailWidth(savedDetailWidth);
  // How wide the list and the panel are together, for the empty panel below.
  const [layoutElement, setLayoutElement] = useState<HTMLDivElement | null>(null);
  const [layoutWidth, setLayoutWidth] = useState(0);
  useEffect(() => {
    if (!layoutElement || typeof ResizeObserver === "undefined") return;
    const measure = () => setLayoutWidth(layoutElement.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layoutElement);
    return () => observer.disconnect();
  }, [layoutElement]);
  // With no game picked and nothing to report, the panel only says "select a
  // game", and in list view it steps aside wherever the list would otherwise
  // have to draw its columns narrower than they are (`emptyDetailGivesWay`).
  // Never while its own divider is held: a panel that vanished under the
  // pointer would be the strangest thing a drag could do.
  const detailEmpty = !selected && join.type !== "failed";
  // A click that picks a game while the empty panel has stepped aside brings
  // the panel back, and the list narrows under the pointer. A double click is
  // two clicks, so its second one landed on whatever had moved there (at
  // 1100 by 720, the map preview) instead of joining the game. The panel
  // waits out the double-click interval before it takes its room back.
  const [revealHeld, setRevealHeld] = useState(false);
  const revealTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(revealTimer.current), []);
  // Asked for from the toolbar while it had stepped aside: the empty panel
  // then stays until it is folded away. The toolbar's button shows what is on
  // screen, so it read "Show the details panel" there, and a press that left
  // the panel away would have been a button that does nothing.
  const [emptyKept, setEmptyKept] = useState(false);
  const detailGivesWay =
    revealHeld ||
    (detailEmpty &&
      !emptyKept &&
      gameView === "list" &&
      draggedDetailWidth === null &&
      emptyDetailGivesWay(layoutWidth, currentDetailWidth, columnWidths(gameBrowser.columnWidths)));
  // Read by the click handler, which outlives the render it was made in.
  const panelAway = useRef(detailGivesWay);
  useEffect(() => {
    panelAway.current = detailGivesWay;
  });
  const selectGame = useCallback((id: number | null) => {
    if (id !== null && panelAway.current) {
      setRevealHeld(true);
      window.clearTimeout(revealTimer.current);
      revealTimer.current = window.setTimeout(() => setRevealHeld(false), DOUBLE_CLICK_MS);
    }
    setSelectedId(id);
  }, [setSelectedId]);
  const detailShown = !detailHidden && !detailGivesWay;
  const toggleDetails = () => {
    setEmptyKept(!detailShown);
    // Folding a panel that only stepped aside was the old press here: it
    // changed nothing on screen and saved the panel as folded, so the next
    // game picked opened without it.
    if (detailShown || detailHidden) updateGameBrowser({ detailHidden: detailShown });
  };
  const detailStyle = useMemo(
    // The divider's track is the whole gap, as the chat roster's is, so the
    // two tabs space their side panel the same. Folded away (#370, #377), or
    // empty and stepped aside, the list takes the whole width: the toolbar
    // holds the button that folds and unfolds the panel, so the gap has
    // nothing left to hold.
    () => ({
      gridTemplateColumns: detailShown
        ? `minmax(360px, 1fr) var(--space-3) ${currentDetailWidth}px`
        : "minmax(360px, 1fr)",
    }),
    [currentDetailWidth, detailShown],
  );
  const onDetailDrag = (delta: number) => {
    detailDragOrigin.current ??= currentDetailWidth;
    setDraggedDetailWidth(withDetailResized(detailDragOrigin.current, delta));
  };
  const onDetailCommit = () => {
    detailDragOrigin.current = null;
    if (draggedDetailWidth !== null) updateGameBrowser({ detailWidth: draggedDetailWidth });
    setDraggedDetailWidth(null);
  };
  const onDetailReset = () => {
    detailDragOrigin.current = null;
    setDraggedDetailWidth(null);
    updateGameBrowser({ detailWidth: 0 });
  };

  return {
    setLayoutElement,
    selectGame,
    detailShown,
    toggleDetails,
    detailStyle,
    onDetailDrag,
    onDetailCommit,
    onDetailReset,
  };
}
