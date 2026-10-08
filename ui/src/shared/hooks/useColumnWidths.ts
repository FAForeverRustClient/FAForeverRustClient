// Draggable column widths, stored per table.
//
// The replay list grew this first and the live-replay and co-op tables wanted
// the same thing, which is the moment to have one of it rather than three.
// Every table brings its own designed widths, its own settings field, its own
// flexible column and its own floors; the clamping, the fitting, the "local
// while dragging, saved on release" split, and the reset are the same for all
// of them. What a drag actually does to the widths, and how they are fitted to
// the space, lives in `tableColumns`, which the game browser's grid shares.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BrowsingPreferences } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { MIN_BROWSER_COLUMN_PX } from "../browsingPreferences";
import {
  drawnColumnWidth,
  fitColumns,
  gridColumnSpace,
  resolveColumnWidths,
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
   * What to draw with: `widths` fitted to the list's space, no column under
   * its floor. See the note on fitting in `tableColumns`.
   */
  drawn: number[];
  /**
   * Every column is at its floor and they still do not fit: the list has to be
   * wider than its space and scroll sideways. A table is handled here (see the
   * layout effect below); a grid list reads this and widens its own rows.
   */
  overflow: boolean;
  /** The drawn columns' combined width, gaps and padding not included. */
  total: number;
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

/** The flexible column's floor when a list does not declare one: a word or two of a name. */
const FLEXIBLE_FLOOR_PX = 80;

/**
 * @param field which browsing preference holds this table's widths
 * @param defaults the designed widths, in the order the columns are drawn
 * @param flexible which column takes what the others leave
 * @param layout a CSS grid list, or a real table with a colgroup
 * @param floors the narrowest each column is drawn, in designed order: what
 *   its controls need, or where its text stops being readable. A column
 *   without one gets a pixel, the flexible column a word or two.
 * @param order for a table whose columns can be moved: the column drawn at
 *   each position. A divider's `boundary` is then a drawn position, and the
 *   two columns it trades between are the ones either side of it on screen.
 */
export function useColumnWidths(
  field: ColumnField,
  defaults: readonly number[],
  flexible: number,
  {
    layout = "table",
    floors,
    order,
  }: {
    layout?: "grid" | "table";
    floors?: readonly number[];
    order?: readonly number[];
  } = {},
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
  // The newest widths a drag produced, for the commit. A keyboard nudge drags
  // and commits in one event, before React has re-rendered, so `dragged` as
  // this render saw it was still the widths from before the nudge, and the
  // nudge was never saved.
  const latest = useRef<number[] | null>(null);
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
  const drawnFloors = defaults.map((_, index) =>
    floors?.[index] ?? (index === flexible ? FLEXIBLE_FLOOR_PX : MIN_BROWSER_COLUMN_PX),
  );
  // A floor is in drawn pixels and a drag trades stored ones: at half scale a
  // column reaches its floor at twice its floor's width.
  const storedFloorOf = (index: number) => drawnFloors[index] / dragScale.current;

  const resolve = () => resolveColumnWidths(stored, defaults);
  const current = dragged ?? resolve();
  const fit = fitColumns(current, drawnFloors, space);
  const { scale } = fit;

  // A table whose floors do not fit has to be wider than its scroller, and its
  // scroller hides sideways overflow so that a window being resized never
  // flashes a scrollbar while the widths catch up. So such a table is given
  // the floors' width outright, which also keeps the flexible column (which
  // has no width in the colgroup) from being squeezed to nothing, and is
  // marked so its scroller lets it scroll sideways. Done here rather than by
  // each table, so every list that uses this gets it.
  useLayoutEffect(() => {
    if (layout !== "table" || !container) return;
    if (fit.overflow) {
      container.style.minWidth = `${fit.total}px`;
      container.dataset.columnsOverflow = "";
    } else {
      container.style.removeProperty("min-width");
      delete container.dataset.columnsOverflow;
    }
  }, [container, layout, fit.overflow, fit.total]);

  const save = (widths: number[]) => {
    ipc.send({
      kind: "Settings",
      command: { type: "patchBrowsing", payload: { patch: { [field]: widths } } },
    });
  };

  return {
    widths: current,
    drawn: fit.drawn,
    overflow: fit.overflow,
    total: fit.total,
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
        const next = withBoundaryTraded(base, boundary, delta / dragScale.current, storedFloorOf);
        latest.current = next;
        setDragged(next);
        return;
      }
      // Traded in drawn order, stored in designed order.
      const traded = withBoundaryTraded(
        order.map((column) => base[column]),
        boundary,
        delta / dragScale.current,
        (position) => storedFloorOf(order[position]),
      );
      const next = [...base];
      order.forEach((column, position) => {
        next[column] = traded[position];
      });
      latest.current = next;
      setDragged(next);
    },
    onCommit: () => {
      const widths = latest.current ?? dragged;
      origin.current = null;
      latest.current = null;
      dragScale.current = 1;
      if (widths) save(widths);
    },
    clear: () => {
      origin.current = null;
      latest.current = null;
      setDragged(null);
    },
    // An empty array is the reset: the backend keeps it and the resolve above
    // reads it back as "use the designed widths", so a reset survives a
    // restart the same way a drag does.
    onReset: () => {
      origin.current = null;
      latest.current = null;
      setDragged(null);
      save([]);
    },
  };
}
