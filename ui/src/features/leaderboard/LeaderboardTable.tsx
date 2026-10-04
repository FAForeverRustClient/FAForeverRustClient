import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import type { LeaderboardEntry, PlayerRatings } from "../../ipc/bindings";
import { t as translate, type MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerName } from "../../shared/components/nameColors";
import { hourCycleOptions } from "../../shared/format/clock";
import { clientIntlTag } from "../../shared/format/dates";
import { tierLabel } from "../../shared/leagueNames";
import { leaderboardLabel } from "../../shared/playerRatings";

export type LeaderboardColumn =
  | "rank"
  | "player"
  | "league"
  | "division"
  | "score"
  | "rating"
  | "mean"
  | "deviation"
  | "games"
  | "updated";

/**
 * A board's own column, keyed by its technical name.
 *
 * The rating table showed one board at a time and switched between them with a
 * row of tabs. Taking out the win rate and the win count, both of which the
 * API answers wrongly, left a rank, a name and one number; the thread's answer
 * was to stop switching and "display Global, 1v1, 2v2, 3v3, 4v4 in one view".
 * The tabs are gone with the switching: every board is a column, and the
 * column header is what chooses which of them the ladder is ranked by.
 */
export type BoardColumn = `board:${string}`;

export type TableColumn = LeaderboardColumn | BoardColumn;

function isBoardColumn(column: TableColumn): column is BoardColumn {
  return column.startsWith("board:");
}

function boardOf(column: BoardColumn): string {
  return column.slice("board:".length);
}

const LABELS: Record<LeaderboardColumn, MessageKey> = {
  rank: "leaderboard.column.rank",
  player: "leaderboard.column.player",
  league: "leaderboard.column.league",
  division: "leaderboard.column.division",
  score: "leaderboard.column.score",
  rating: "leaderboard.column.rating",
  mean: "leaderboard.column.mean",
  deviation: "leaderboard.column.deviation",
  games: "leaderboard.column.games",
  updated: "leaderboard.column.updated",
};

/**
 * Every board this page knows a rating for, by player.
 *
 * The ranked board's number is on the entry itself, because that is what the
 * page was sorted and ranked by; every other board arrives in a second request
 * and lands here. A player with no row on a board is not in the map, which is
 * the difference between "unrated there" and "not loaded yet": the caller
 * knows which of those it is, and this does not.
 */
export type CrossRatings = ReadonlyMap<number, ReadonlyMap<string, number>>;

export function crossRatingIndex(ratings: PlayerRatings[]): CrossRatings {
  return new Map(ratings.map((player) => [
    player.playerId,
    new Map(player.ratings.map((board) => [board.leaderboard, board.rating])),
  ]));
}

function value(entry: LeaderboardEntry, column: LeaderboardColumn): number | string | null {
  switch (column) {
    case "rank": return entry.rank;
    case "player": return entry.playerName;
    // A tier sorts by its place in the season, Bronze below Silver, which is
    // also what keeps the order the same in every language.
    case "league": return entry.divisionOrder;
    case "division": return entry.divisionOrder;
    case "score": return entry.score;
    case "rating": return entry.rating;
    case "mean": return entry.mean;
    case "deviation": return entry.deviation;
    case "games": return entry.gamesPlayed;
    case "updated": return entry.updateTime;
  }
}

function cellValue(
  entry: LeaderboardEntry,
  column: TableColumn,
  activeBoard: string,
  cross: CrossRatings,
): number | string | null {
  if (!isBoardColumn(column)) return value(entry, column);
  const board = boardOf(column);
  // The ranked board's rating is the entry's own: the page was sorted by it,
  // so it is there whether or not the second request has landed.
  if (board === activeBoard) return entry.rating;
  return cross.get(entry.playerId)?.get(board) ?? null;
}

function format(
  entry: LeaderboardEntry,
  column: TableColumn,
  activeBoard: string,
  cross: CrossRatings,
): string {
  const raw = cellValue(entry, column, activeBoard, cross);
  if (column === "player") return entry.playerName || translate("common.unknown");
  if (raw === null || raw === "") return translate("common.notAvailable");
  if (column === "division" || column === "league") return tierLabel(entry.division, entry.subdivision);
  if (column === "mean" || column === "deviation") return Number(raw).toFixed(1);
  if (column === "updated") {
    const date = new Date(String(raw));
    return Number.isNaN(date.valueOf()) ? String(raw) : date.toLocaleString(clientIntlTag(), hourCycleOptions());
  }
  return String(raw);
}

