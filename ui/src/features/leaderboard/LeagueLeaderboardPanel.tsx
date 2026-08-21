import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { SectionTabs } from "../../design-system/SectionTabs";
import { ipc } from "../../ipc/client";
import type { LeaderboardEntry, LeaderboardTier, LeagueSeason } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { formatDate } from "../../shared/dates";
import { LeaderboardTable } from "./LeaderboardTable";
import { PlayerDetailsPanel } from "./PlayerDetailsPanel";
import { useTranslation } from "../../i18n/useTranslation";

const selectLeague = (leagueId: number) => ipc.send({
  kind: "Leaderboard",
  command: { type: "selectLeague", payload: { leagueId } },
});
const selectSeason = (seasonId: number) => ipc.send({
  kind: "Leaderboard",
  command: { type: "selectSeason", payload: { seasonId } },
});

function SeasonPicker({
  label,
  seasons,
  selectedSeasonId,
  disabled,
  onChange,
}: {
  label: string;
  seasons: LeagueSeason[];
  selectedSeasonId: number | null;
  disabled: boolean;
  onChange: (seasonId: number) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const selectedIndex = Math.max(0, seasons.findIndex((season) => season.id === selectedSeasonId));
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 240, maxHeight: 360 });
  const selectedSeason = seasons[selectedIndex];

  const updatePosition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const width = Math.min(Math.max(rect.width, 240), Math.max(160, viewportWidth - 16));
    const left = Math.min(Math.max(8, rect.left), Math.max(8, viewportWidth - width - 8));
    const gap = 4;
    const below = Math.max(0, viewportHeight - rect.bottom - gap);
    const above = Math.max(0, rect.top - gap);
    const opensAbove = below < 240 && above > below;
    const maxHeight = Math.max(120, Math.min(420, opensAbove ? above : below));
    setPosition({
      top: opensAbove ? rect.top - maxHeight - gap : rect.bottom + gap,
      left,
      width,
      maxHeight,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  const openPicker = () => {
    if (disabled || seasons.length === 0) return;
    setActiveIndex(selectedIndex);
    setOpen(true);
  };
  const choose = (seasonId: number) => {
    onChange(seasonId);
    setOpen(false);
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || seasons.length === 0) return;
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openPicker();
        return;
      }
    }
    if (!open) return;
    if (event.key === "ArrowDown") setActiveIndex((index) => Math.min(seasons.length - 1, index + 1));
    if (event.key === "ArrowUp") setActiveIndex((index) => Math.max(0, index - 1));
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(seasons.length - 1);
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const season = seasons[activeIndex];
      if (season) choose(season.id);
    }
  };

  return (
    <div className="leaderboard-season-picker">
      <span className="leaderboard-field-label">{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className="leaderboard-season-trigger"
        disabled={disabled || seasons.length === 0}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={menuId}
        aria-activedescendant={open && seasons[activeIndex] ? `${menuId}-option-${seasons[activeIndex].id}` : undefined}
        onClick={() => (open ? setOpen(false) : openPicker())}
        onKeyDown={handleKeyDown}
      >
        <span>{selectedSeason?.name || (selectedSeason ? `Season ${selectedSeason.seasonNumber}` : "")}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          id={menuId}
          className="leaderboard-season-popover"
          role="listbox"
          aria-label={label}
          style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}
        >
          {seasons.map((season, index) => (
            <button
              key={season.id}
              id={`${menuId}-option-${season.id}`}
              type="button"
              role="option"
              aria-selected={season.id === selectedSeasonId}
              className={index === activeIndex ? "is-active" : undefined}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(season.id)}
            >
              {season.name || `Season ${season.seasonNumber}`}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

function DivisionDistribution({ tiers, entries, ownDivision, seasonContext }: {
  tiers: LeaderboardTier[];
  entries: LeaderboardEntry[];
  ownDivision: string | null;
  seasonContext: ReactNode;
}) {
  const { t } = useTranslation();
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const entry of entries) {
      if (entry.division) result.set(entry.division, (result.get(entry.division) ?? 0) + 1);
    }
    return result;
  }, [entries]);
  const groups = useMemo(() => {
    const grouped = new Map<string, LeaderboardTier[]>();
    for (const tier of tiers) {
      const divisionTiers = grouped.get(tier.division) ?? [];
      divisionTiers.push(tier);
      grouped.set(tier.division, divisionTiers);
    }
    return [...grouped.entries()]
      .map(([division, divisionTiers]) => ({
        division,
        tiers: divisionTiers.sort((left, right) => left.divisionOrder - right.divisionOrder),
      }))
      .sort((left, right) => (left.tiers[0]?.divisionOrder ?? 0) - (right.tiers[0]?.divisionOrder ?? 0));
  }, [tiers]);
  const max = Math.max(1, ...tiers.map((tier) => counts.get(tier.name) ?? 0));
  const divisionClass = (division: string) => {
    switch (division.toLocaleLowerCase()) {
      case "bronze": return "is-bronze";
      case "silver": return "is-silver";
      case "gold": return "is-gold";
      case "diamond": return "is-diamond";
      case "master": return "is-master";
      case "grandmaster": return "is-grandmaster";
      default: return "is-neutral";
    }
  };

  if (groups.length === 0) return null;
  return (
    <section className="leaderboard-distribution-card surface-panel">
      <div className="leaderboard-distribution-heading">
        <div className="leaderboard-section-title">
          <h3>{t("leaderboard.leagues.population")}</h3>
          <span className="muted">{entries.length} placed</span>
        </div>
        {seasonContext}
      </div>
      <div className="leaderboard-distribution-chart" role="img" aria-label={t("leaderboard.leagues.population")}>
        <div className="leaderboard-distribution-plot">
          <div className="leaderboard-distribution-groups">
            {groups.map((group) => (
              <div key={group.division} className={`leaderboard-distribution-group ${divisionClass(group.division)}`}>
                <div className="leaderboard-distribution-bars">
                  {group.tiers.map((tier) => {
                    const count = counts.get(tier.name) ?? 0;
                    const height = count === 0 ? "0%" : `${Math.max(4, (count / max) * 86)}%`;
                    return (
                      <div
                        key={tier.name}
                        className={`leaderboard-distribution-bar-wrap ${divisionClass(group.division)}${tier.name === ownDivision ? " is-current" : ""}`}
                        title={`${tier.name}: ${count}`}
                      >
                        <div className="leaderboard-distribution-bar-area">
                          <div className="leaderboard-distribution-bar-stack">
                            {count > 0 && <span className="leaderboard-distribution-value">{count}</span>}
                            <div className="leaderboard-distribution-bar" style={{ height }} />
                          </div>
                        </div>
                        <span className="leaderboard-distribution-subdivision">
                          {group.division === "Grandmaster" ? "GM" : tier.subdivision || tier.name}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <span className="leaderboard-distribution-label">{group.division}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function MyLeagueCard({ entry, placementGames }: { entry: LeaderboardEntry | null; placementGames: number }) {
  const { t } = useTranslation();
  if (!entry) {
    return (
      <section className="leaderboard-own-card leaderboard-own-card-empty surface-panel">
        <div className="leaderboard-own-card-main">
          <div className="leaderboard-own-placeholder"><Icon name="activity" size={24} /></div>
          <div>
            <span className="leaderboard-eyebrow">{t("leaderboard.leagues.yourPlacement")}</span>
            <h3>{t("leaderboard.leagues.notPlaced")}</h3>
            <p className="muted">{t("leaderboard.leagues.completePlacement", { count: placementGames })}</p>
            <div className="leaderboard-own-empty-meta">
              <span>{t("leaderboard.leagues.placementGames")}</span>
              <strong>{t("leaderboard.leagues.gamesRequired", { count: placementGames })}</strong>
            </div>
          </div>
        </div>
      </section>
    );
  }
  const score = entry.score ?? 0;
  const divisionImageUrl = entry.divisionImageUrl || entry.divisionMediumImageUrl;
  return (
    <section className="leaderboard-own-card leaderboard-own-card-ranked surface-panel">
      <div className="leaderboard-own-card-main">
        <div className="leaderboard-own-badge" aria-hidden={divisionImageUrl ? undefined : true}>
          {divisionImageUrl
            ? <img className="leaderboard-own-division-icon" src={divisionImageUrl} alt={entry.division ?? ""} width={80} height={52} decoding="async" onError={(event) => { event.currentTarget.hidden = true; }} />
            : <div className="leaderboard-own-placeholder"><Icon name="leaderboard" size={24} /></div>}
        </div>
        <div className="leaderboard-own-body">
          <span className="leaderboard-eyebrow">{t("leaderboard.leagues.yourPosition")}</span>
          <h3><span className="leaderboard-own-rank">#{entry.rank}</span><span className="leaderboard-own-divider" aria-hidden="true">·</span><span>{entry.division ?? t("leaderboard.leagues.placed")}</span></h3>
          <div className="leaderboard-own-stats" aria-label={`${score} ${t("leaderboard.column.score")}, ${entry.gamesPlayed} ${t("leaderboard.column.games")}`}>
            <div>
              <span>{t("leaderboard.column.score")}</span>
              <strong>{score}</strong>
            </div>
            <div>
              <span>{t("leaderboard.column.games")}</span>
              <strong>{entry.gamesPlayed}</strong>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function LeagueLeaderboardPanel() {
  const { t } = useTranslation();
  const state = useAppStore((store) => store.state.leaderboard);
  const player = useAppStore((store) => store.state.auth.player);
  const [search, setSearch] = useState("");
  const [division, setDivision] = useState("all");
  const [subdivision, setSubdivision] = useState("all");
  const [selected, setSelected] = useState<LeaderboardEntry | null>(null);

  useEffect(() => {
    if (state.catalogStatus.type === "ready" && state.selectedLeagueId === null && state.leagues[0]) {
      void selectLeague(state.leagues[0].id);
    }
  }, [state.catalogStatus.type, state.leagues, state.selectedLeagueId]);

  const currentSeason = state.seasons.find((season) => season.id === state.selectedSeasonId) ?? null;
  const ownEntry = useMemo(() => player
    ? state.seasonEntries.find((entry) => entry.playerId === player.id || entry.playerName.localeCompare(player.name, undefined, { sensitivity: "base" }) === 0) ?? null
    : null, [player, state.seasonEntries]);
  const divisions = useMemo(() => {
    const orders = new Map<string, number>();
    for (const tier of state.tiers) orders.set(tier.division, Math.max(orders.get(tier.division) ?? -1, tier.divisionOrder));
    return [...orders.keys()].sort((left, right) => (orders.get(right) ?? 0) - (orders.get(left) ?? 0));
  }, [state.tiers]);
  const subdivisions = useMemo(() => division === "all"
    ? []
    : [...state.tiers].filter((tier) => tier.division === division).sort((a, b) => b.divisionOrder - a.divisionOrder),
  [division, state.tiers]);
  const filtered = useMemo(() => {
    const acceptedTiers = division === "all"
      ? null
      : new Set(state.tiers.filter((tier) => tier.division === division).map((tier) => tier.name));
    const needle = search.trim().toLocaleLowerCase();
    return state.seasonEntries.filter((entry) => (
      (acceptedTiers === null || (entry.division !== null && acceptedTiers.has(entry.division)))
      && (subdivision === "all" || entry.division === subdivision)
      && (!needle || entry.playerName.toLocaleLowerCase().includes(needle))
    ));
  }, [division, search, state.seasonEntries, state.tiers, subdivision]);

  useEffect(() => {
    setDivision("all");
    setSubdivision("all");
    setSelected(ownEntry);
  }, [ownEntry, state.selectedSeasonId]);

  useEffect(() => {
    if (filtered.length === 0) {
      setSelected(null);
      return;
    }

    setSelected((current) => {
      if (current && filtered.some((entry) => entry.playerId === current.playerId)) {
        return current;
      }
      return ownEntry && filtered.some((entry) => entry.playerId === ownEntry.playerId)
        ? ownEntry
        : filtered[0];
    });
  }, [filtered, ownEntry]);

  return (
    <section className="leaderboard-panel">
      <div className="leaderboard-league-header">
        <SectionTabs
          active={state.selectedLeagueId}
          ariaLabel={t("leaderboard.leagues.leagueQueues")}
          className="leaderboard-tabs"
          items={state.leagues.map((league) => ({ id: league.id, label: league.name }))}
          onChange={(leagueId) => void selectLeague(leagueId)}
        />

      </div>

      {state.seasonsStatus.type === "loading" && <div className="leaderboard-state muted">Loading seasons…</div>}
      {state.seasonsStatus.type === "failed" && <div className="leaderboard-state leaderboard-error">{state.seasonsStatus.payload.reason}</div>}
      {state.seasonsStatus.type === "ready" && state.seasons.length === 0 && <div className="leaderboard-state muted">{t("leaderboard.leagues.noSeasons")}</div>}

      {currentSeason && (
        <>
          <div className="leaderboard-overview-grid">
            <MyLeagueCard entry={ownEntry} placementGames={ownEntry?.returningPlayer
              ? currentSeason.placementGamesReturningPlayer
              : currentSeason.placementGames} />
            <DivisionDistribution
              tiers={state.tiers}
              entries={state.seasonEntries}
              ownDivision={ownEntry?.division ?? null}
              seasonContext={(
                <div className="leaderboard-season-context">
                  <SeasonPicker
                    label={t("leaderboard.leagues.season")}
                    seasons={state.seasons}
                    selectedSeasonId={state.selectedSeasonId}
                    disabled={state.seasonsStatus.type === "loading"}
                    onChange={(seasonId) => void selectSeason(seasonId)}
                  />
                  {currentSeason && (
                    <div className="leaderboard-season-meta">
                      <span className={currentSeason.active ? "leaderboard-active" : "muted"}>{t(currentSeason.active ? "leaderboard.leagues.active" : "leaderboard.leagues.finished")}</span>
                      <span>{formatDate(currentSeason.startDate)} – {formatDate(currentSeason.endDate)}</span>
                    </div>
                  )}
                </div>
              )}
            />
          </div>

          <div className="leaderboard-table-toolbar leaderboard-league-filters">
            <label className="leaderboard-field leaderboard-field-grow">
              <span>{t("leaderboard.leagues.findPlayer")}</span>
              <input value={search} placeholder={t("leaderboard.leagues.searchLoadedSeason")} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <label className="leaderboard-field">
              <span>{t("leaderboard.leagues.division")}</span>
              <select value={division} onChange={(event) => { setDivision(event.target.value); setSubdivision("all"); }}>
                <option value="all">{t("leaderboard.leagues.allDivisions")}</option>
                {divisions.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            {subdivisions.length > 0 && (
              <div className="leaderboard-subdivisions" aria-label={t("leaderboard.leagues.subdivision")}>
                <Button variant={subdivision === "all" ? "primary" : "ghost"} onClick={() => setSubdivision("all")}>{t("leaderboard.leagues.all")}</Button>
                {subdivisions.map((tier) => (
                  <Button key={tier.name} variant={subdivision === tier.name ? "primary" : "ghost"} onClick={() => setSubdivision(tier.name)}>
                    {tier.subdivision || tier.name}
                  </Button>
                ))}
              </div>
            )}
          </div>

          <div className="leaderboard-main-grid">
            <div className={`leaderboard-results surface-panel${state.seasonStatus.type === "loading" ? " is-loading" : ""}`}>
              {state.seasonStatus.type === "failed" ? (
                <div className="leaderboard-state leaderboard-error">{state.seasonStatus.payload.reason}</div>
              ) : filtered.length === 0 && state.seasonStatus.type === "loading" ? (
                <div className="leaderboard-state muted">Loading season rankings…</div>
              ) : (
                <LeaderboardTable
                  entries={filtered}
                  columns={["rank", "player", "league", "division", "score", "games"]}
                  selectedPlayerId={selected?.playerId ?? null}
                  onSelect={setSelected}
                  emptyMessage={t("leaderboard.leagues.empty")}
                />
              )}
            </div>
            <PlayerDetailsPanel entry={selected} heading={t("leaderboard.leagues.leaguePlayer")} />
          </div>
        </>
      )}
    </section>
  );
}
