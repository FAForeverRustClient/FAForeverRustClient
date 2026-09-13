// Actions per minute over the length of a game, and what the players were
// doing at any point on it.
//
// The Python client's "Graph" tab (`charttab.py` in FAForever/client): one line
// per player, a rolling minute wide, with the orders inside the window the
// pointer is over listed underneath. Its version draws each order as the icon
// of the unit it built; this names them, because those icons are the game's own
// art and this client does not ship it.

import { useMemo, useRef, useState } from "react";
import type { ReplayAnalysis, ReplayOrder } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import {
  ACTIVITY_WINDOW_TICKS,
  analysedPlayers,
  commandName,
  formatGameTime,
  ordersInWindow,
  peakOf,
  rollingActions,
} from "./replayAnalysis";

/** The drawing area, in the SVG's own units. The box scales to the panel. */
const CHART_WIDTH = 1000;
const CHART_HEIGHT = 240;
/** Room for the axis labels along the left edge and the bottom. */
const PAD_LEFT = 44;
const PAD_BOTTOM = 22;
const PAD_TOP = 8;

/**
 * How many ticks one drawn point covers.
 *
 * A long game is fifty thousand ticks and the chart is a thousand units wide,
 * so drawing every tick would put fifty of them on one pixel. The line is
 * sampled instead, at whatever step keeps it under a point per unit.
 */
function sampleStep(ticks: number): number {
  return Math.max(1, Math.ceil(ticks / CHART_WIDTH));
}

export function ReplayActivityChart({ analysis }: { analysis: ReplayAnalysis }) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverTick, setHoverTick] = useState<number | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set());

  const players = useMemo(() => analysedPlayers(analysis), [analysis]);
  const series = useMemo(() => {
    const byPlayer = new Map<number, Uint16Array>();
    for (const entry of analysis.activity) {
      byPlayer.set(entry.source, rollingActions(entry.commandTicks, analysis.ticks));
    }
    return byPlayer;
  }, [analysis.activity, analysis.ticks]);
  const peak = useMemo(() => peakOf(series.values()), [series]);

  const step = sampleStep(analysis.ticks);
  const plotWidth = CHART_WIDTH - PAD_LEFT;
  const plotHeight = CHART_HEIGHT - PAD_BOTTOM - PAD_TOP;
  const xOf = (tick: number) => PAD_LEFT + (tick / Math.max(1, analysis.ticks)) * plotWidth;
  const yOf = (value: number) => PAD_TOP + plotHeight - (value / Math.max(1, peak)) * plotHeight;

  const paths = useMemo(() => {
    const built: Array<{ source: number; color: string; d: string }> = [];
    for (const player of players) {
      const values = series.get(player.source);
      if (!values || hidden.has(player.source)) continue;
      let d = "";
      for (let tick = 0; tick < values.length; tick += step) {
        d += `${d ? "L" : "M"}${xOf(tick).toFixed(1)} ${yOf(values[tick]).toFixed(1)}`;
      }
      if (d) built.push({ source: player.source, color: player.color, d });
    }
    return built;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, series, hidden, step, peak, analysis.ticks]);

  const windowOrders = useMemo(
    () => (hoverTick === null
      ? new Map<number, ReplayOrder[]>()
      : ordersInWindow(analysis.orders, hoverTick)),
    [analysis.orders, hoverTick],
  );

  const trackTick = (clientX: number) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const atUnit = ((clientX - box.left) / box.width) * CHART_WIDTH;
    const ratio = (atUnit - PAD_LEFT) / plotWidth;
    const tick = Math.round(ratio * analysis.ticks);
    setHoverTick(Math.min(Math.max(tick, 0), Math.max(0, analysis.ticks - 1)));
  };

  if (peak === 0) {
    return <p className="replay-detail-empty muted">{t("replays.insights.noActivity")}</p>;
  }

  // Four gridlines, at values a reader can hold in their head.
  const gridValues = [0, 0.25, 0.5, 0.75, 1].map((share) => Math.round(peak * share));

  return (
    <div className="replay-activity-chart">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="replay-chart-surface"
        role="img"
        aria-label={t("replays.insights.graphAria")}
        onMouseMove={(event) => trackTick(event.clientX)}
        onMouseLeave={() => setHoverTick(null)}
      >
        {gridValues.map((value) => (
          <g key={value}>
            <line
              className="replay-chart-grid"
              x1={PAD_LEFT}
              x2={CHART_WIDTH}
              y1={yOf(value)}
              y2={yOf(value)}
            />
            <text className="replay-chart-label" x={PAD_LEFT - 6} y={yOf(value) + 4} textAnchor="end">
              {value}
            </text>
          </g>
        ))}
        {/* One label every quarter of the game, which is as many as fit. */}
        {[0, 0.25, 0.5, 0.75, 1].map((share) => {
          const tick = Math.round(analysis.ticks * share);
          return (
            <text
              key={share}
              className="replay-chart-label"
              x={xOf(tick)}
              y={CHART_HEIGHT - 6}
              textAnchor={share === 0 ? "start" : share === 1 ? "end" : "middle"}
            >
              {formatGameTime(tick)}
            </text>
          );
        })}
        {paths.map((path) => (
          <path key={path.source} className="replay-chart-line" d={path.d} stroke={path.color} />
        ))}
        {hoverTick !== null && (
          <line
            className="replay-chart-cursor"
            x1={xOf(hoverTick)}
            x2={xOf(hoverTick)}
            y1={PAD_TOP}
            y2={PAD_TOP + plotHeight}
          />
        )}
      </svg>

      <div className="replay-chart-legend">
        {players.map((player) => (
          <button
            key={`${player.source}-${player.name}`}
            type="button"
            className={hidden.has(player.source)
              ? "replay-chart-legend-item is-off"
              : "replay-chart-legend-item"}
            aria-pressed={!hidden.has(player.source)}
            onClick={() => setHidden((current) => {
              const next = new Set(current);
              if (next.has(player.source)) next.delete(player.source);
              else next.add(player.source);
              return next;
            })}
          >
            <span className="replay-activity-swatch" style={{ background: player.color }} aria-hidden />
            <span>{player.name}</span>
          </button>
        ))}
      </div>

      {/* What the minute under the pointer was made of. The Python client shows
          the same read-out, as a wall of unit icons. */}
      <div className="replay-chart-readout">
        {hoverTick === null ? (
          <p className="muted">{t("replays.insights.graphHint")}</p>
        ) : (
          <>
            <h4>
              {t("replays.insights.window", {
                from: formatGameTime(hoverTick),
                to: formatGameTime(Math.min(hoverTick + ACTIVITY_WINDOW_TICKS, analysis.ticks)),
              })}
            </h4>
            <div className="replay-chart-readout-players">
              {players.map((player) => {
                if (hidden.has(player.source)) return null;
                const orders = windowOrders.get(player.source) ?? [];
                const counted = new Map<string, number>();
                for (const order of orders) {
                  const label = order.blueprint || commandName(order.command);
                  counted.set(label, (counted.get(label) ?? 0) + 1);
                }
                return (
                  <div key={`${player.source}-${player.name}`} className="replay-chart-readout-player">
                    <strong style={{ color: player.color }}>{player.name}</strong>
                    <span className="muted">
                      {t("replays.insights.actionCount", { count: orders.length })}
                    </span>
                    <ul>
                      {[...counted.entries()]
                        .sort((left, right) => right[1] - left[1])
                        .slice(0, 12)
                        .map(([label, count]) => (
                          <li key={label} className="surface-chip">
                            {label}
                            {count > 1 && <span className="muted"> x{count}</span>}
                          </li>
                        ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
