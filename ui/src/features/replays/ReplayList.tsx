import { useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../../design-system/Icon";
import { baseMapName, normalizeMapName } from "../../shared/mapPresentation";
import { formatRelativeDuration } from "../../shared/durations";
import { clientIntlTag } from "../../shared/dates";
import { t, type MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

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
  { label: "replays.column.map", className: "" },
  { label: "replays.column.game", className: "" },
  { label: "replays.column.mod", className: "" },
  { label: "replays.column.played", className: "" },
  { label: "replays.column.players", className: "replay-list-header-number" },
  { label: "replays.column.rating", className: "replay-list-header-number" },
  { label: "replays.column.duration", className: "" },
  { label: "replays.column.replay", className: "" },
] as const satisfies readonly { label: MessageKey; className: string }[];

export function formatReplayListTime(value: string | number, fallback = "N/A"): string {
  if (value === "" || (typeof value === "number" && value <= 0)) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? fallback
    : date.toLocaleTimeString(clientIntlTag(), { hour: "2-digit", minute: "2-digit" });
}

export function formatReplayListAge(value: string | number, fallback = "N/A"): string {
  if (value === "" || (typeof value === "number" && value <= 0)) return fallback;
  const played = new Date(value).getTime();
  if (Number.isNaN(played)) return fallback;
  const seconds = (Date.now() - played) / 1000;
  if (seconds < 0) return fallback;
  const justNow = t("replays.card.justNow");
  const elapsed = formatRelativeDuration(seconds, { nowLabel: justNow });
  return elapsed === justNow ? elapsed : t("replays.card.ago", { duration: elapsed });
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
  const { t } = useTranslation();
  const tone = cell.tone ? ` replay-list-status-${cell.tone}` : "";
  return (
    <div className="replay-list-cell replay-list-replay-cell" role="cell">
      <div className="replay-list-replay-summary">
        <span className={`replay-list-status${tone}`}>{cell.primary || "N/A"}</span>
        {cell.secondary && <small>{cell.secondary}</small>}
      </div>
      {(action || iconAction) && (
        <div className="replay-list-actions" role="group" aria-label={t("replays.list.actionsAria")}>
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

function ReplayListThumbnail({ url, mapName }: { url: string; mapName: string }) {
  const normalized = mapName ? normalizeMapName(mapName) : "";
  const baseName = mapName ? baseMapName(mapName) : "";
  const cdnFallback = normalized && !normalized.includes(" ")
    ? `https://content.faforever.com/maps/previews/small/${encodeURIComponent(normalized)}.png`
    : undefined;
  const baseFallback = baseName && baseName !== normalized && !baseName.includes(" ")
    ? `https://content.faforever.com/maps/previews/small/${encodeURIComponent(baseName)}.png`
    : undefined;

  const [currentUrl, setCurrentUrl] = useState(url || cdnFallback || baseFallback || "");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setCurrentUrl(url || cdnFallback || baseFallback || "");
    setFailed(false);
  }, [url, cdnFallback, baseFallback]);

  const handleError = () => {
    if (currentUrl === url && cdnFallback && currentUrl !== cdnFallback) {
      setCurrentUrl(cdnFallback);
    } else if (
      (currentUrl === url || currentUrl === cdnFallback) &&
      baseFallback &&
      currentUrl !== baseFallback
    ) {
      setCurrentUrl(baseFallback);
    } else {
      setFailed(true);
    }
  };

  if (!currentUrl || failed) {
    return (
      <span className="replay-list-thumb replay-list-thumb-empty" aria-label={`${mapName} preview unavailable`}>
        <Icon name="maps" size={17} />
      </span>
    );
  }

  return (
    <img
      className="replay-list-thumb"
      src={currentUrl}
      alt={`${mapName} preview`}
      loading="lazy"
      decoding="async"
      onError={handleError}
    />
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
        <ReplayListThumbnail url={row.mapThumbnailUrl} mapName={row.mapName} />
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
  const { t } = useTranslation();
  return (
    <section className="replay-list-wrap surface-panel" role="table" aria-label={t("replays.list.aria")}>
      <div className="replay-list-header" role="row">
        {COLUMNS.map((column) => <span className={column.className} key={column.label} role="columnheader">{t(column.label)}</span>)}
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
