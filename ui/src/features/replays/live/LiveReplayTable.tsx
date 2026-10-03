import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../../../design-system/Button";
import type { Game, LiveReplayTracking } from "../../../ipc/bindings";
import type { MapPresentation } from "../../../shared/mapPresentation";
import type { PlayerMenuOpener } from "../../../shared/hooks/usePlayerMenu";
import { LiveReplayRow } from "./LiveReplayRow";
import { replayDelayRemaining, type LiveSortKey, type SortDirection } from "../../../shared/liveReplayModel";
import { useTranslation } from "../../../i18n/useTranslation";
import { ResizeHandle } from "../../../design-system/ResizeHandle";
import { useListColumns } from "../../../shared/hooks/useListColumns";
import type { MovableHeaderCell } from "../../../shared/hooks/useColumnOrder";

/** What makes a header cell movable, and says which column it is. */
type HeaderCellProps = MovableHeaderCell & { "data-column": number; title: string; className?: string };

function SortHeader({
  label,
  sortKey,
  currentKey,
  direction,
  onSort,
  cellProps,
  handle,
}: {
  label: string;
  sortKey: LiveSortKey;
  currentKey: LiveSortKey;
  direction: SortDirection;
  onSort: (key: LiveSortKey) => void;
  cellProps: HeaderCellProps;
  handle?: ReactNode;
}) {
  const active = currentKey === sortKey;
  return (
    <th {...cellProps} aria-sort={active ? direction : "none"}>
      <button onClick={() => onSort(sortKey)}>
        {label}
        <span aria-hidden="true">{active ? (direction === "ascending" ? "↑" : "↓") : "↕"}</span>
      </button>
      {handle}
    </th>
  );
}

/**
 * The designed widths, in the order the columns are drawn, the Watch column
 * included: every column has a width here, because a divider takes from the
 * column on one side of it and gives to the column on the other, and a column
 * with no width of its own has nothing to give.
 */
const DEFAULT_COLUMN_PX = [120, 110, 260, 84, 84, 150, 130, 128];

/**
 * The game column, which is the flexible one.
 *
 * A lobby title is what gets cut off, so it is what a wide window is spent on.
 * The number above is its floor rather than its width: on screen the column is
 * whatever the table has left after the other seven.
 */
const FLEXIBLE_COLUMN = 2;

/** What each designed column sorts by, where it sorts at all. */
const COLUMN_SORTS: (LiveSortKey | null)[] = [null, "started", "title", "players", "rating", "host", "mods", null];

/** Extra classes per designed column, for its alignment. */
const COLUMN_CLASSES = ["live-map-column", "", "", "live-number-column", "live-number-column", "", "", "live-watch-column"];

interface Props {
  busy: boolean;
  games: Array<{ game: Game; presentation: MapPresentation; mapSize: string | null }>;
  matchingCount: number;
  totalCount: number;
  sortKey: LiveSortKey;
  sortDirection: SortDirection;
  previewsLoading: boolean;
  batchSize: number;
  tracking: LiveReplayTracking | null;
  onSort: (key: LiveSortKey) => void;
  onOpen: (id: number) => void;
  onPlayerMenu: PlayerMenuOpener;
  onLoadMore: () => void;
}