function playerCell(entry: LeaderboardEntry) {
  return (
    <span className="leaderboard-player-cell">
      {entry.avatarUrl ? (
        <img
          className="leaderboard-avatar"
          src={entry.avatarUrl}
          alt=""
          title={entry.avatarTooltip || undefined}
          width={40}
          height={20}
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ) : (
        <span className="leaderboard-avatar-slot" aria-hidden="true" />
      )}
      <PlayerName name={entry.playerName || translate("common.unknown")} />
    </span>
  );
}

function leagueCell(entry: LeaderboardEntry) {
  const imageUrl = entry.divisionMediumImageUrl || entry.divisionImageUrl;
  return imageUrl ? (
    <img
      className="leaderboard-division-icon"
      src={imageUrl}
      alt=""
      title={entry.division === null ? undefined : tierLabel(entry.division, entry.subdivision)}
      width={48}
      height={24}
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  ) : (
    <span className="leaderboard-division-icon-slot" aria-hidden="true" />
  );
}

/** Whether a cell has nothing in it, which is what the table prints as `N/A`. */
function isMissing(value: number | string | null): boolean {
  return value === null || value === "";
}

/**
 * Order two cells that both have a value.
 *
 * Ascending. The direction is applied by the caller, and only here: a missing
 * cell is not a small value to be flipped to the top when the column is read
 * the other way round, it is the absence of one.
 */
function compareValues(left: number | string, right: number | string): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Order two rows by one column, with the empty cells at the bottom.
 *
 * A player with no rating on a board is not the worst player on it, and
 * sorting them as if they were is what put a screenful of `N/A` at the top of
 * a column somebody had just asked for the highest value in. They go last
 * either way the column is sorted, and the rows that do have a value are
 * ordered between themselves.
 */
function compare(
  a: LeaderboardEntry,
  b: LeaderboardEntry,
  column: TableColumn,
  activeBoard: string,
  cross: CrossRatings,
  descending: boolean,
): number {
  const left = cellValue(a, column, activeBoard, cross);
  const right = cellValue(b, column, activeBoard, cross);
  if (isMissing(left) || isMissing(right)) {
    if (isMissing(left) && isMissing(right)) return 0;
    return isMissing(left) ? 1 : -1;
  }
  const result = compareValues(left as number | string, right as number | string);
  return descending ? -result : result;
}

/**
 * The rows in the order the table draws them.
 *
 * Exported for its own test: the sort is the part of this table with a rule
 * in it, and a rendered table is the one place a store-backed component
 * cannot be asked what it did.
 */
export function sortLeaderboard(
  entries: readonly LeaderboardEntry[],
  column: TableColumn,
  descending: boolean,
  activeBoard: string,
  cross: CrossRatings,
): LeaderboardEntry[] {
  return [...entries].sort((a, b) => compare(a, b, column, activeBoard, cross, descending));
}

interface LeaderboardTableProps {
  entries: LeaderboardEntry[];
  columns: TableColumn[];
  selectedPlayerId: number | null;
  onSelect: (entry: LeaderboardEntry) => void;
  emptyMessage?: string;
  /** Which board the page is ranked by. Its column is the emphasised one. */
  activeBoard?: string;
  /** What the other boards say, once the second request has answered. */
  crossRatings?: CrossRatings;
  /**
   * Rank the whole ladder by this board.
   *
   * Pressing a board's header is how the ranked board is chosen now. The panel
   * above turns it into a fresh query, because the ranking is the server's:
   * the page on screen is the top hundred of one board, and re-sorting it
   * locally would answer a different question than the header asks.
   */
  onRankBy?: (board: string) => void;
  /**
   * Draw the first this many rows of the sorted list, with a button under
   * them for the next batch. For a list that is loaded whole, like a league
   * season of several thousand players: every row is still sorted and
   * searched, only the drawing is held back. Unset draws everything.
   */
  rowBatch?: number;
  /**
   * Back to the top of the table whenever this changes, before any rows
   * arrive. For a list loaded a page at a time: the query changes the moment
   * a page is asked for, the rows only once the server has answered, and the
   * old page sat scrolled to its bottom for that whole round trip.
   */
  scrollResetKey?: unknown;
}

