// Draggable column widths, stored per table.
//
// The replay list grew this first and the live-replay and co-op tables wanted
// the same thing, which is the moment to have one of it rather than three.
// Every table brings its own designed widths, its own settings field and its
// own flexible column; the clamping, the "local while dragging, saved on
// release" split, and the reset are the same for all of them. What a drag
// actually does to the widths lives in `tableColumns`, which the game
// browser's grid shares.

import { useEffect, useRef, useState } from "react";
import type { BrowsingPreferences } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { MIN_BROWSER_COLUMN_PX } from "../browsingPreferences";
import {
  drawnColumnWidth,
  fitScale,
  gridColumnSpace,
  resolveColumnWidths,
  scaledWidths,
  withBoundaryTraded,
} from "../tableColumns";

/** The settings fields that hold a table's column widths. */
type ColumnField = {
  [K in keyof BrowsingPreferences]: BrowsingPreferences[K] extends number[] ? K : never;
}[keyof BrowsingPreferences];

export interface ColumnWidths {
  /** The widths as stored: the drag in progress, or what was saved. */
  widths: number[];
  /**
   * What to draw with: `widths` fitted to the list's space. See the note on
   * fitting in `tableColumns`.
   */
  drawn: number[];
  /**
   * For the element whose width the columns share: a grid list's header row,
   * or a table.
   */
  containerRef: (element: HTMLElement | null) => void;
  /**
   * Where the divider in front of `boundary` has been dragged to: pixels from
   * where the drag began, not since the last pointer move. The column before
   * the line grows by what the column after it gives up, so the line moves and
   * nothing else does.
   */
  onDrag: (boundary: number, delta: number) => void;
  /** A drag starts from this divider: it measures where the columns stand. */
  onStart: (handle: HTMLElement) => void;
  /** The drag ended: persist it. */
  onCommit: () => void;
  /** Back to the designed widths, and stay there across a restart. */
  onReset: () => void;
  /** Drop any local widths, for a reset that saves the designed ones itself. */
  clear: () => void;
}

/**
 * @param field which browsing preference holds this table's widths
 * @param defaults the designed widths, in the order the columns are drawn
 * @param flexible which column has no width of its own and takes what is left
 * @param order for a table whose columns can be moved: the column drawn at
 *   each position. A divider's `boundary` is then a drawn position, and the
 *   two columns it trades between are the ones either side of it on screen.
 */
export function useColumnWidths(
  field: ColumnField,
  defaults: readonly number[],
  flexible: number,
  layout: "grid" | "table" = "table",
  flexibleFloor = 80,
  order?: readonly number[],
): ColumnWidths {
  const stored = useAppStore((state) => state.state.settings.browsing[field]);
  // Local until the pointer is released: persisting per frame would write a
  // settings file on every mouse move. And local until the saved widths come
  // back after that: dropped at release, the old widths showed for the length
  // of the round trip and a released divider flickered back before landing.
  const [dragged, setDragged] = useState<number[] | null>(null);
  const storedKey = (stored ?? []).join(",");
  useEffect(() => setDragged(null), [storedKey]);
  // The widths the drag started from. `ResizeHandle` reports the distance from
  // where the pointer went down, so every move has to be measured against the
  // same widths; adding each report to the last one instead makes a column run
  // away from the cursor, faster the further it is dragged.
  const origin = useRef<number[] | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [space, setSpace] = useState(0);
  useEffect(() => {
    if (!container || typeof ResizeObserver === "undefined") return;
    const measure = () =>
      setSpace(layout === "grid" ? gridColumnSpace(container, defaults.length) : container.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [container, layout, defaults.length]);

  // The scale a drag started at: the pointer moves in drawn pixels.
  const dragScale = useRef(1);
  const floorOf = (index: number) => (index === flexible ? flexibleFloor : MIN_BROWSER_COLUMN_PX);

  const resolve = () => resolveColumnWidths(stored, defaults);
  const current = dragged ?? resolve();
  const scale = fitScale(space, current);

  const save = (widths: number[]) => {
    ipc.send({
      kind: "Settings",
      command: { type: "patchBrowsing", payload: { patch: { [field]: widths } } },
    });
  };

  return {
    widths: current,
    drawn: scaledWidths(current, scale),
    containerRef: setContainer,
    onStart: (handle) => {
      dragScale.current = scale;
      // A list wider than its columns draws the flexible column wider than
      // its stored width. The drag starts from what is on screen, or the
      // divider would jump by the difference.
      const drawnFlexible = scale >= 1 ? drawnColumnWidth(handle, flexible) : null;
      origin.current = drawnFlexible === null
        ? current
        : current.map((width, index) => (index === flexible ? Math.max(width, drawnFlexible) : width));
    },
    onDrag: (boundary, delta) => {
      const base = (origin.current ??= current);
      if (!order) {
        setDragged(withBoundaryTraded(base, boundary, delta / dragScale.current, floorOf));
        return;
      }
      // Traded in drawn order, stored in designed order.
      const traded = withBoundaryTraded(
        order.map((column) => base[column]),
        boundary,
        delta / dragScale.current,
        (position) => floorOf(order[position]),
      );
      const next = [...base];
      order.forEach((column, position) => {
        next[column] = traded[position];
      });
      setDragged(next);
    },
    onCommit: () => {
      origin.current = null;
      dragScale.current = 1;
      if (dragged) save(dragged);
    },
    clear: () => {
      origin.current = null;
      setDragged(null);
    },
    // An empty array is the reset: the backend keeps it and the resolve above
    // reads it back as "use the designed widths", so a reset survives a
    // restart the same way a drag does.
    onReset: () => {
      origin.current = null;
      setDragged(null);
      save([]);
    },
  };
}
