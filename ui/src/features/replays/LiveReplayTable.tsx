import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import type { Game, LiveReplayTracking } from "../../ipc/bindings";
import type { MapPresentation } from "../../shared/mapPresentation";
import type { PlayerMenuOpener } from "../chat/usePlayerMenu";
import { LiveReplayRow } from "./LiveReplayRow";
import { replayDelayRemaining, type LiveSortKey, type SortDirection } from "./liveReplayModel";
import { useTranslation } from "../../i18n/useTranslation";
import { ResizeHandle } from "../../design-system/ResizeHandle";
import { useColumnWidths } from "../../shared/useColumnWidths";

function SortHeader({
  label,
  sortKey,
  currentKey,
  direction,
  onSort,
  className,
  handle,
}: {
  label: string;
  sortKey: LiveSortKey;
  currentKey: LiveSortKey;
  direction: SortDirection;
  onSort: (key: LiveSortKey) => void;
  className?: string;
  handle?: JSX.Element;
}) {
  const active = currentKey === sortKey;
  return (
    <th className={className} aria-sort={active ? direction : "none"}>
      <button onClick={() => onSort(sortKey)}>
        {label}
        <span aria-hidden="true">{active ? (direction === "ascending" ? "↑" : "↓") : "↕"}</span>
      </button>
      {handle}
    </th>
  );
}

/**
 * The designed widths, in the order the columns are drawn.
 *
 * The last one is absent on purpose: the watch column takes what is left, so
 * there is nothing to its right for a handle to give width to.
 */
const DEFAULT_COLUMN_PX = [120, 110, 260, 84, 84, 150, 130];

/**
 * What the Watch column needs, and the table's designed floor.
 *
 * `table-layout: fixed` honours the colgroup's widths only while they fit: once
 * they add up to more than the table is allowed to be, the browser scales them
 * all back down, and a drag past that point does nothing. The table's minimum
 * therefore has to follow the widths rather than being a constant, so widening
 * a column widens the table and the wrapper scrolls -- which is what a table
 * whose columns can be dragged has to do.
 */
const WATCH_COLUMN_PX = 110;
const DESIGNED_TABLE_PX = 1040;

interface Props {
  busy: boolean;
  games: Array<{ game: Game; presentation: MapPresentation }>;
  matchingCount: number;
  totalCount: number;
  expandedId: number | null;
  sortKey: LiveSortKey;
  sortDirection: SortDirection;
  previewsLoading: boolean;
  batchSize: number;
  player: string;
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
  const columns = useColumnWidths("liveReplayColumns", DEFAULT_COLUMN_PX);
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
  ];
  /**
   * The divider on a column's leading edge, resizing the column before it.
   *
   * Where a file manager puts it: the cursor lands just in front of the column
   * you are about to push along, and the grab area straddles the boundary it
   * moves. So the first column carries none and every other cell -- the Watch
   * column included -- carries the one belonging to its left-hand neighbour.
   */
  const handle = (index: number) => (
    <ResizeHandle
      className="live-replay-col-handle is-ruled"
      label={t("lobby.browser.resizeColumn", { column: columnLabels[index] })}
      onDrag={(delta) => columns.onDrag(index, delta)}
      onEnd={columns.onCommit}
      onReset={columns.onReset}
    />
  );

  const tableMinWidth = Math.max(
    DESIGNED_TABLE_PX,
    columns.widths.reduce((total, width) => total + width, WATCH_COLUMN_PX),
  );

  return (
    <div className="live-replay-table-wrap surface-panel">
      <table className="live-replay-table" style={{ minWidth: `${tableMinWidth}px` }}>
        {/* `table-layout: fixed` plus a colgroup is how a real table takes
            dragged widths: putting them on the cells would let the widest row
            win instead. */}
        <colgroup>
          {columns.widths.map((width, index) => (
            <col key={columnLabels[index]} style={{ width: `${width}px` }} />
          ))}
          <col />
        </colgroup>
        <thead>
          <tr>
            <th className="live-map-column">{columnLabels[0]}</th>
            <SortHeader label={columnLabels[1]} sortKey="started" currentKey={props.sortKey} direction={props.sortDirection} onSort={props.onSort} handle={handle(0)} />
            <SortHeader label={columnLabels[2]} sortKey="title" currentKey={props.sortKey} direction={props.sortDirection} onSort={props.onSort} handle={handle(1)} />
            <SortHeader label={columnLabels[3]} sortKey="players" currentKey={props.sortKey} direction={props.sortDirection} onSort={props.onSort} className="live-number-column" handle={handle(2)} />
            <SortHeader label={columnLabels[4]} sortKey="rating" currentKey={props.sortKey} direction={props.sortDirection} onSort={props.onSort} className="live-number-column" handle={handle(3)} />
            <SortHeader label={columnLabels[5]} sortKey="host" currentKey={props.sortKey} direction={props.sortDirection} onSort={props.onSort} handle={handle(4)} />
            <SortHeader label={columnLabels[6]} sortKey="mods" currentKey={props.sortKey} direction={props.sortDirection} onSort={props.onSort} handle={handle(5)} />
            <th className="live-watch-column">{handle(6)}{t("replays.column.watch")}</th>
          </tr>
        </thead>
        <tbody>
          {props.games.map(({ game, presentation }) => (
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
              player={props.player}
              tracking={props.tracking}
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
