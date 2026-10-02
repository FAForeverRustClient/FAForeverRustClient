// The order a list's columns are drawn in (#409).
//
// An order is the designed column at each drawn position: `[2, 0, 1]` draws the
// third column first. It is stored per list in `BrowsingPreferences.columnOrders`,
// and the widths stay by column, so a column keeps its width wherever it goes.
// Java's tables let a column be dragged to another place the same way (JavaFX
// `TableView`).

/** The lists whose columns can be moved, as their order is stored. */
export type ColumnList = "gameBrowser" | "replayList" | "liveReplays" | "matchmakerRecent";

/**
 * The stored order, made into an arrangement of exactly `count` columns.
 *
 * What is not a column of this list, or a column already placed, is dropped;
 * a column the stored order does not mention goes at the end. So an order kept
 * by a release with fewer columns keeps the user's arrangement and adds the
 * new column last, instead of throwing everything away.
 */
export function resolveColumnOrder(stored: readonly number[] | undefined, count: number): number[] {
  const order: number[] = [];
  const placed = new Set<number>();
  for (const column of stored ?? []) {
    if (Number.isInteger(column) && column >= 0 && column < count && !placed.has(column)) {
      order.push(column);
      placed.add(column);
    }
  }
  for (let column = 0; column < count; column += 1) {
    if (!placed.has(column)) order.push(column);
  }
  return order;
}

/** Whether `order` draws every column where it was designed to be. */
export function isDesignedOrder(order: readonly number[]): boolean {
  return order.every((column, position) => column === position);
}

/**
 * `moved` put where `target` is drawn now, the others keeping their order.
 * Dropping a column on another one takes that one's place, as in Java.
 */
export function withColumnMoved(order: readonly number[], moved: number, target: number): number[] {
  const from = order.indexOf(moved);
  const to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...order];
  const next = order.filter((column) => column !== moved);
  next.splice(to, 0, moved);
  return next;
}

/** `column` one place to the left (`-1`) or the right (`1`), for the keyboard. */
export function withColumnStepped(order: readonly number[], column: number, step: -1 | 1): number[] {
  const at = order.indexOf(column);
  const to = at + step;
  if (at < 0 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}

/** Per-column values in the order the columns are drawn. */
export function inDrawnOrder<T>(values: readonly T[], order: readonly number[]): T[] {
  return order.map((column) => values[column]);
}

/** The reverse: values in drawn order back to one per designed column. */
export function fromDrawnOrder<T>(drawn: readonly T[], order: readonly number[], fallback: readonly T[]): T[] {
  const values = [...fallback];
  order.forEach((column, position) => {
    values[column] = drawn[position];
  });
  return values;
}
