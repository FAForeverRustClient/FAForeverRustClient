import type { ReactNode } from "react";
import { Icon, type IconName } from "../../design-system/Icon";
import { formatRelativeDuration } from "../../shared/durations";

export type ReplayListCell = {
  primary: string;
  secondary?: string;
  tone?: "ok" | "warn" | "error" | "muted";
};

export type ReplayListAction = {
  label: string;
  onClick: () => void;
  ariaLabel: string;
  disabled?: boolean;
};

export type ReplayListIconAction = {
  icon: IconName;
  onClick: () => void;
  ariaLabel: string;
  title: string;
};

export type ReplayListRow = {
  key: string;
  mapName: string;
  mapThumbnailUrl: string;
  game: ReplayListCell;
  played: ReplayListCell;
  players: ReplayListCell;
  rating: ReplayListCell;
  mod: ReplayListCell;
  duration: ReplayListCell;
  replay: ReplayListCell;
  selected?: boolean;
  watched?: boolean;
  onSelect?: () => void;
  onActivate?: () => void;
  action?: ReplayListAction;
  iconAction?: ReplayListIconAction;
};

export type ReplayListGroup = {
  label: string;
  rows: ReplayListRow[];
};

const COLUMNS = [
  { label: "Map", className: "" },
  { label: "Game", className: "" },
  { label: "Mod", className: "" },
  { label: "Played", className: "" },
  { label: "Players", className: "replay-list-header-number" },
  { label: "Rating", className: "replay-list-header-number" },
  { label: "Duration", className: "" },
  { label: "Replay", className: "" },
] as const;

export function formatReplayListTime(value: string | number, fallback = "N/A"): string {
  if (value === "" || (typeof value === "number" && value <= 0)) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? fallback
    : date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

export function formatReplayListAge(value: string | number, fallback = "N/A"): string {
  if (value === "" || (typeof value === "number" && value <= 0)) return fallback;
  const played = new Date(value).getTime();
  if (Number.isNaN(played)) return fallback;
  const seconds = (Date.now() - played) / 1000;
  if (seconds < 0) return fallback;
  return formatRelativeDuration(seconds, { nowLabel: "just now", suffix: " ago" });
}

function ReplayListCellView({ cell, className = "" }: { cell: ReplayListCell; className?: string }) {
  return (
    <div className={`replay-list-cell ${className}`.trim()} role="cell">
      <strong>{cell.primary || "N/A"}</strong>
      {cell.secondary && <small>{cell.secondary}</small>}
    </div>
  );
}

function ReplayListStatus({
  cell,
  action,
  iconAction,
}: {
  cell: ReplayListCell;
  action?: ReplayListAction;
  iconAction?: ReplayListIconAction;
}) {
  const tone = cell.tone ? ` replay-list-status-${cell.tone}` : "";
  return (
    <div className="replay-list-cell replay-list-replay-cell" role="cell">
      <div className="replay-list-replay-summary">
        <span className={`replay-list-status${tone}`}>{cell.primary || "N/A"}</span>
        {cell.secondary && <small>{cell.secondary}</small>}
      </div>
      {(action || iconAction) && (
        <div className="replay-list-actions" role="group" aria-label="Replay actions">
          {action && (
            <button
              type="button"
              className="replay-list-action"
              aria-label={action.ariaLabel}
              disabled={action.disabled}
              onClick={(event) => {
                event.stopPropagation();
                action.onClick();
              }}
            >
              {action.label}
            </button>
          )}
          {iconAction && (
            <button
              type="button"
              className="replay-list-icon-action"
              aria-label={iconAction.ariaLabel}
              title={iconAction.title}
              onClick={(event) => {
                event.stopPropagation();
                iconAction.onClick();
              }}
            >
              <Icon name={iconAction.icon} size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ReplayListRowView({ row }: { row: ReplayListRow }) {
  const interactive = Boolean(row.onSelect || row.onActivate);
  return (
    <div
      className={`replay-list-row${row.selected ? " selected" : ""}${row.watched ? " watched" : ""}`}
      role="row"
      tabIndex={interactive ? 0 : -1}
      aria-selected={row.selected || undefined}
      onClick={row.onSelect}
      onDoubleClick={row.onActivate}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && row.onActivate) {
          event.preventDefault();
          row.onActivate();
        }
      }}
    >
      <div className="replay-list-cell replay-list-map-cell" role="cell">
        {row.mapThumbnailUrl ? (
          <img className="replay-list-thumb" src={row.mapThumbnailUrl} alt={`${row.mapName} preview`} loading="lazy" />
        ) : (
          <span className="replay-list-thumb replay-list-thumb-empty" aria-label={`${row.mapName} preview unavailable`}>
            <Icon name="maps" size={17} />
          </span>
        )}
      </div>
      <ReplayListCellView cell={row.game} className="replay-list-game-cell" />
      <ReplayListCellView cell={row.mod} className="replay-list-mod-cell" />
      <ReplayListCellView cell={row.played} className="replay-list-played-cell" />
      <ReplayListCellView cell={row.players} className="replay-list-number-cell" />
      <ReplayListCellView cell={row.rating} className="replay-list-number-cell" />
      <ReplayListCellView cell={row.duration} className="replay-list-duration-cell" />
      <ReplayListStatus cell={row.replay} action={row.action} iconAction={row.iconAction} />
    </div>
  );
}

export function ReplayList({
  groups,
  footer,
}: {
  groups: ReplayListGroup[];
  footer: ReactNode;
}) {
  return (
    <section className="replay-list-wrap surface-panel" role="table" aria-label="Replays">
      <div className="replay-list-header" role="row">
        {COLUMNS.map((column) => <span className={column.className} key={column.label} role="columnheader">{column.label}</span>)}
      </div>
      <div className="replay-list-body" role="rowgroup">
        {groups.map((group) => (
          <div className="replay-list-group" key={group.label}>
            <div className="replay-list-group-header" role="row">
              <span>{group.label}</span>
              <small>{group.rows.length} {group.rows.length === 1 ? "replay" : "replays"}</small>
            </div>
            {group.rows.map((row) => <ReplayListRowView key={row.key} row={row} />)}
          </div>
        ))}
      </div>
      <footer className="replay-list-footer">{footer}</footer>
    </section>
  );
}
