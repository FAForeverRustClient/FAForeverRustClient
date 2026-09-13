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
import { tableMinWidth } from "../../shared/tableColumns";

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
  const columns = useColumnWidths("liveReplayColumns", DEFAULT_COLUMN_PX, FLEXIBLE_COLUMN);
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
  const divider = (boundary: number) => (
    <ResizeHandle
      className="live-replay-col-handle is-ruled"
      label={t("lobby.browser.resizeColumn", {
        column: columnLabels[boundary - 1 === FLEXIBLE_COLUMN ? boundary : boundary - 1],
      })}
      onDrag={(delta) => columns.onDrag(boundary, delta)}
      onEnd={columns.onCommit}
      onReset={columns.onReset}
    />
  );

  return (
    <div className="live-replay-table-wrap surface-panel">
      <table
        className="live-replay-table"
        style={{ minWidth: `${tableMinWidth(columns.widths)}px` }}
      >
        {/* `table-layout: fixed` plus a colgroup is how a real table takes
            dragged widths: putting them on the cells would let the widest row
            win instead. */}
        {/* Every column the width it was given except the game column, which
            has none and so takes what is left. An empty track at the end took
            it for one release, and the table then stopped a third of the way
            across a wide window while the titles beside it were cut off. */}
        <colgroup>
          {columns.widths.map((width, index) =>
            index === FLEXIBLE_COLUMN ? (
              <col key={columnLabels[index]} />
            ) : (
              <col key={columnLabels[index]} style={{ width: `${width}px` }} />
            ),
          )}
        </colgroup>
        <thead>
          <tr>
            <th className="live-map-column">{columnLabels[0]}</th>
            <SortHeader label={columnLabels[1]} sortKey="started" currentKey={props.sortKey} direction={props.sortDirection} onSort={props.onSort} handle={divider(1)} />
            <SortHeader label={columnLabels[2]} sortKey="title" currentKey={props.sortKey} direction={props.sortDirection} onSort={props.onSort} handle={divider(2)} />
            <SortHeader label={columnLabels[3]} sortKey="players" currentKey={props.sortKey} direction={props.sortDirection} onSort={props.onSort} className="live-number-column" handle={divider(3)} />
            <SortHeader label={columnLabels[4]} sortKey="rating" currentKey={props.sortKey} direction={props.sortDirection} onSort={props.onSort} className="live-number-column" handle={divider(4)} />
            <SortHeader label={columnLabels[5]} sortKey="host" currentKey={props.sortKey} direction={props.sortDirection} onSort={props.onSort} handle={divider(5)} />
            <SortHeader label={columnLabels[6]} sortKey="mods" currentKey={props.sortKey} direction={props.sortDirection} onSort={props.onSort} handle={divider(6)} />
            <th className="live-watch-column">{divider(7)}{columnLabels[7]}</th>
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
