// Columns that can be moved by dragging their header.
//
// The game list grew this first and the replay list wanted the same, so the
// pointer handling lives here once. Each table brings where its order is
// stored and how to save it; the drag, the threshold that keeps a click a
// click, and the keyboard alternative are the same for all of them.

import { useEffect, useRef, useState, type RefObject } from "react";

/** How far the pointer travels on a header before a press becomes a move. */
const MOVE_THRESHOLD_PX = 6;

/** The designed order: each column where the table has always drawn it. */
export function designedOrder(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

/** The stored order when it describes this table, the designed one otherwise. */
export function resolveColumnOrder(stored: readonly number[] | undefined, count: number): number[] {
  return stored && stored.length === count ? [...stored] : designedOrder(count);
}

/** The order after the column drawn at `from` is dropped at `to`. */
export function withColumnMoved(order: readonly number[], from: number, to: number): number[] {
  const next = [...order];
  if (from < 0 || from >= next.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved);
  return next;
}

/** The handlers a header cell spreads onto itself to become movable. */
export interface MovableHeaderCell {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  onClickCapture: (event: React.MouseEvent) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}

export interface ColumnOrder {
  /** The column drawn at each position, as indexes into the designed order. */
  order: number[];
  /** The column being dragged, if one is. */
  moving: number | null;
  /** The handlers for the header cell of `column` (a designed index). */
  cell: (column: number) => MovableHeaderCell;
  /** Drop any local order, for a reset that saves the designed one itself. */
  clear: () => void;
}

/**
 * The header row's cells, by designed index.
 *
 * A cell that says which column it is (`data-column`) is found by that, which
 * is what a real table needs: its cells are drawn in the stored order, because
 * a table cell cannot be moved with CSS `order`. Without the attribute the
 * children are taken as they stand, in designed order, which is how the grid
 * lists keep their cells.
 */
function designedCells(header: HTMLElement | null, count: number): Element[] {
  if (!header) return [];
  const tagged = Array.from(header.children).filter((child) => child instanceof HTMLElement && child.dataset.column !== undefined);
  if (tagged.length === count) {
    const cells: Element[] = [];
    for (const cell of tagged) cells[Number((cell as HTMLElement).dataset.column)] = cell;
    return cells;
  }
  return Array.from(header.children).slice(0, count);
}

/**
 * @param stored the saved order, or empty for the designed one
 * @param count how many columns the table has
 * @param save persists an order; called once per finished move
 * @param headerRef the header row. Its cells are what a drag is measured
 *   against: each one marked with `data-column` (its designed index), or all
 *   of them in designed order. See `designedCells`.
 */
export function useColumnOrder(
  stored: readonly number[] | undefined,
  count: number,
  save: (order: number[]) => void,
  headerRef: RefObject<HTMLElement | null>,
): ColumnOrder {
  const storedKey = (stored ?? []).join(",");
  // Local while a column is held and until the saved order comes back. Dropped
  // at release instead, the old order showed for the length of the round trip
  // and the column visibly jumped back before landing.
  const [local, setLocal] = useState<number[] | null>(null);
  useEffect(() => setLocal(null), [storedKey]);
  const order = local ?? resolveColumnOrder(stored, count);
  const orderRef = useRef(order);
  orderRef.current = order;

  const press = useRef<{ column: number; startX: number; moving: boolean } | null>(null);
  const swallowClick = useRef(false);
  const [moving, setMoving] = useState<number | null>(null);

  const cell = (column: number): MovableHeaderCell => ({
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      // A divider inside the cell is its own drag.
      if ((event.target as HTMLElement).closest(".resize-handle")) return;
      press.current = { column, startX: event.clientX, moving: false };
    },
    onPointerMove: (event) => {
      const state = press.current;
      if (!state) return;
      if (!state.moving) {
        if (Math.abs(event.clientX - state.startX) < MOVE_THRESHOLD_PX) return;
        state.moving = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        setMoving(state.column);
      }
      // The position is how many of the other columns have their middle to
      // the left of the pointer. Measured against the others only, so a column
      // that has just changed places does not count itself and swap back.
      const cells = designedCells(headerRef.current, count);
      let position = 0;
      cells.forEach((other, index) => {
        if (index === state.column) return;
        const rect = other.getBoundingClientRect();
        if (rect.left + rect.width / 2 < event.clientX) position += 1;
      });
      const current = orderRef.current;
      const from = current.indexOf(state.column);
      if (from !== position) setLocal(withColumnMoved(current, from, position));
    },
    onPointerUp: (event) => finish(event),
    onPointerCancel: (event) => finish(event),
    onClickCapture: (event) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    // Alt and an arrow key move the focused column, for anyone not dragging.
    onKeyDown: (event) => {
      if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      event.preventDefault();
      const current = orderRef.current;
      const from = current.indexOf(column);
      const next = withColumnMoved(current, from, from + (event.key === "ArrowLeft" ? -1 : 1));
      setLocal(next);
      save(next);
    },
  });

  const finish = (event: React.PointerEvent<HTMLElement>) => {
    const state = press.current;
    press.current = null;
    if (!state?.moving) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setMoving(null);
    // The click that ends a move is not a sort. Cleared on the next turn as
    // well, in case no click follows the release.
    swallowClick.current = true;
    window.setTimeout(() => {
      swallowClick.current = false;
    }, 0);
    save(orderRef.current);
  };

  return { order, moving, cell, clear: () => setLocal(null) };
}
