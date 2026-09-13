import { useMemo, useState } from "react";
import type { LeaderboardEntry, PlayerRatings, RatingLeaderboard } from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerName } from "../../shared/nameColors";

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
 * The rating table showed one board at a time and switched between them with
 * the tabs. Taking out the win rate and the win count, both of which the API
 * answers wrongly, left a rank, a name and one number; the thread's answer was
 * to stop switching and "display Global, 1v1, 2v2, 3v3, 4v4 in one view", with
 * the tabs deciding which of them the ranking is by.
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
    case "league": return entry.division;
    case "division": return entry.division;
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
  if (raw === null || raw === "") return "N/A";
  if (column === "mean" || column === "deviation") return Number(raw).toFixed(1);
  if (column === "updated") {
    const date = new Date(String(raw));
    return Number.isNaN(date.valueOf()) ? String(raw) : date.toLocaleString("en-US");
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
      <PlayerName name={entry.playerName} />
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
      title={entry.division || undefined}
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

function compare(
  a: LeaderboardEntry,
  b: LeaderboardEntry,
  column: TableColumn,
  activeBoard: string,
  cross: CrossRatings,
): number {
  const left = cellValue(a, column, activeBoard, cross);
  const right = cellValue(b, column, activeBoard, cross);
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

interface LeaderboardTableProps {
  entries: LeaderboardEntry[];
  columns: TableColumn[];
  selectedPlayerId: number | null;
  onSelect: (entry: LeaderboardEntry) => void;
  emptyMessage?: string;
  /** The boards with a column, for their names in the header. */
  boards?: RatingLeaderboard[];
  /** Which board the page is ranked by. Its column is the emphasised one. */
  activeBoard?: string;
  /** What the other boards say, once the second request has answered. */
  crossRatings?: CrossRatings;
}

const NO_CROSS_RATINGS: CrossRatings = new Map();

export function LeaderboardTable({
  entries,
  columns,
  selectedPlayerId,
  onSelect,
  emptyMessage,
  boards = [],
  activeBoard = "",
  crossRatings = NO_CROSS_RATINGS,
}: LeaderboardTableProps) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<{ column: TableColumn; descending: boolean }>({
    column: "rank",
    descending: false,
  });
  const boardNames = useMemo(
    () => new Map(boards.map((board) => [board.technicalName, board.name])),
    [boards],
  );
  const sorted = useMemo(() => [...entries].sort((a, b) => {
    const result = compare(a, b, sort.column, activeBoard, crossRatings);
    return sort.descending ? -result : result;
  }), [activeBoard, crossRatings, entries, sort]);

  const chooseSort = (column: TableColumn) => setSort((current) => current.column === column
    ? { column, descending: !current.descending }
    : { column, descending: column !== "rank" && column !== "player" });

  if (sorted.length === 0) return <div className="leaderboard-empty muted">{emptyMessage}</div>;

  return (
    <div className="leaderboard-table-scroll">
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
                    ? boardNames.get(boardOf(column)) ?? boardOf(column)
                    : t(LABELS[column])}
                  {sort.column === column && <span aria-hidden="true">{sort.descending ? "↓" : "↑"}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((entry) => (
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
    </div>
  );
}
