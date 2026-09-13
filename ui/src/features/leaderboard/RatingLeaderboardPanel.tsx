import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import {
  SearchField,
  SearchPanel,
  SearchPanelSubmit,
} from "../../design-system/SearchPanel";
import { Pagination } from "../../design-system/Pagination";
import type { LeaderboardColumn, TableColumn } from "./LeaderboardTable";
import { crossRatingIndex, LeaderboardTable } from "./LeaderboardTable";
import { PlayerDetailsPanel } from "./PlayerDetailsPanel";
import { ipc } from "../../ipc/client";
import type { LeaderboardEntry, RatingQuery } from "../../ipc/bindings";
import { formatNumber, type MessageKey } from "../../i18n";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";

/**
 * The columns beside the boards.
 *
 * No rating: every board has a column of its own now, the ranked one included,
 * so a "Rating" column would be one of them printed twice. No wins either. The
 * API counts won games over a different set of games than it counts played
 * ones, which is what made the win rate wrong, and the count is wrong for the
 * same reason: "if we delete the winrate we have to delete also the wins
 * (theyre wrong too)".
 */
const OPTIONAL_COLUMNS: Array<{ key: LeaderboardColumn; label: MessageKey }> = [
  { key: "mean", label: "leaderboard.column.mean" },
  { key: "deviation", label: "leaderboard.column.deviation" },
  { key: "games", label: "leaderboard.column.games" },
  { key: "updated", label: "leaderboard.column.updated" },
];

function dayValue(timestamp: string | null): string {
  return timestamp ? timestamp.slice(0, 10) : "";
}

function dayStart(day: string): string | null {
  return day ? new Date(`${day}T00:00:00`).toISOString() : null;
}

function dayEnd(day: string): string | null {
  return day ? new Date(`${day}T23:59:59.999`).toISOString() : null;
}

function load(query: RatingQuery) {
  ipc.send({ kind: "Leaderboard", command: { type: "loadRatings", payload: { query } } });
}