const NO_CROSS_RATINGS: CrossRatings = new Map();

export function LeaderboardTable({
  entries,
  columns,
  selectedPlayerId,
  onSelect,
  emptyMessage,
  activeBoard = "",
  crossRatings = NO_CROSS_RATINGS,
  onRankBy,
  rowBatch,
  scrollResetKey,
}: LeaderboardTableProps) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<{ column: TableColumn; descending: boolean }>({
    column: "rank",
    descending: false,
  });
  const [shown, setShown] = useState(rowBatch ?? Infinity);
  // A new list, a new filter or a new order starts from the top batch again.
  useEffect(() => setShown(rowBatch ?? Infinity), [entries, rowBatch, sort]);
  // ...and from the top of the table (#427). The pager's own scroll reset
  // cannot reach this: it resets the nearest scrolling *ancestor* of the
  // pager, and the rows scroll in their own box beside it, so page two opened
  // wherever page one had been left. A layout effect, so the new rows are
  // never painted at the old offset first; `scrollResetKey` makes it happen
  // at the click rather than a round trip later.
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [entries, sort, scrollResetKey]);
  const sorted = useMemo(
    () => sortLeaderboard(entries, sort.column, sort.descending, activeBoard, crossRatings),
    [activeBoard, crossRatings, entries, sort],
  );

  // A number column opens on its highest value, which is what somebody
  // pressing "2v2" is asking to see. Only the rank and the name read the other
  // way round, because first and A are their top.
  const chooseSort = (column: TableColumn) => {
    setSort((current) => current.column === column
      ? { column, descending: !current.descending }
      : { column, descending: column !== "rank" && column !== "player" });
    // A board column ranks the whole ladder by that board rather than just the
    // page on screen: the tabs that used to do it are gone, and sorting a
    // hundred loaded rows by 1v1 is not the same question as "who is the best
    // at 1v1".
    if (isBoardColumn(column) && boardOf(column) !== activeBoard) onRankBy?.(boardOf(column));
  };

  if (sorted.length === 0) return <div className="leaderboard-empty muted">{emptyMessage}</div>;

  return (
    <div className="leaderboard-table-scroll" ref={scrollRef}>
      <table className="leaderboard-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column}
                className={isBoardColumn(column) && boardOf(column) === activeBoard
                  ? "leaderboard-board-column is-ranked"
                  : isBoardColumn(column) ? "leaderboard-board-column" : undefined}
                aria-sort={sort.column === column ? (sort.descending ? "descending" : "ascending") : "none"}
              >
                <button type="button" className="leaderboard-sort" onClick={() => chooseSort(column)}>
                  {isBoardColumn(column)
                    ? leaderboardLabel(boardOf(column))
                    : t(LABELS[column])}
                  {sort.column === column && <span aria-hidden="true">{sort.descending ? "↓" : "↑"}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, shown).map((entry) => (
            <tr
              key={`${entry.playerId}-${entry.rank}`}
              className={selectedPlayerId === entry.playerId ? "surface-interactive is-selected" : "surface-interactive"}
              tabIndex={0}
              onClick={() => onSelect(entry)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(entry);
                }
              }}
            >
              {columns.map((column) => (
                <td
                  key={column}
                  className={column === "rank"
                    ? "leaderboard-rank"
                    : isBoardColumn(column) && boardOf(column) === activeBoard
                      ? "leaderboard-board-column is-ranked"
                      : isBoardColumn(column) ? "leaderboard-board-column" : undefined}
                >
                  {column === "player"
                    ? playerCell(entry)
                    : column === "league"
                      ? leagueCell(entry)
                      : format(entry, column, activeBoard, crossRatings)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rowBatch !== undefined && sorted.length > shown && (
        <Button className="leaderboard-show-more" onClick={() => setShown((current) => current + rowBatch)}>
          {t("leaderboard.showMore", { count: Math.min(rowBatch, sorted.length - shown) })}
        </Button>
      )}
    </div>
  );
}
