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
import { fromDrawnOrder, inDrawnOrder, type ColumnList } from "../columnOrder";
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
  /** The widths as stored, one per designed column: the drag in progress, or what was saved. */
  widths: number[];
  /**
   * What to draw with: `widths` fitted to the list's space, in the order the
   * columns are drawn. See the note on fitting in `tableColumns`.
   */
  drawn: number[];
  /** The drawn position of the flexible column. */
  flexible: number;
  /**
   * For the element whose width the columns share: a grid list's header row,
   * or a table.
   */
  containerRef: (element: HTMLElement | null) => void;
  /**
   * Where the divider in front of drawn position `boundary` has been dragged to: pixels from
   * where the drag began, not since the last pointer move. The column before
   * the line grows by what the column after it gives up, so the line moves and
   * nothing else does.
   */
  onDrag: (boundary: number, delta: number) => void;
  /** A drag starts from this divider: it measures where the columns stand. */
  onStart: (handle: HTMLElement) => void;
  /** The drag ended: persist it. */
  onCommit: () => void;
  /** Back to the designed widths, and the designed order, and stay there across a restart. */
  onReset: () => void;
}

/** A list whose columns can be moved: which one, and its current order. */
export interface ColumnArrangement {
  list: ColumnList;
  order: readonly number[];
}

/**
 * @param field which browsing preference holds this table's widths
 * @param defaults the designed widths, in the order the columns are drawn
 * @param flexible which column has no width of its own and takes what is left
 */
export function useColumnWidths(
  field: ColumnField,
  defaults: readonly number[],
  flexible: number,
  layout: "grid" | "table" = "table",
  flexibleFloor = 80,
  arrangement?: ColumnArrangement,
): ColumnWidths {
  const order = arrangement?.order ?? defaults.map((_, index) => index);
  const stored = useAppStore((state) => state.state.settings.browsing[field]);
  // Local until the pointer is released: persisting per frame would write a
  // settings file on every mouse move.
  const [dragged, setDragged] = useState<number[] | null>(null);
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
  const flexibleAt = order.indexOf(flexible);

  // One write for the widths and, on a reset, the order as well: two writes
  // in a row would each start from the settings as they were, and the second
  // would put back what the first had just cleared.
  const save = (widths: number[], resetOrder = false) => {
    const browsing = useAppStore.getState().state.settings.browsing;
    const columnOrders = { ...browsing.columnOrders };
    if (resetOrder && arrangement) delete columnOrders[arrangement.list];
    ipc.send({
      kind: "Settings",
      command: { type: "setBrowsing", payload: { preferences: { ...browsing, [field]: widths, columnOrders } } },
    });
  };

  return {
    widths: current,
    drawn: scaledWidths(inDrawnOrder(current, order), scale),
    flexible: flexibleAt,
    containerRef: setContainer,
    onStart: (handle) => {
      dragScale.current = scale;
      // A list wider than its columns draws the flexible column wider than
      // its stored width. The drag starts from what is on screen, or the
      // divider would jump by the difference. The header's cells are in
      // drawn order, so the flexible one is found at its drawn position.
      const drawnFlexible = scale >= 1 ? drawnColumnWidth(handle, flexibleAt) : null;
      origin.current = drawnFlexible === null
        ? current
        : current.map((width, index) => (index === flexible ? Math.max(width, drawnFlexible) : width));
    },
    onDrag: (boundary, delta) => {
      const base = (origin.current ??= current);
      // The divider stands between two drawn neighbours, which need not be
      // neighbours by design once columns have been moved.
      const traded = withBoundaryTraded(
        inDrawnOrder(base, order),
        boundary,
        delta / dragScale.current,
        (position) => floorOf(order[position]),
      );
      setDragged(fromDrawnOrder(traded, order, base));
    },
    onCommit: () => {
      origin.current = null;
      dragScale.current = 1;
      if (dragged) save(dragged);
      setDragged(null);
    },
    // An empty array is the reset: the backend keeps it and the resolve above
    // reads it back as "use the designed widths", so a reset survives a
    // restart the same way a drag does.
    onReset: () => {
      origin.current = null;
      setDragged(null);
      save([], true);
    },
  };
}