export function RatingLeaderboardPanel() {
  const { t } = useTranslation();
  const state = useAppStore((store) => store.state.leaderboard);
  const browsing = useAppStore((store) => store.state.settings.browsing);
  const [player, setPlayer] = useState(state.ratingQuery.player);
  const [activeOnly, setActiveOnly] = useState(state.ratingQuery.activeOnly);
  const [after, setAfter] = useState(dayValue(state.ratingQuery.updatedAfter));
  const [before, setBefore] = useState(dayValue(state.ratingQuery.updatedBefore));
  const [pageSize, setPageSize] = useState(state.ratingQuery.pageSize);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsRef = useRef<HTMLDivElement>(null);
  const visibleColumns = (browsing.leaderboardRatingColumns ?? [
    "games", "updated",
  ]) as LeaderboardColumn[];
  const [selected, setSelected] = useState<LeaderboardEntry | null>(null);

  const toggleColumn = (key: LeaderboardColumn) => {
    const updated = visibleColumns.includes(key)
      ? visibleColumns.filter((col) => col !== key)
      : [...visibleColumns, key];
    if (updated.length === 0) return;
    ipc.send({
      kind: "Settings",
      command: {
        type: "setBrowsing",
        payload: {
          preferences: {
            ...browsing,
            leaderboardRatingColumns: updated,
          },
        },
      },
    });
  };

  useEffect(() => {
    if (state.catalogStatus.type !== "ready" || state.ratingsStatus.type !== "idle") return;
    const preferred = state.ratingLeaderboards.find((board) => board.technicalName === state.ratingQuery.leaderboard)
      ?? state.ratingLeaderboards[0];
    if (preferred) void load({ ...state.ratingQuery, leaderboard: preferred.technicalName, page: 1 });
  }, [state.catalogStatus.type, state.ratingLeaderboards, state.ratingQuery, state.ratingsStatus.type]);

  useEffect(() => {
    setSelected((current) => current && state.ratingPage.entries.some((entry) => entry.playerId === current.playerId)
      ? current
      : null);
  }, [state.ratingPage.entries]);

  useEffect(() => {
    setPlayer(state.ratingQuery.player);
    setActiveOnly(state.ratingQuery.activeOnly);
    setAfter(dayValue(state.ratingQuery.updatedAfter));
    setBefore(dayValue(state.ratingQuery.updatedBefore));
    setPageSize(state.ratingQuery.pageSize);
  }, [state.ratingQuery]);

  useEffect(() => {
    if (!columnsOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!columnsRef.current?.contains(event.target as Node)) setColumnsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setColumnsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [columnsOpen]);

  const currentBoard = state.ratingLeaderboards.find((board) => board.technicalName === state.ratingQuery.leaderboard);
  const entries = state.ratingPage.entries;
  // Every board gets a column. Which of them the page is ranked by is the
  // column header that was last pressed, not a tab above the table.
  const boardColumns: TableColumn[] = state.ratingLeaderboards.map(
    (board) => `board:${board.technicalName}` as const,
  );
  const crossRatings = useMemo(
    () => crossRatingIndex(state.crossRatings),
    [state.crossRatings],
  );
  const submit = () => void load({
    leaderboard: state.ratingQuery.leaderboard,
    page: 1,
    pageSize,
    activeOnly,
    updatedAfter: activeOnly ? null : dayStart(after),
    updatedBefore: activeOnly ? null : dayEnd(before),
    player: player.trim(),
  });
  const changeActivityFilter = (nextActiveOnly: boolean) => {
    setActiveOnly(nextActiveOnly);
    void load({
      leaderboard: state.ratingQuery.leaderboard,
      page: 1,
      pageSize,
      activeOnly: nextActiveOnly,
      updatedAfter: nextActiveOnly ? null : dayStart(after),
      updatedBefore: nextActiveOnly ? null : dayEnd(before),
      player: player.trim(),
    });
  };
  const changePage = (page: number) => void load({ ...state.ratingQuery, page });
  const columns: TableColumn[] = ["rank", "player", ...boardColumns, ...visibleColumns];
  const clearFilters = () => {
    setPlayer("");
    setActiveOnly(true);
    setAfter("");
    setBefore("");
    setPageSize(100);
    void load({ ...state.ratingQuery, page: 1, pageSize: 100, activeOnly: true, updatedAfter: null, updatedBefore: null, player: "" });
  };

  return (
    <section className="leaderboard-panel">
      {/* No tabs. There is one table with every board in it, and the board the
          ladder is ranked by is chosen by pressing that board's column
          header: a strip of tabs above a table whose columns are the same
          five boards was the same choice offered twice. */}
      {currentBoard && (
        <p className="leaderboard-description muted">
          <span>{t("leaderboard.ratings.rankedByBoard", { board: currentBoard.name })}</span>
          {currentBoard.description && <span className="leaderboard-description-note">{currentBoard.description}</span>}
        </p>
      )}

      <SearchPanel
        className="leaderboard-search-panel"
        onSubmit={(event) => { event.preventDefault(); submit(); }}
        secondary={(
          <>
            <Button className={activeOnly ? "active" : ""} onClick={() => changeActivityFilter(true)}>{t("leaderboard.ratings.activeThisMonth")}</Button>
            <Button className={!activeOnly ? "active" : ""} onClick={() => changeActivityFilter(false)}>{t("leaderboard.ratings.allPlayers")}</Button>
            <span className="spacer" />
            <span className="leaderboard-result-count muted">
              {state.ratingPage.totalResults === null
                ? `${state.ratingPage.entries.length} loaded`
                : t("leaderboard.rating.playerCount", {
                  count: state.ratingPage.totalResults,
                  formatted: formatNumber(state.ratingPage.totalResults),
                })}
            </span>
            <div className="leaderboard-columns" ref={columnsRef}>
              <Button
                className={`leaderboard-columns-trigger${columnsOpen ? " active" : ""}`}
                aria-expanded={columnsOpen}
                aria-haspopup="dialog"
                onClick={() => setColumnsOpen((open) => !open)}
              >
                <Icon name="filter" size={16} /> {t("leaderboard.ratings.columns")}
              </Button>
              {columnsOpen && <div className="leaderboard-columns-menu" role="dialog" aria-label={t("leaderboard.ratings.visibleLeaderboardColumns")}>
                <div className="leaderboard-columns-menu-header">
                  <strong>{t("leaderboard.ratings.visibleColumns")}</strong>
                  <button type="button" className="leaderboard-columns-close" aria-label={t("leaderboard.ratings.closeColumnsMenu")} onClick={() => setColumnsOpen(false)}>
                    <Icon name="close" size={14} />
                  </button>
                </div>
                {OPTIONAL_COLUMNS.map((column) => (
                  <label key={column.key}>
                    <input
                      type="checkbox"
                      checked={visibleColumns.includes(column.key)}
                      onChange={() => toggleColumn(column.key)}
                    />
                    {t(column.label)}
                  </label>
                ))}
              </div>}
            </div>
            <Button onClick={clearFilters}>{t("leaderboard.ratings.clear")}</Button>
            <Button aria-label={t("leaderboard.ratings.refreshRankings")} onClick={() => void load(state.ratingQuery)}><Icon name="refresh" size={15} /> {t("leaderboard.ratings.refresh")}</Button>
          </>
        )}
      >
        <SearchField label={t("leaderboard.ratings.exactPlayer")} className="leaderboard-search-player">
          <input className="search-panel-control" value={player} placeholder={t("leaderboard.ratings.playerName")} onChange={(event) => setPlayer(event.target.value)} />
        </SearchField>
        <SearchField label={t("leaderboard.ratings.updatedAfter")} className="leaderboard-search-date">
          <input className="search-panel-control" type="date" value={after} readOnly={activeOnly} aria-disabled={activeOnly} onChange={(event) => setAfter(event.target.value)} />
        </SearchField>
        <SearchField label={t("leaderboard.ratings.updatedBefore")} className="leaderboard-search-date">
          <input className="search-panel-control" type="date" value={before} readOnly={activeOnly} aria-disabled={activeOnly} onChange={(event) => setBefore(event.target.value)} />
        </SearchField>
        <SearchField label={t("leaderboard.ratings.rows")} className="leaderboard-search-rows">
          <select className="search-panel-control" value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
            {[25, 50, 75, 100].map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </SearchField>
        <SearchPanelSubmit disabled={state.ratingsStatus.type === "loading"} />
      </SearchPanel>

      <div className="leaderboard-main-grid">
        <div className={`leaderboard-results surface-panel${state.ratingsStatus.type === "loading" ? " is-loading" : ""}`}>
          {state.ratingsStatus.type === "failed" ? (
            <div className="leaderboard-state leaderboard-error">{state.ratingsStatus.payload.reason}</div>
          ) : entries.length === 0 && state.ratingsStatus.type === "loading" ? (
            <div className="leaderboard-state muted">Loading rankings…</div>
          ) : (
            <LeaderboardTable
              entries={entries}
              columns={columns}
              boards={state.ratingLeaderboards}
              activeBoard={state.ratingQuery.leaderboard}
              crossRatings={crossRatings}
              selectedPlayerId={selected?.playerId ?? null}
              onSelect={setSelected}
              onRankBy={(leaderboard) => void load({ ...state.ratingQuery, leaderboard, page: 1 })}
              emptyMessage={t("leaderboard.ratings.empty")}
            />
          )}
        </div>
        <PlayerDetailsPanel entry={selected} />
      </div>

      <div className="vault-pagination">
        <Pagination
          currentPage={state.ratingPage.page}
          totalPages={state.ratingPage.totalPages}
          onPageChange={changePage}
          ariaLabel={t("leaderboard.ratings.leaderboardPages")}
        />
      </div>
    </section>
  );
}
