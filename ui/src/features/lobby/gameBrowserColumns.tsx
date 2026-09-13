// The game list's column widths, and the header that carries their dividers.
//
// Two lists draw this header: the custom-games browser and the co-op panel's
// open games. Only one of them had the widths and the dividers, and the other
// had a hand-written header of bare spans -- so the same five columns were
// laid out one way in one tab and another way in the next, and half of them
// could not be dragged at all. One hook, one header, both lists.

import { useMemo, useRef, useState, type CSSProperties } from "react";
import { ResizeHandle } from "../../design-system/ResizeHandle";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import {
  columnTemplate,
  columnWidths,
  FLEXIBLE_COLUMN,
  withColumnResized,
} from "./browserLayout";

/**
 * Persist the list's column widths.
 *
 * An empty array is the reset: the backend keeps it, and `columnWidths` reads
 * it back as "use the designed widths", so a reset survives a restart the same
 * way a drag does.
 */
function saveColumnWidths(widths: number[]): void {
  const current = useAppStore.getState().state.settings.browsing;
  ipc.send({
    kind: "Settings",
    command: {
      type: "setBrowsing",
      payload: {
        preferences: {
          ...current,
          customGamesBrowser: { ...current.customGamesBrowser, columnWidths: widths },
        },
      },
    },
  });
}

export interface GameBrowserColumns {
  /// The template, for the header and for every row under it. `undefined`
  /// outside list mode, where there are no columns to size.
  style: CSSProperties | undefined;
  /// The header row itself, dividers included.
  header: JSX.Element;
}

/**
 * The five columns every game list shows, sized once and drawn once.
 *
 * @param enabled false in tile mode, where the widths mean nothing and
 *   applying them would fight the tile grid's own template.
 */
export function useGameBrowserColumns(enabled = true): GameBrowserColumns {
  const { t } = useTranslation();
  // Column widths live in settings, but a drag has to be visible before it is
  // saved: writing every pointer move through the backend would be a round
  // trip per pixel. So the saved widths seed a local copy, the drag moves the
  // copy, and releasing the handle persists it.
  const savedWidths = useAppStore(
    (state) => state.state.settings.browsing.customGamesBrowser.columnWidths,
  );
  const [dragWidths, setDragWidths] = useState<number[] | null>(null);
  const widths = dragWidths ?? columnWidths(savedWidths);
  const dragOrigin = useRef<number[] | null>(null);
  const style = useMemo(
    () => (enabled ? { gridTemplateColumns: columnTemplate(widths) } : undefined),
    // The template is a string, so comparing the array by value is what keeps
    // every row from re-rendering on an unrelated settings write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, widths.join(",")],
  );

  const onDrag = (boundary: number, delta: number) => {
    dragOrigin.current ??= widths;
    setDragWidths(withColumnResized(dragOrigin.current, boundary, delta));
  };
  const onCommit = () => {
    dragOrigin.current = null;
    if (dragWidths) saveColumnWidths(dragWidths);
    setDragWidths(null);
  };
  const onReset = () => {
    dragOrigin.current = null;
    setDragWidths(null);
    saveColumnWidths([]);
  };

  const labels = [
    t("lobby.browser.column.game"),
    t("lobby.browser.column.map"),
    t("lobby.browser.column.players"),
    t("lobby.browser.column.rating"),
    t("lobby.browser.column.age"),
  ];

  const header = (
    <div className="game-browser-head" style={style}>
      {labels.map((label, index) => (
        <span key={label}>
          {/* One line in front of every column but the first, standing where
              that column starts. It trades width between the two columns it
              separates, so it lands under the cursor and no other line moves.
              The column it is named after is the one that grows as it is
              dragged to the right, which is the one before it unless that is
              the game column: the game column has no width of its own. */}
          {index > 0 && (
            <ResizeHandle
              className="game-browser-col-handle is-ruled"
              label={t("lobby.browser.resizeColumn", {
                column: labels[index - 1 === FLEXIBLE_COLUMN ? index : index - 1],
              })}
              onDrag={(delta) => onDrag(index, delta)}
              onEnd={onCommit}
              onReset={onReset}
            />
          )}
          {/* The label clips itself rather than letting the header cell do it:
              the grab handle reaches past the cell's edge, and a cell with
              `overflow: hidden` cuts it off entirely. */}
          <span className="game-browser-head-label">{label}</span>
        </span>
      ))}
    </div>
  );

  return { style, header };
}
