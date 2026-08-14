import { useMemo, useState } from "react";
import type { LeaderboardEntry } from "../../ipc/bindings";
import { PlayerName } from "../../shared/nameColors";

export type LeaderboardColumn =
  | "rank"
  | "player"
  | "division"
  | "score"
  | "rating"
  | "mean"
  | "deviation"
  | "games"
  | "wins"
  | "winRate"
  | "updated";

const LABELS: Record<LeaderboardColumn, string> = {
  rank: "Rank",
  player: "Player",
  division: "Division",
  score: "Score",
  rating: "Rating",
  mean: "Mean",
  deviation: "Deviation",
  games: "Games",
  wins: "Wins",
  winRate: "Win rate",
  updated: "Updated",
};

function value(entry: LeaderboardEntry, column: LeaderboardColumn): number | string | null {
  switch (column) {
    case "rank": return entry.rank;
    case "player": return entry.playerName;
    case "division": return entry.division;
    case "score": return entry.score;
    case "rating": return entry.rating;
    case "mean": return entry.mean;
    case "deviation": return entry.deviation;
    case "games": return entry.gamesPlayed;
    case "wins": return entry.wonGames;
    case "winRate": return entry.wonGames === null || entry.gamesPlayed === 0
      ? null
      : entry.wonGames / entry.gamesPlayed;
    case "updated": return entry.updateTime;
  }
}

function format(entry: LeaderboardEntry, column: LeaderboardColumn): string {
  const raw = value(entry, column);
  if (raw === null || raw === "") return "N/A";
  if (column === "mean" || column === "deviation") return Number(raw).toFixed(1);
  if (column === "winRate") return `${(Number(raw) * 100).toFixed(1)}%`;
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
          title={`${entry.playerName} avatar`}
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

function compare(a: LeaderboardEntry, b: LeaderboardEntry, column: LeaderboardColumn): number {
  const left = value(a, column);
  const right = value(b, column);
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

interface LeaderboardTableProps {
  entries: LeaderboardEntry[];
  columns: LeaderboardColumn[];
  selectedPlayerId: number | null;
  onSelect: (entry: LeaderboardEntry) => void;
  emptyMessage?: string;
}

export function LeaderboardTable({
  entries,
  columns,
  selectedPlayerId,
  onSelect,
  emptyMessage = "No players match the current filters.",
}: LeaderboardTableProps) {
  const [sort, setSort] = useState<{ column: LeaderboardColumn; descending: boolean }>({
    column: "rank",
    descending: false,
  });
  const sorted = useMemo(() => [...entries].sort((a, b) => {
    const result = compare(a, b, sort.column);
    return sort.descending ? -result : result;
  }), [entries, sort]);

  const chooseSort = (column: LeaderboardColumn) => setSort((current) => current.column === column
    ? { column, descending: !current.descending }
    : { column, descending: column !== "rank" && column !== "player" });

  if (sorted.length === 0) return <div className="leaderboard-empty muted">{emptyMessage}</div>;

  return (
    <div className="leaderboard-table-scroll">
      <table className="leaderboard-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} aria-sort={sort.column === column ? (sort.descending ? "descending" : "ascending") : "none"}>
                <button type="button" className="leaderboard-sort" onClick={() => chooseSort(column)}>
                  {LABELS[column]}
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
                <td key={column} className={column === "rank" ? "leaderboard-rank" : undefined}>
                  {column === "player" ? playerCell(entry) : format(entry, column)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
