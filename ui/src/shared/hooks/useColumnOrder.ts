// Moving a list's columns: drag a header onto another one, or Alt+arrow keys
// on a header (#409). See `columnOrder` for what an order is.

import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import {
  resolveColumnOrder,
  withColumnMoved,
  withColumnStepped,
  type ColumnList,
} from "../columnOrder";

/** The drag's payload type, so a drop from anywhere else is not mistaken for a column. */
const COLUMN_MIME = "application/x-faf-column";

export interface ColumnOrder {
  /** The designed column at each drawn position. */
  order: number[];
  /** Spread on the element a column is picked up by: its header label or button. */
  grabProps: (column: number) => {
    draggable: true;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  };
  /** Spread on the header cell a column can be dropped on. */
  dropProps: (column: number) => {
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: () => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
  /** The column a drag is over right now, for its highlight. */
  dropTarget: number | null;
}

/** Persist one list's order. The designed order is stored as no entry at all. */
export function saveColumnOrder(list: ColumnList, order: readonly number[] | null): void {
  const browsing = useAppStore.getState().state.settings.browsing;
  const columnOrders = { ...browsing.columnOrders };
  if (order === null || order.every((column, position) => column === position)) {
    delete columnOrders[list];
  } else {
    columnOrders[list] = [...order];
  }
  ipc.send({
    kind: "Settings",
    command: { type: "setBrowsing", payload: { preferences: { ...browsing, columnOrders } } },
  });
}

export function useColumnOrder(list: ColumnList, count: number): ColumnOrder {
  const stored = useAppStore((state) => state.state.settings.browsing.columnOrders?.[list]);
  // Compared by value: a settings write replaces the whole object, and an
  // order that did not change must not re-render every row of the list.
  const key = (stored ?? []).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const order = useMemo(() => resolveColumnOrder(stored, count), [key, count]);
  const dragging = useRef<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);

  return {
    order,
    dropTarget,
    grabProps: (column) => ({
      draggable: true,
      onDragStart: (event) => {
        dragging.current = column;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(COLUMN_MIME, String(column));
      },
      onDragEnd: () => {
        dragging.current = null;
        setDropTarget(null);
      },
      onKeyDown: (event) => {
        if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
        event.preventDefault();
        saveColumnOrder(list, withColumnStepped(order, column, event.key === "ArrowLeft" ? -1 : 1));
      },
    }),
    dropProps: (column) => ({
      onDragOver: (event) => {
        if (dragging.current === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (dropTarget !== column) setDropTarget(column);
      },
      onDragLeave: () => {
        if (dropTarget === column) setDropTarget(null);
      },
      onDrop: (event) => {
        const moved = dragging.current;
        dragging.current = null;
        setDropTarget(null);
        if (moved === null) return;
        event.preventDefault();
        if (moved !== column) saveColumnOrder(list, withColumnMoved(order, moved, column));
      },
    }),
  };
}
