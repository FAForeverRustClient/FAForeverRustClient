import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import type { Game, LiveReplayTracking } from "../../ipc/bindings";
import type { MapPresentation } from "../../shared/mapPresentation";
import { LiveReplayRow } from "./LiveReplayRow";
import { replayDelayRemaining, type LiveSortKey, type SortDirection } from "./liveReplayModel";

function SortHeader({
  label,
  sortKey,
  currentKey,
  direction,
  onSort,
  className,
}: {
  label: string;
  sortKey: LiveSortKey;
  currentKey: LiveSortKey;
  direction: SortDirection;
  onSort: (key: LiveSortKey) => void;
  className?: string;
}) {
  const active = currentKey === sortKey;
  return (
    <th className={className} aria-sort={active ? direction : "none"}>
      <button onClick={() => onSort(sortKey)}>
        {label}
        <span aria-hidden="true">{active ? (direction === "ascending" ? "↑" : "↓") : "↕"}</span>
      </button>
    </th>
  );
}

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
  onLoadMore: () => void;
}

export function LiveReplayTable(props: Props) {
  // One pair of clocks serves the whole table. Giving every row its own
  // interval scales timer work with the result count (75 rows per batch).
  // Mature rows receive a stable zero wait, so React.memo still skips them on
  // the one-second ticks needed by newly launched games.
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

  return (
    <div className="live-replay-table-wrap surface-panel">
      <table className="live-replay-table">
        <thead>
          <tr>
            <th className="live-map-column">Map</th>
            <SortHeader label="Started" sortKey="started" currentKey={props.sortKey} direction={props.sortDirection} onSort={props.onSort} />
            <SortHeader label="Game" sortKey="title" currentKey={props.sortKey} direction={props.sortDirection} onSort={props.onSort} />
            <SortHeader label="Players" sortKey="players" currentKey={props.sortKey} direction={props.sortDirection} onSort={props.onSort} className="live-number-column" />
            <SortHeader label="Rating" sortKey="rating" currentKey={props.sortKey} direction={props.sortDirection} onSort={props.onSort} className="live-number-column" />
            <SortHeader label="Host" sortKey="host" currentKey={props.sortKey} direction={props.sortDirection} onSort={props.onSort} />
            <SortHeader label="Mods" sortKey="mods" currentKey={props.sortKey} direction={props.sortDirection} onSort={props.onSort} />
            <th className="live-watch-column">Watch</th>
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
              presentation={presentation}
              player={props.player}
              tracking={props.tracking}
            />
          ))}
        </tbody>
      </table>
      <footer className="live-replay-footer">
        <span>Showing {props.games.length} of {props.matchingCount} matching live games ({props.totalCount} total)</span>
        <div className="live-replay-footer-actions">
          <span>{props.previewsLoading ? "Loading map previews…" : "Select a game title to inspect teams"}</span>
          {props.games.length < props.matchingCount && (
            <Button className="live-replay-load-more" onClick={props.onLoadMore}>
              Show {Math.min(props.batchSize, props.matchingCount - props.games.length)} more
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}
