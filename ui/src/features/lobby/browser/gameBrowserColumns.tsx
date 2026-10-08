// The game list's column widths and order, and the header that carries their
// dividers.
//
// Two lists draw this header: the custom-games browser and the co-op panel's
// open games. Only one of them had the widths and the dividers, and the other
// had a hand-written header of bare spans -- so the same five columns were
// laid out one way in one tab and another way in the next, and half of them
// could not be dragged at all. One hook, one header, both lists.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ResizeHandle } from "../../../design-system/ResizeHandle";
import type { CustomGameBrowserPreferences, CustomGameSort } from "../../../ipc/bindings";
import { ipc } from "../../../ipc/client";
import { useAppStore } from "../../../store/store";
import { sortsDescending } from "./gameSortOrder";
import { useTranslation } from "../../../i18n/useTranslation";
import { useColumnOrder } from "../../../shared/hooks/useColumnOrder";
import { fitColumns, gridColumnSpace, withBoundaryTraded } from "../../../shared/tableColumns";
import {
  COLUMN_FLOORS,
  columnTemplate,
  columnWidths,
  FLEXIBLE_COLUMN,
} from "./browserLayout";

/**
 * Persist part of the list's preferences.
 *
 * A nested patch, so only the fields named here are sent and the backend
 * merges them into the list's current preferences. An empty width or order list is the
 * reset: the backend keeps it, and the readers take it as "the designed
 * layout", so a reset survives a restart the same way a drag does.
 */
function saveBrowser(patch: Partial<CustomGameBrowserPreferences>): void {
  ipc.send({
    kind: "Settings",
    command: {
      type: "patchBrowsing",
      payload: {
        patch: {
          customGamesBrowser: patch,
        },
      },
    },
  });
}

/**
 * The sort each column stands for, in the designed order, or `null` for a
 * column the list cannot be ordered by.
 *
 * The tags column is the one without an order: a row's tags are several
 * things at once, and none of them ranks one game above another. The
 * toolbar's `host` order has no column of its own either: a host is part of
 * the game cell, so it stays a choice the select box makes.
 */
export const COLUMN_SORTS: readonly (CustomGameSort | null)[] = [
  "title",
  null,
  "map",
  "players",
  "rating",
  "age",
];

export interface GameBrowserColumns {
  /// For the list that holds the header and the rows: the template and each
  /// column's position, as custom properties every row reads. `undefined`
  /// outside list mode, where there are no columns to size.
  ///
  /// On the list rather than on every row, so a divider drag restyles one
  /// element instead of re-rendering a hundred rows per pixel moved.
  style: CSSProperties | undefined;
  /// The header row itself, dividers included.
  header: JSX.Element;
}

/**
 * The six columns every game list shows, sized, ordered and drawn once.
 *
 * @param enabled false in tile mode, where the widths mean nothing and
 *   applying them would fight the tile grid's own template.
 */
