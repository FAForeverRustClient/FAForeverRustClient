// What the simulation itself said about the game when it ended.
//
// The Python client's "Game Stats" tab (`gamestats.py` in FAForever/client),
// with the same four groups of charts: scores, resources, units, and build
// against loss. The data is the `JsonStats` payload the sim sends once, so the
// numbers here are the game's own rather than anything this client worked out.
//
// Drawn as grouped bars in SVG. No charting library: this repository adds no
// dependency without knowing exactly what it is, and a grouped bar chart is
// forty lines.

import { useMemo, useState } from "react";
import { SectionTabs } from "../../design-system/SectionTabs";
import type { ReplayPlayerStats } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { compactNumber, STAT_LABEL_KEYS, UNIT_CATEGORIES } from "./replayAnalysis";

type StatsTab = "scores" | "resources" | "units" | "balance";

/** One bar in a group, and what it is called. */
interface Bar {
  label: string;
  value: number;
  tone: "built" | "lost" | "kills" | "extra";
}

/** One chart: a title, and a group of bars per player. */
function BarChart({
  title,
  players,
  groups,
}: {
  title: string;
  players: string[];
  groups: Bar[][];
}) {
  const peak = groups.reduce(
    (most, bars) => bars.reduce((inner, bar) => Math.max(inner, bar.value), most),
    0,
  );
  const width = 1000;
  const height = 260;
  const padLeft = 8;
  const padBottom = 34;
  const plotHeight = height - padBottom - 16;
  const slot = (width - padLeft) / Math.max(1, players.length);
  const barCount = Math.max(1, groups[0]?.length ?? 1);
  const barWidth = (slot * 0.72) / barCount;

  return (
    <figure className="replay-stats-chart">
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
        <line className="replay-chart-grid" x1={padLeft} x2={width} y1={16 + plotHeight} y2={16 + plotHeight} />
        {players.map((player, index) => {
          const bars = groups[index] ?? [];
          const left = padLeft + slot * index + slot * 0.14;
          return (
            <g key={`${player}-${index}`}>
              {bars.map((bar, barIndex) => {
                const barHeight = peak > 0 ? (bar.value / peak) * plotHeight : 0;
                return (
                  <g key={bar.label}>
                    <rect
                      className={`replay-stats-bar is-${bar.tone}`}
                      x={left + barWidth * barIndex}
                      y={16 + plotHeight - barHeight}
                      width={Math.max(1, barWidth - 2)}
                      height={Math.max(0, barHeight)}
                    >
                      <title>{`${player} ${bar.label}: ${Math.round(bar.value)}`}</title>
                    </rect>
                    {bar.value > 0 && barWidth > 22 && (
                      <text
                        className="replay-chart-label"
                        x={left + barWidth * barIndex + barWidth / 2}
                        y={16 + plotHeight - barHeight - 4}
                        textAnchor="middle"
                      >
                        {compactNumber(bar.value)}
                      </text>
                    )}
                  </g>
                );
              })}
              <text
                className="replay-chart-label"
                x={padLeft + slot * index + slot / 2}
                y={height - 18}
                textAnchor="middle"
              >
                {player.length > 12 ? `${player.slice(0, 11)}…` : player}
              </text>
            </g>
          );
        })}
      </svg>
      {groups[0] && groups[0].length > 1 && (
        <div className="replay-stats-legend">
          {groups[0].map((bar) => (
            <span key={bar.label} className={`replay-stats-key is-${bar.tone}`}>{bar.label}</span>
          ))}
        </div>
      )}
    </figure>
  );
}

