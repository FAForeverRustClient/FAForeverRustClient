import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { SectionTabs } from "../../design-system/SectionTabs";
import { ipc } from "../../ipc/client";
import type { LeaderboardEntry, LeaderboardTier } from "../../ipc/bindings";
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

function DivisionDistribution({ tiers, entries, ownDivision }: {
  tiers: LeaderboardTier[];
  entries: LeaderboardEntry[];
  ownDivision: string | null;
}) {
  const { t } = useTranslation();
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const entry of entries) {
      if (entry.division) result.set(entry.division, (result.get(entry.division) ?? 0) + 1);
    }
    return result;
  }, [entries]);
  const ordered = useMemo(() => [...tiers].sort((a, b) => b.divisionOrder - a.divisionOrder), [tiers]);
  const max = Math.max(1, ...counts.values());

  if (ordered.length === 0) return null;
  return (
    <section className="leaderboard-distribution-card surface-panel">
      <div className="leaderboard-section-title">
        <div><h3>{t("leaderboard.leagues.population")}</h3><span className="muted">{t("leaderboard.leagues.populationHint")}</span></div>
        <span className="muted">{entries.length} placed</span>
      </div>
      <div className="leaderboard-distribution">
        {ordered.map((tier) => {
          const count = counts.get(tier.name) ?? 0;
          return (
            <div key={tier.name} className={`leaderboard-distribution-row${tier.name === ownDivision ? " is-current" : ""}`}>
              <span className="leaderboard-distribution-label">{tier.name}</span>
              <div className="leaderboard-distribution-track">
                <div className="leaderboard-distribution-bar" style={{ width: `${Math.max(2, (count / max) * 100)}%` }} />
              </div>
              <span className="leaderboard-distribution-count">{count}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MyLeagueCard({ entry, placementGames }: { entry: LeaderboardEntry | null; placementGames: number }) {
  const { t } = useTranslation();
  if (!entry) {
    return (
      <section className="leaderboard-own-card surface-panel">
        <div className="leaderboard-own-placeholder"><Icon name="activity" size={24} /></div>
        <div>
          <span className="leaderboard-eyebrow">{t("leaderboard.leagues.yourPlacement")}</span>
          <h3>{t("leaderboard.leagues.notPlaced")}</h3>
          <p className="muted">Complete {placementGames} placement games to enter a subdivision.</p>
        </div>
      </section>
    );
  }
  const score = entry.score ?? 0;
  const ceiling = Math.max(score, entry.highestScore ?? score, 1);
  const progress = Math.min(100, Math.max(0, (score / ceiling) * 100));
  return (
    <section className="leaderboard-own-card surface-panel">
      {entry.divisionImageUrl
        ? <img src={entry.divisionImageUrl} alt="" onError={(event) => { event.currentTarget.hidden = true; }} />
        : <div className="leaderboard-own-placeholder"><Icon name="leaderboard" size={24} /></div>}
      <div className="leaderboard-own-body">
        <span className="leaderboard-eyebrow">{t("leaderboard.leagues.yourPosition")}</span>
        <h3>#{entry.rank} · {entry.division ?? t("leaderboard.leagues.placed")}</h3>
        <div className="leaderboard-progress" aria-label={`${progress.toFixed(0)} percent subdivision score progress`}>
          <span style={{ width: `${progress}%` }} />
        </div>
        <p className="muted">{score} score · {entry.gamesPlayed} games</p>
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

  return (
    <section className="leaderboard-panel">
      <SectionTabs
        active={state.selectedLeagueId}
        ariaLabel={t("leaderboard.leagues.leagueQueues")}
        className="leaderboard-tabs"
        items={state.leagues.map((league) => ({ id: league.id, label: league.name }))}
        onChange={(leagueId) => void selectLeague(leagueId)}
      />

      <div className="leaderboard-season-toolbar">
        <label className="leaderboard-field">
          <span>{t("leaderboard.leagues.season")}</span>
          <select
            value={state.selectedSeasonId ?? ""}
            disabled={state.seasonsStatus.type === "loading" || state.seasons.length === 0}
            onChange={(event) => void selectSeason(Number(event.target.value))}
          >
            {state.seasons.map((season) => (
              <option key={season.id} value={season.id}>{season.name || `Season ${season.seasonNumber}`}</option>
            ))}
          </select>
        </label>
        {currentSeason && (
          <div className="leaderboard-season-meta">
            <span className={currentSeason.active ? "leaderboard-active" : "muted"}>{t(currentSeason.active ? "leaderboard.leagues.active" : "leaderboard.leagues.finished")}</span>
            <span>{formatDate(currentSeason.startDate)} – {formatDate(currentSeason.endDate)}</span>
          </div>
        )}
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
            <DivisionDistribution tiers={state.tiers} entries={state.seasonEntries} ownDivision={ownEntry?.division ?? null} />
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
                  columns={["rank", "player", "division", "score", "games"]}
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