export function useGameBrowserColumns(enabled = true): GameBrowserColumns {
  const { t } = useTranslation();
  const browser = useAppStore((state) => state.state.settings.browsing.customGamesBrowser);
  const { sort, sortReversed: reversed } = browser;
  const savedWidths = useMemo(() => columnWidths(browser.columnWidths), [browser.columnWidths]);
  const headerRef = useRef<HTMLDivElement>(null);

  // Widths live in settings, but a drag has to be visible before it is saved:
  // writing every pointer move through the backend would be a round trip per
  // pixel. So a drag moves a local copy, releasing it saves the copy, and the
  // copy stays on screen until the saved value comes back. Dropping it at
  // release instead put the old layout back for the length of that round trip,
  // which is the flicker a released divider used to make.
  const [localWidths, setLocalWidths] = useState<number[] | null>(null);
  useEffect(() => setLocalWidths(null), [savedWidths]);
  const widths = localWidths ?? savedWidths;
  const columnOrder = useColumnOrder(
    browser.columnOrder,
    COLUMN_SORTS.length,
    (next) => saveBrowser({ columnOrder: next }),
    headerRef,
  );
  const { order, moving } = columnOrder;
  const gamePosition = order.indexOf(FLEXIBLE_COLUMN);

  const dragOrigin = useRef<number[] | null>(null);
  // The newest widths a drag produced, for the commit: a keyboard nudge drags
  // and commits in one event, before a re-render, so `localWidths` as this
  // render saw it did not have the nudge in it and it was never saved.
  const latestWidths = useRef<number[] | null>(null);
  const [resizing, setResizing] = useState(false);

  // The room the header has for its columns, the header being as wide as the
  // list, and what its padding and gaps take besides, for sizing a row that
  // overflows. Watched, because the window, the detail panel and the chat
  // sidebar all change it. See `fitColumns` for what is done with it.
  const [{ space, chrome }, setMeasured] = useState({ space: 0, chrome: 0 });
  useEffect(() => {
    const element = headerRef.current;
    if (!enabled || !element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const columns = gridColumnSpace(element, COLUMN_SORTS.length);
      setMeasured({ space: columns, chrome: element.clientWidth - columns });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled]);
  const fit = fitColumns(widths, COLUMN_FLOORS, space);
  const { scale } = fit;
  const template = columnTemplate(order.map((column) => fit.drawn[column]), gamePosition);
  // Only when every column is at its floor and the floors are wider than the
  // list: the header and every row are then as wide as the floors, so the
  // list scrolls sideways with each row whole, its hover and its border along
  // the full width of what is drawn.
  const minRowWidth = fit.overflow ? `${Math.ceil(chrome + fit.total)}px` : undefined;

  const style = useMemo(
    () => {
      if (!enabled) return undefined;
      const properties: CSSProperties & Record<string, string | number> = { "--game-browser-columns": template };
      if (minRowWidth) properties["--game-browser-min-width"] = minRowWidth;
      order.forEach((column, position) => {
        properties[`--game-browser-order-${column}`] = position;
      });
      return properties;
    },
    // Compared by value: the template is a string and the order a short list,
    // and a fresh object here restyles the whole list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, template, minRowWidth, order.join(",")],
  );

  // The game column's drawn width when a drag begins. On a list wider than
  // its columns the game column is drawn wider than its stored width, and a
  // drag starts from what is on screen, or the divider would jump.
  const drawnGame = useRef<number | null>(null);
  // The scale the drag started at. It holds for the whole drag, since a trade
  // keeps the total, and a re-render part way through must not change it.
  const dragScale = useRef(1);
  const onStart = () => {
    const cell = headerRef.current?.children[FLEXIBLE_COLUMN];
    drawnGame.current = scale >= 1 && cell ? Math.round(cell.getBoundingClientRect().width) : null;
    dragScale.current = scale;
    setResizing(true);
  };
  /** The divider in front of the column drawn at `position` moved by `delta`. */
  const onDrag = (position: number, delta: number) => {
    dragOrigin.current ??= drawnGame.current === null
      ? widths
      : widths.map((width, index) => (index === FLEXIBLE_COLUMN ? drawnGame.current ?? width : width));
    // The pointer moves in drawn pixels and the widths are stored unscaled:
    // at half scale a stored width changes twice as far, which is what keeps
    // the divider under the cursor. A trade keeps the total, so the scale
    // holds still for the whole drag. The trade is between the two columns
    // either side of the line as drawn, whatever order they are in, and stops
    // where the one giving way reaches its floor on screen.
    const origin = dragOrigin.current;
    const resized = withBoundaryTraded(
      order.map((column) => origin[column]),
      position,
      delta / dragScale.current,
      (at) => COLUMN_FLOORS[order[at]] / dragScale.current,
    );
    const next = [...origin];
    order.forEach((column, at) => {
      next[column] = resized[at];
    });
    latestWidths.current = next;
    setLocalWidths(next);
  };
  const onCommit = () => {
    const committed = latestWidths.current ?? localWidths;
    dragOrigin.current = null;
    drawnGame.current = null;
    latestWidths.current = null;
    setResizing(false);
    if (committed) saveBrowser({ columnWidths: committed });
  };
  /** A double click on any divider puts the whole header back as designed. */
  const onReset = () => {
    dragOrigin.current = null;
    latestWidths.current = null;
    setResizing(false);
    setLocalWidths(null);
    columnOrder.clear();
    saveBrowser({ columnWidths: [], columnOrder: [] });
  };

  /**
   * Order the list by a column, or turn the order it is already in around.
   *
   * A fresh column takes its own natural order rather than inheriting the
   * previous one's direction: "most players first" and "A to Z by map" are
   * both what somebody means by clicking that header, and they are opposite
   * directions. Clicking the column the list is already sorted by is the only
   * thing that reverses it, which is how every list in this client with a
   * sortable header already behaves.
   */
  const chooseSort = (column: CustomGameSort) => {
    saveBrowser({ sort: column, sortReversed: column === sort ? !reversed : false });
  };

  const labels = [
    t("lobby.browser.column.game"),
    t("lobby.browser.column.tags"),
    t("lobby.browser.column.map"),
    t("lobby.browser.column.players"),
    t("lobby.browser.column.rating"),
    t("lobby.browser.column.age"),
  ];
  // Each column's whole name, for the heading's tooltip, its accessible name
  // and its divider's. Some languages shorten a heading so that it fits its
  // column at the default window ("Edad" for "Antigüedad"); the column is
  // still the longer thing, and the tooltip is where that is said.
  const names = [
    labels[0],
    labels[1],
    labels[2],
    t("lobby.browser.columnFull.players"),
    t("lobby.browser.columnFull.rating"),
    t("lobby.browser.columnFull.age"),
  ];
  const moveHint = t("lobby.browser.moveColumn");

  const header = (
    <div
      className={`game-browser-head list-head${resizing ? " is-resizing" : ""}${moving !== null ? " is-moving" : ""}`}
      ref={headerRef}
    >
      {labels.map((label, index) => {
        const column = COLUMN_SORTS[index];
        const active = column === sort;
        const descending = column !== null && sortsDescending(column, reversed);
        const position = order.indexOf(index);
        // The column that grows as this divider is dragged right: the one
        // drawn before it, unless that is the game column, which has no
        // width of its own to name.
        const before = order[position - 1];
        return (
          // Pressed and dragged sideways, the cell moves its column; a press
          // that stays put is still the click that sorts. Alt and an arrow key
          // on the focused header do the same from the keyboard.
          <span
            key={label}
            className={moving === index ? "is-moving" : undefined}
            {...columnOrder.cell(index)}
          >
            {/* One line in front of every column but the first drawn, standing
                where that column starts. It trades width between the two
                columns it separates, so it lands under the cursor and no other
                line moves. */}
            {position > 0 && (
              <ResizeHandle
                className="game-browser-col-handle"
                label={t("lobby.browser.resizeColumn", {
                  column: names[before === FLEXIBLE_COLUMN ? index : before],
                })}
                onStart={onStart}
                onDrag={(delta) => onDrag(position, delta)}
                onEnd={onCommit}
                onReset={onReset}
              />
            )}
            {/* The header is the sort control, which is what every list
                somebody arrives from does. The label clips itself rather than
                letting the cell do it: the grab handle reaches past the cell's
                edge, and a cell with `overflow: hidden` cuts it off entirely. */}
            {column === null ? (
              // Nothing to order by: the label alone, in the button's place.
              <span className="game-browser-head-sort is-static" title={moveHint}>
                <span className="game-browser-head-label">{label}</span>
              </span>
            ) : (
              <button
                type="button"
                className={active ? "game-browser-head-sort is-active" : "game-browser-head-sort"}
                // `aria-sort` would be the right thing to say here and cannot be
                // said: it is only meaningful on a `columnheader`, and this list
                // is a CSS grid of plain elements rather than a table, so the
                // role would be a claim about a structure that is not there. The
                // label carries the order instead.
                title={`${t("lobby.browser.sortByColumn", { column: names[index] })}\n${moveHint}`}
                aria-label={`${t("lobby.browser.sortByColumn", { column: names[index] })}${
                  active
                    ? ` (${t(descending ? "lobby.browser.sortDescending" : "lobby.browser.sortAscending")})`
                    : ""
                }`}
                onClick={() => chooseSort(column)}
              >
                <span className="game-browser-head-label">{label}</span>
                <span className="game-browser-head-arrow" aria-hidden="true">
                  {active ? (descending ? "↓" : "↑") : "⇅"}
                </span>
              </button>
            )}
          </span>
        );
      })}
    </div>
  );

  return { style, header };
}