export function ReplayGameStats({ stats }: { stats: ReplayPlayerStats[] }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<StatsTab>("scores");
  const players = useMemo(() => stats.map((player) => player.name), [stats]);

  if (stats.length === 0) {
    return <p className="replay-detail-empty muted">{t("replays.insights.noGameStats")}</p>;
  }

  const resource = (player: ReplayPlayerStats, key: string) =>
    player.resources.find((entry) => entry.resource === key);

  const units = (player: ReplayPlayerStats, category: string) =>
    player.units.find((entry) => entry.category === category);

  const built = t("replays.insights.built");
  const lost = t("replays.insights.lost");
  const kills = t("replays.insights.kills");
  /** A simulation field name as a word, or the field name where it is new. */
  const label = (key: string) => {
    const message = STAT_LABEL_KEYS[key];
    return message ? t(message) : key;
  };

  return (
    <div className="replay-stats">
      <SectionTabs
        active={tab}
        ariaLabel={t("replays.insights.statsTabsAria")}
        items={[
          { id: "scores", label: t("replays.insights.scores") },
          { id: "resources", label: t("replays.insights.resources") },
          { id: "units", label: t("replays.insights.units") },
          { id: "balance", label: t("replays.insights.balance") },
        ]}
        onChange={setTab}
      />

      <div className="replay-stats-grid">
        {tab === "scores" && (
          <BarChart
            title={t("replays.insights.playerScores")}
            players={players}
            groups={stats.map((player) => [
              { label: t("replays.insights.score"), value: player.score, tone: "built" as const },
            ])}
          />
        )}

        {tab === "resources" && (
          <>
            {(["mass", "energy"] as const).map((kind) => (
              <BarChart
                key={kind}
                title={t(kind === "mass" ? "replays.insights.mass" : "replays.insights.energy")}
                players={players}
                groups={stats.map((player) => [
                  {
                    label: t("replays.insights.collected"),
                    value: resource(player, `${kind}in`)?.total ?? 0,
                    tone: "built" as const,
                  },
                  {
                    label: t("replays.insights.spent"),
                    value: resource(player, `${kind}out`)?.total ?? 0,
                    tone: "lost" as const,
                  },
                  {
                    label: t("replays.insights.wasted"),
                    value: resource(player, `${kind}out`)?.excess ?? 0,
                    tone: "kills" as const,
                  },
                ])}
              />
            ))}
            {(["mass", "energy"] as const).map((kind) => (
              <BarChart
                key={`${kind}-breakdown`}
                title={t(kind === "mass"
                  ? "replays.insights.massBreakdown"
                  : "replays.insights.energyBreakdown")}
                players={players}
                groups={stats.map((player) => {
                  const income = resource(player, `${kind}in`);
                  const reclaimed = income?.reclaimed ?? 0;
                  return [
                    {
                      label: t("replays.insights.produced"),
                      value: Math.max(0, (income?.total ?? 0) - reclaimed),
                      tone: "built" as const,
                    },
                    { label: t("replays.insights.reclaimed"), value: reclaimed, tone: "extra" as const },
                  ];
                })}
              />
            ))}
          </>
        )}

        {tab === "units" && (
          <>
            {(["built", "lost", "kills"] as const).map((metric) => (
              <BarChart
                key={metric}
                title={t("replays.insights.unitsBy", {
                  metric: metric === "built" ? built : metric === "lost" ? lost : kills,
                })}
                players={players}
                groups={stats.map((player) =>
                  UNIT_CATEGORIES.filter((category) => units(player, category) !== undefined)
                    .map((category) => ({
                      label: label(category),
                      value: units(player, category)?.[metric] ?? 0,
                      tone: "extra" as const,
                    })))}
              />
            ))}
          </>
        )}

        {tab === "balance" && (
          <>
            {(["mass", "energy", "count"] as const).map((measure) => (
              <BarChart
                key={measure}
                title={t("replays.insights.buildVsLoss", { measure: label(measure) })}
                players={players}
                groups={stats.map((player) => [
                  { label: built, value: player.built[measure], tone: "built" as const },
                  { label: lost, value: player.lost[measure], tone: "lost" as const },
                  { label: kills, value: player.kills[measure], tone: "kills" as const },
                ])}
              />
            ))}
            <BarChart
              title={t("replays.insights.killDeath")}
              players={players}
              groups={stats.map((player) => [
                {
                  label: t("replays.insights.ratio"),
                  // The Python client's own guard: a player who lost nothing
                  // divides by one rather than by zero.
                  value: player.kills.count / Math.max(1, player.lost.count),
                  tone: "built" as const,
                },
              ])}
            />
          </>
        )}
      </div>
    </div>
  );
}
