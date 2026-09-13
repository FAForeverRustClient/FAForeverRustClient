// Draggable column widths, stored per table.
//
// The replay list grew this first and the live-replay and co-op tables wanted
// the same thing, which is the moment to have one of it rather than three.
// Every table brings its own designed widths, its own settings field and its
// own flexible column; the clamping, the "local while dragging, saved on
// release" split, and the reset are the same for all of them. What a drag
// actually does to the widths lives in `tableColumns`, which the game
// browser's grid shares.

import { useRef, useState } from "react";
import type { BrowsingPreferences } from "../ipc/bindings";
import { ipc } from "../ipc/client";
import { useAppStore } from "../store/store";
import { resolveColumnWidths, withBoundaryDragged } from "./tableColumns";

/** The settings fields that hold a table's column widths. */
type ColumnField = {
  [K in keyof BrowsingPreferences]: BrowsingPreferences[K] extends number[] ? K : never;
}[keyof BrowsingPreferences];

export interface ColumnWidths {
  /** What to draw with now: the drag in progress, or what was saved. */
  widths: number[];
  /**
   * Where the divider in front of `boundary` has been dragged to: pixels from
   * where the drag began, not since the last pointer move. The column before
   * the line grows by what the column after it gives up, so the line moves and
   * nothing else does.
   */
  onDrag: (boundary: number, delta: number) => void;
  /** The drag ended: persist it. */
  onCommit: () => void;
  /** Back to the designed widths, and stay there across a restart. */
  onReset: () => void;
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
): ColumnWidths {
  const stored = useAppStore((state) => state.state.settings.browsing[field]);
  // Local until the pointer is released: persisting per frame would write a
  // settings file on every mouse move.
  const [dragged, setDragged] = useState<number[] | null>(null);
  // The widths the drag started from. `ResizeHandle` reports the distance from
  // where the pointer went down, so every move has to be measured against the
  // same widths; adding each report to the last one instead makes a column run
  // away from the cursor, faster the further it is dragged.
  const origin = useRef<number[] | null>(null);

  const resolve = () => resolveColumnWidths(stored, defaults);

  const save = (widths: number[]) => {
    const current = useAppStore.getState().state.settings.browsing;
    ipc.send({
      kind: "Settings",
      command: { type: "setBrowsing", payload: { preferences: { ...current, [field]: widths } } },
    });
  };

  return {
    widths: dragged ?? resolve(),
    onDrag: (boundary, delta) => {
      const base = (origin.current ??= dragged ?? resolve());
      setDragged(withBoundaryDragged(base, boundary, delta, flexible));
    },
    onCommit: () => {
      origin.current = null;
      if (dragged) save(dragged);
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
