import { useEffect, useState } from "react";
import { Button } from "../../../design-system/Button";
import type { Game, LiveReplayTracking } from "../../../ipc/bindings";
import type { MapPresentation } from "../../../shared/mapPresentation";
import type { PlayerMenuOpener } from "../../../shared/hooks/usePlayerMenu";
import { LiveReplayRow } from "./LiveReplayRow";
import { replayDelayRemaining, type LiveSortKey, type SortDirection } from "../../../shared/liveReplayModel";
import { useTranslation } from "../../../i18n/useTranslation";
import { ResizeHandle } from "../../../design-system/ResizeHandle";
import { useColumnWidths } from "../../../shared/hooks/useColumnWidths";
import { useColumnOrder, type ColumnOrder } from "../../../shared/hooks/useColumnOrder";

function SortHeader({
  label,
  sortKey,
  currentKey,
  direction,
  onSort,
  className,
  handle,
  column,
  arrangement,
  moveHint,
}: {
  label: string;
  sortKey: LiveSortKey;
  currentKey: LiveSortKey;
  direction: SortDirection;
  onSort: (key: LiveSortKey) => void;
  className?: string;
  handle?: JSX.Element;
  column: number;
  arrangement: ColumnOrder;
  moveHint: string;
}) {
  const active = currentKey === sortKey;
  const target = arrangement.dropTarget === column ? "is-drop-target" : "";
  return (
    <th
      className={[className, target].filter(Boolean).join(" ") || undefined}
      aria-sort={active ? direction : "none"}
      {...arrangement.dropProps(column)}
    >
      {/* The sort button is also what the column is picked up by (#409). */}
      <button onClick={() => onSort(sortKey)} title={moveHint} {...arrangement.grabProps(column)}>
        {label}
        <span aria-hidden="true">{active ? (direction === "ascending" ? "↑" : "↓") : "↕"}</span>
      </button>
      {handle}
    </th>
  );
}

/** The sort each column stands for, in designed order; `null` for one with no order. */
const COLUMN_SORTS: readonly (LiveSortKey | null)[] = [
  null,
  "started",
  "title",
  "players",
  "rating",
  "host",
  "mods",
  null,
];

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

interface Props {
  busy: boolean;
  games: Array<{ game: Game; presentation: MapPresentation; mapSize: string | null }>;
  matchingCount: number;
  totalCount: number;
  expandedId: number | null;
  sortKey: LiveSortKey;
  sortDirection: SortDirection;
  previewsLoading: boolean;
  batchSize: number;
  tracking: LiveReplayTracking | null;
  onSort: (key: LiveSortKey) => void;
  onToggle: (id: number) => void;
  onPlayerMenu: PlayerMenuOpener;
  onLoadMore: () => void;
}

export function LiveReplayTable(props: Props) {
  const { t } = useTranslation();
  // One pair of clocks serves the whole table. Giving every row its own
  // interval scales timer work with the result count (75 rows per batch).
  // Mature rows receive a stable zero wait, so React.memo still skips them on
  // the one-second ticks needed by newly launched games.
  const arrangement = useColumnOrder("liveReplays", DEFAULT_COLUMN_PX.length);
  const { order } = arrangement;
  const columns = useColumnWidths("liveReplayColumns", DEFAULT_COLUMN_PX, FLEXIBLE_COLUMN, "table", 80, {
    list: "liveReplays",
    order,
  });
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
  /**
   * The divider in front of a column, standing where that column starts.
   *
   * It trades width between the two columns it separates, so it lands under
   * the cursor and no other divider moves. The first column has nothing in
   * front of it; every other cell, the Watch column included, carries one.
   */
  const divider = (boundary: number) => {
    const before = order[boundary - 1];
    return (
      <ResizeHandle
        className="live-replay-col-handle is-ruled"
        label={t("lobby.browser.resizeColumn", {
          column: columnLabels[before === FLEXIBLE_COLUMN ? order[boundary] : before],
        })}
        onStart={columns.onStart}
        onDrag={(delta) => columns.onDrag(boundary, delta)}
        onEnd={columns.onCommit}
        onReset={columns.onReset}
      />
    );
  };
  const moveHint = t("common.moveColumnHint");
  const sortKeyed = (column: number, position: number) => {
    const sortKey = COLUMN_SORTS[column];
    const handle = position > 0 ? divider(position) : undefined;
    const className = column === 3 || column === 4 ? "live-number-column" : undefined;
    if (sortKey === null) {
      const target = arrangement.dropTarget === column ? " is-drop-target" : "";
      return (
        <th
          key={column}
          className={`${column === 0 ? "live-map-column" : "live-watch-column"}${target}`}
          {...arrangement.dropProps(column)}
        >
          {handle}
          <span className="live-replay-head-label" tabIndex={0} title={moveHint} {...arrangement.grabProps(column)}>
            {columnLabels[column]}
          </span>
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
        className={className}
        handle={handle}
        column={column}
        arrangement={arrangement}
        moveHint={moveHint}
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
          {columns.drawn.map((width, position) =>
            position === columns.flexible ? (
              <col key={columnLabels[order[position]]} />
            ) : (
              <col key={columnLabels[order[position]]} style={{ width: `${width}px` }} />
            ),
          )}
        </colgroup>
        <thead>
          <tr>
            {order.map((column, position) => sortKeyed(column, position))}
          </tr>
        </thead>
        <tbody>
          {props.games.map(({ game, presentation, mapSize }) => (
            <LiveReplayRow
              key={game.id}
              busy={props.busy}
              expanded={props.expandedId === game.id}
              game={game}
              ageNow={ageNow}
              waitSeconds={replayDelayRemaining(game, waitNow)}
              onToggle={props.onToggle}
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
