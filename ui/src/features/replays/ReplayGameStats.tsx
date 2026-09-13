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
import { ReplayChartFrame } from "./ReplayChartFrame";
import {
  compactNumber,
  STAT_LABEL_KEYS,
  UNIT_CATEGORIES,
  UNIT_CATEGORY_TOKENS,
} from "./replayAnalysis";

type StatsTab = "scores" | "resources" | "units" | "balance";

/** One bar in a group, and what it is called. */
interface Bar {
  label: string;
  value: number;
  tone: "built" | "lost" | "kills" | "extra";
  /**
   * A design token to draw this bar in, where the tone is not enough.
   *
   * The units tab puts a bar per category in every group, and "extra" twelve
   * times over is one colour for twelve different things.
   */
  token?: string;
}

/**
 * The drawing area, in the SVG's own units.
 *
 * The box scales to whatever the panel gives it, so these are proportions
 * rather than pixels: what matters is that a label written at 13 of them is
 * readable once the chart is the width of the dialog. It used to be laid out
 * two charts to a row, which left each one about four hundred pixels wide and
 * every number on it under five -- so the panel is one column now and each
 * chart has the whole of it.
 */
const WIDTH = 1000;
const HEIGHT = 300;
/** Room for the value axis on the left and the player names underneath. */
const PAD_LEFT = 64;
const PAD_BOTTOM = 38;
const PAD_TOP = 18;
/**
 * How wide one bar may get.
 *
 * A chart with one bar per player divided the whole slot between them, which
 * on a four-player game is a bar two hundred units across: a block, not a
 * measurement. Groups narrower than their slot are centred in it.
 */
const MAX_BAR_WIDTH = 46;
/**
 * How much of the chart one player's group may take.
 *
 * Without a ceiling a two-player game gave each group half the chart, and
 * capped bars then floated as two small islands in all that space. The band
 * of groups is centred instead, which keeps the bars beside each other where
 * they can be compared.
 */
const MAX_SLOT_WIDTH = 210;

/**
 * A value on the axis.
 *
 * Used for the axis and for the number over a bar, so the two agree.
 * `compactNumber` rounds, which is right for a mass total and wrong for a
 * chart whose peak is a ratio: four gridlines between 0 and 2.5 came out as
 * 0, 1, 1, 2, and a bar standing at 1.3 was labelled 1.
 */
function axisLabel(value: number, peak: number): string {
  return peak < 10 ? value.toFixed(1) : compactNumber(value);
}

/** One chart: a title, and a group of bars per player. */
function BarChart({
  title,
  players,
  groups,
  zoomed,
  onZoom,
}: {
  title: string;
  players: string[];
  groups: Bar[][];
  zoomed: boolean;
  onZoom: (zoomed: boolean) => void;
}) {
  const peak = groups.reduce(
    (most, bars) => bars.reduce((inner, bar) => Math.max(inner, bar.value), most),
    0,
  );
  const plotHeight = HEIGHT - PAD_BOTTOM - PAD_TOP;
  const plotWidth = WIDTH - PAD_LEFT;
  const slot = Math.min(MAX_SLOT_WIDTH, plotWidth / Math.max(1, players.length));
  // The band of groups, centred in whatever the slots do not use.
  const bandLeft = PAD_LEFT + (plotWidth - slot * players.length) / 2;
  const barCount = Math.max(1, groups[0]?.length ?? 1);
  const barWidth = Math.min(MAX_BAR_WIDTH, (slot * 0.8) / barCount);
  const groupWidth = barWidth * barCount;
  const baseline = PAD_TOP + plotHeight;
  const yOf = (value: number) => baseline - (peak > 0 ? (value / peak) * plotHeight : 0);
  // Four gridlines with their values written on them: without a scale the
  // only number on the chart was the one printed over a bar, and that one
  // vanished as soon as the bars were narrow.
  const gridValues = [0, 0.25, 0.5, 0.75, 1].map((share) => peak * share);
  const key = groups[0] && groups[0].length > 1 ? groups[0] : null;

  return (
    <ReplayChartFrame
      title={title}
      zoomed={zoomed}
      onZoom={onZoom}
      legend={key && (
        <div className="replay-stats-legend">
          {key.map((bar) => (
            <span
              key={bar.label}
              className={`replay-stats-key is-${bar.tone}`}
              style={bar.token ? { ["--replay-stats-key-color" as string]: `var(${bar.token})` } : undefined}
            >
              {bar.label}
            </span>
          ))}
        </div>
      )}
    >
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={title}>
        {gridValues.map((value, index) => (
          <g key={index}>
            <line
              className="replay-chart-grid"
              x1={PAD_LEFT}
              x2={WIDTH}
              y1={yOf(value)}
              y2={yOf(value)}
            />
            <text
              className="replay-chart-label"
              x={PAD_LEFT - 8}
              y={yOf(value) + 5}
              textAnchor="end"
            >
              {axisLabel(value, peak)}
            </text>
          </g>
        ))}
        {players.map((player, index) => {
          const bars = groups[index] ?? [];
          const left = bandLeft + slot * index + (slot - groupWidth) / 2;
          return (
            <g key={`${player}-${index}`}>
              {bars.map((bar, barIndex) => {
                const top = yOf(bar.value);
                return (
                  <g key={bar.label}>
                    <rect
                      className={`replay-stats-bar is-${bar.tone}`}
                      style={bar.token ? { fill: `var(${bar.token})` } : undefined}
                      x={left + barWidth * barIndex}
                      y={top}
                      width={Math.max(1, barWidth - 2)}
                      height={Math.max(0, baseline - top)}
                    >
                      <title>{`${player} ${bar.label}: ${Math.round(bar.value)}`}</title>
                    </rect>
                    {bar.value > 0 && barWidth > 26 && (
                      <text
                        className="replay-chart-label"
                        x={left + barWidth * barIndex + barWidth / 2}
                        y={top - 5}
                        textAnchor="middle"
                      >
                        {axisLabel(bar.value, peak)}
                      </text>
                    )}
                  </g>
                );
              })}
              <text
                className="replay-chart-label is-axis"
                x={bandLeft + slot * index + slot / 2}
                y={HEIGHT - 14}
                textAnchor="middle"
              >
                {player.length > 14 ? `${player.slice(0, 13)}…` : player}
              </text>
            </g>
          );
        })}
      </svg>
    </ReplayChartFrame>
  );
}

export function ReplayGameStats({ stats }: { stats: ReplayPlayerStats[] }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<StatsTab>("scores");
  // Which chart, if any, has the viewport. One name for the whole tab rather
  // than a flag per chart: only one can be open at a time, and a chart that
  // scrolls out of the tab must not leave a stale `true` behind it.
  const [zoomed, setZoomed] = useState<string | null>(null);
  const players = useMemo(() => stats.map((player) => player.name), [stats]);
  const zoom = (chart: string) => ({
    zoomed: zoomed === chart,
    onZoom: (open: boolean) => setZoomed(open ? chart : null),
  });

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
            {...zoom("scores")}
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
                {...zoom(`resource-${kind}`)}
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
                {...zoom(`breakdown-${kind}`)}
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
                {...zoom(`units-${metric}`)}
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
                      // A colour per category, so a group of twelve bars can
                      // be read against the key rather than counted from the
                      // left.
                      token: UNIT_CATEGORY_TOKENS[category],
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
                {...zoom(`balance-${measure}`)}
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
              {...zoom("kd")}
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
