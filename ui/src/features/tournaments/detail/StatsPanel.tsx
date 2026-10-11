// A finished event's numbers: the website's Stats tab.
//
// Everyone sees it, once the event is over. The figures are `eventStats`, which
// counts them from the event the way the website's `drawStats` does; this only
// lays them out: the champion, the numbers, the teams by combined rating, and
// how much each map was played.

import type { Tourney } from "../../../ipc/bindings";
import { Icon } from "../../../design-system/Icon";
import { useTranslation } from "../../../i18n/useTranslation";
import { eventStats, usageBuckets } from "../statsPresentation";
import { teamNameOf } from "../bracket/matchParts";

/** The Team ratings list stops here, as the website's does. */
const TOP_TEAMS = 8;

function Card({ value, label, sub }: { value: number; label: string; sub?: string }) {
  return (
    <div className="surface tournament-stat-card">
      <div className="tournament-stat-value mono">{value}</div>
      <div className="tournament-stat-label">{label}</div>
      {sub !== undefined && <div className="tournament-stat-sub muted">{sub}</div>}
    </div>
  );
}

export function StatsPanel({ event }: { event: Tourney }) {
  const { t } = useTranslation();
  const stats = eventStats(event);
  const champion = teamNameOf(event, event.championTeamId);
  const played = stats.mapUse.filter((use) => use.count > 0);
  const most = Math.max(1, ...stats.mapUse.map((use) => use.count));

  return (
    <div className="tournament-stats">
      {champion !== null && (
        <section className="tournament-panel tournament-champion">
          <Icon name="trophy" size={26} className="tournament-champion-icon" />
          <div>
            <div className="tournament-cell-label">{t("tournaments.overview.champion")}</div>
            <h3>{champion}</h3>
          </div>
        </section>
      )}

      <section className="tournament-panel">
        <h4>{t("tournaments.stats.numbers")}</h4>
        <div className="tournament-stat-grid">
          <Card
            value={stats.signups}
            label={t("tournaments.stats.signups")}
            sub={
              stats.averageRating !== null
                ? t("tournaments.stats.signupsSub", { rating: stats.averageRating, count: stats.rated })
                : undefined
            }
          />
          {!stats.solo && (
            <Card value={stats.onTeams} label={t("tournaments.stats.onTeams")} sub={t("tournaments.stats.onTeamsSub")} />
          )}
          {!stats.solo && <Card value={stats.teams} label={t("tournaments.stats.teams")} />}
          <Card value={stats.series} label={t("tournaments.stats.series")} />
          <Card value={stats.games} label={t("tournaments.stats.games")} sub={t("tournaments.stats.gamesSub")} />
          {stats.mapsInDatabase > 0 && <Card value={stats.mapsInDatabase} label={t("tournaments.stats.mapsInDb")} />}
          {played.length > 0 && <Card value={played.length} label={t("tournaments.stats.mapsPlayed")} />}
          {stats.vetoesDone > 0 && <Card value={stats.vetoesDone} label={t("tournaments.stats.vetoes")} />}
          {stats.forfeits > 0 && (
            <Card
              value={stats.forfeits}
              label={t("tournaments.stats.forfeits")}
              sub={
                stats.decidedByForfeit > 0
                  ? t("tournaments.stats.forfeitsSub", { count: stats.decidedByForfeit })
                  : undefined
              }
            />
          )}
        </div>
      </section>

      {!stats.solo && stats.teamTotals.length > 0 && (
        <section className="tournament-panel">
          <h4>{t("tournaments.stats.teamRatings")}</h4>
          <ol className="tournament-placings">
            {stats.teamTotals.slice(0, TOP_TEAMS).map((total, index) => (
              <li key={total.teamId}>
                <span className="mono">{index + 1}</span>
                <span>{total.name}</span>
                <span className="mono muted">{total.rating}</span>
              </li>
            ))}
          </ol>
          <p className="muted">{t("tournaments.stats.teamRatingsNote")}</p>
        </section>
      )}

      {stats.mapUse.length > 0 && (
        <section className="tournament-panel">
          <h4>{t("tournaments.stats.mapUsage")}</h4>
          <p className="muted">
            {t("tournaments.stats.mapSummary", {
              count: stats.mapUse.length,
              played: played.length,
              unused: stats.mapUse.length - played.length,
            })}
            <br />
            {usageBuckets(stats.mapUse)
              .map((bucket) =>
                bucket.count === 0
                  ? t("tournaments.stats.bucketNever", { count: bucket.maps })
                  : t("tournaments.stats.bucketPlayed", { count: bucket.maps, times: bucket.count }),
              )
              .join(" · ")}
          </p>
          <ul className="tournament-map-usage">
            {stats.mapUse.map((use) => (
              <li key={use.mapId} className={use.count === 0 ? "is-unused" : undefined}>
                <span className="tournament-map-usage-name">{use.name}</span>
                <span className="tournament-map-usage-bar" aria-hidden="true">
                  <span style={{ width: use.count > 0 ? `${Math.max(4, (use.count / most) * 100)}%` : "0" }} />
                </span>
                <span className="mono">{use.count > 0 ? use.count : "–"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