export function LiveReplayTable(props: Props) {
  const { t } = useTranslation();
  // One pair of clocks serves the whole table. Giving every row its own
  // interval scales timer work with the result count (75 rows per batch).
  // Mature rows receive a stable zero wait, so React.memo still skips them on
  // the one-second ticks needed by newly launched games.
  const headerRef = useRef<HTMLTableRowElement | null>(null);
  // Widths, order and reset as every list view has them: see `useListColumns`.
  const list = useListColumns({
    widthsField: "liveReplayColumns",
    orderField: "liveReplayOrder",
    defaults: DEFAULT_COLUMN_PX,
    flexible: FLEXIBLE_COLUMN,
    headerRef,
  });
  const { order, moving, widths: columns } = list;
  const [ageNow, setAgeNow] = useState(() => Date.now());
  const [waitNow, setWaitNow] = useState(() => Date.now());
  const hasDelayedReplay = props.games.some(({ game }) => replayDelayRemaining(game, waitNow) > 0);

  useEffect(() => {
    const timer = window.setInterval(() => setAgeNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!hasDelayedReplay) return;
    const timer = window.setInterval(() => setWaitNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasDelayedReplay]);

  const columnLabels = [
    t("replays.live.column.map"),
    t("replays.column.started"),
    t("replays.column.game"),
    t("replays.column.players"),
    t("replays.column.rating"),
    t("replays.column.host"),
    t("replays.column.mods"),
    t("replays.column.watch"),
  ];
  const moveHint = t("lobby.browser.moveColumn");
  /**
   * The divider in front of the column drawn at `position`, standing where
   * that column starts.
   *
   * It trades width between the two columns either side of it on screen, so
   * it lands under the cursor and no other divider moves. The first column
   * drawn has nothing in front of it. It names the column that grows as it is
   * dragged right: the one drawn before it, unless that is the game column,
   * which has no width of its own to name.
   */
  const divider = (position: number) => {
    const column = order[position];
    const before = order[position - 1];
    return (
      <ResizeHandle
        className="live-replay-col-handle is-ruled"
        label={t("lobby.browser.resizeColumn", {
          column: columnLabels[before === FLEXIBLE_COLUMN ? column : before],
        })}
        onStart={columns.onStart}
        onDrag={(delta) => columns.onDrag(position, delta)}
        onEnd={columns.onCommit}
        onReset={list.reset}
      />
    );
  };
  /** One header cell, for the designed column `column` drawn at `position`. */
  const headerCell = (column: number, position: number) => {
    const sortKey = COLUMN_SORTS[column];
    const handle = position > 0 ? divider(position) : null;
    const cellProps: HeaderCellProps = {
      ...list.cell(column),
      "data-column": column,
      title: moveHint,
      className: `${COLUMN_CLASSES[column]}${moving === column ? " is-moving" : ""}`.trim() || undefined,
    };
    if (sortKey === null) {
      // Nothing to sort by: still a keyboard stop, so Alt and an arrow key
      // can move it.
      return (
        <th key={column} {...cellProps} tabIndex={0}>
          {handle}
          {columnLabels[column]}
        </th>
      );
    }
    return (
      <SortHeader
        key={column}
        label={columnLabels[column]}
        sortKey={sortKey}
        currentKey={props.sortKey}
        direction={props.sortDirection}
        onSort={props.onSort}
        cellProps={cellProps}
        handle={handle}
      />
    );
  };

  return (
    <div className="live-replay-table-wrap surface-panel">
      <table className="live-replay-table" ref={columns.containerRef}>
        {/* `table-layout: fixed` plus a colgroup is how a real table takes
            dragged widths: putting them on the cells would let the widest row
            win instead. */}
        {/* Every column the width it was given except the game column, which
            has none and so takes what is left. An empty track at the end took
            it for one release, and the table then stopped a third of the way
            across a wide window while the titles beside it were cut off. */}
        <colgroup>
          {order.map((column) =>
            column === FLEXIBLE_COLUMN ? (
              <col key={column} />
            ) : (
              <col key={column} style={{ width: `${columns.drawn[column]}px` }} />
            ),
          )}
        </colgroup>
        <thead>
          {/* The cells in the stored order: a table cell cannot be moved with
              CSS `order` the way the grid lists move theirs. Each says which
              column it is, which is how a drag finds them. */}
          <tr className={`list-head${moving !== null ? " is-moving" : ""}`} ref={headerRef}>
            {order.map((column, position) => headerCell(column, position))}
          </tr>
        </thead>
        <tbody>
          {props.games.map(({ game, presentation, mapSize }) => (
            <LiveReplayRow
              key={game.id}
              busy={props.busy}
              game={game}
              ageNow={ageNow}
              waitSeconds={replayDelayRemaining(game, waitNow)}
              onOpen={props.onOpen}
              onPlayerMenu={props.onPlayerMenu}
              presentation={presentation}
              mapSize={mapSize}
              tracking={props.tracking}
              order={order}
            />
          ))}
        </tbody>
      </table>
      <footer className="live-replay-footer">
        <span>
          {t("replays.live.showing", {
            shown: props.games.length,
            matching: props.matchingCount,
            total: props.totalCount,
          })}
        </span>
        <div className="live-replay-footer-actions">
          <span>{t(props.previewsLoading ? "replays.live.loadingPreviews" : "replays.live.selectGame")}</span>
          {props.games.length < props.matchingCount && (
            <Button className="live-replay-load-more" onClick={props.onLoadMore}>
              {t("replays.live.showMore", {
                count: Math.min(props.batchSize, props.matchingCount - props.games.length),
              })}
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}
