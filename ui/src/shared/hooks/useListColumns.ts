// A list's columns, wired once: widths that can be dragged, an order that can
// be changed by dragging a header or with Alt and an arrow key, and the double
// click on a divider that puts both back as designed.
//
// Every list view with a header row uses this (the replay lists, the live
// table, the matchmaker's recent games), so a change to how columns behave is
// made here and reaches all of them. The Play tab's game list keeps its own
// width arithmetic, which predates the shared one, and shares the order half
// through `useColumnOrder`. What the header looks like is `list-head.css`.

import { useMemo, type RefObject } from "react";
import type { BrowsingPreferences } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { useColumnOrder, type MovableHeaderCell } from "./useColumnOrder";
import { useColumnWidths, type ColumnWidths } from "./useColumnWidths";

/** The browsing preferences that hold a list of numbers: widths or an order. */
type NumberListField = {
  [K in keyof BrowsingPreferences]: BrowsingPreferences[K] extends number[] ? K : never;
}[keyof BrowsingPreferences];

export interface ListColumns {
  /** The designed column drawn at each position. Stable while it is unchanged. */
  order: number[];
  /** The designed column being dragged to a new place, if one is. */
  moving: number | null;
  /** The handlers a header cell spreads onto itself to become movable. */
  cell: (column: number) => MovableHeaderCell;
  /** The widths, for the colgroup or the grid template, and the divider handlers. */
  widths: ColumnWidths;
  /** Designed widths and designed order again, in one settings write. */
  reset: () => void;
}

function saveBrowsing(patch: Partial<BrowsingPreferences>): void {
  const browsing = useAppStore.getState().state.settings.browsing;
  ipc.send({
    kind: "Settings",
    command: { type: "setBrowsing", payload: { preferences: { ...browsing, ...patch } } },
  });
}

/**
 * @param widthsField where the list's widths are stored
 * @param orderField where its order is stored
 * @param defaults the designed widths, in designed order
 * @param flexible the designed column that takes the space the others leave
 * @param headerRef the header row; see `useColumnOrder` for what it must hold
 * @param layout a CSS grid list, or a real table with a colgroup
 */
export function useListColumns({
  widthsField,
  orderField,
  defaults,
  flexible,
  headerRef,
  layout = "table",
  flexibleFloor = 80,
}: {
  widthsField: NumberListField;
  orderField: NumberListField;
  defaults: readonly number[];
  flexible: number;
  headerRef: RefObject<HTMLElement | null>;
  layout?: "grid" | "table";
  flexibleFloor?: number;
}): ListColumns {
  const stored = useAppStore((state) => state.state.settings.browsing[orderField]);
  const columnOrder = useColumnOrder(
    stored,
    defaults.length,
    (next) => saveBrowsing({ [orderField]: next }),
    headerRef,
  );
  // The hook hands out a fresh array every render. Kept by value, so a list
  // whose rows are memoised does not redraw every row for an order that did
  // not change.
  const orderKey = columnOrder.order.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const order = useMemo(() => columnOrder.order, [orderKey]);
  const widths = useColumnWidths(widthsField, defaults, flexible, layout, flexibleFloor, order);
  return {
    order,
    moving: columnOrder.moving,
    cell: columnOrder.cell,
    widths,
    reset: () => {
      widths.clear();
      columnOrder.clear();
      saveBrowsing({ [widthsField]: [], [orderField]: [] });
    },
  };
}
