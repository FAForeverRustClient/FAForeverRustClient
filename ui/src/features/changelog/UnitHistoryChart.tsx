// One value of a unit over the game releases, as a step chart: a value holds
// from the release that set it until the release that changed it, so the
// line stays flat between changes and steps at them. A second unit can be
// drawn into the same chart, on the same axis, for comparison.
//
// Releases sit at equal distances rather than by date. What a reader compares
// is "which patch changed it", and by date the busy years would crowd into a
// sliver while a quiet year took the width.

import { useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { formatDate } from "../../shared/format/dates";

export interface ChartRelease {
  id: string;
  date: string;
}

export interface ChartSeries {
  label: string;
  /** Aligned with the chart's releases; `null` where unset or unknown. */
  values: (number | null)[];
  /** The second unit, drawn dashed so it does not rely on colour alone. */
  compared?: boolean;
}

interface Props {
  releases: ChartRelease[];
  series: ChartSeries[];
  format: (value: number | null) => string;
  /** Opens a release's patch note. */
  onOpenRelease: (id: string) => void;
}

const HEIGHT = 260;
const LEFT = 56;
const RIGHT = 16;
const TOP = 16;
const BOTTOM = 30;
const FALLBACK_WIDTH = 800;

/** Round tick values over a range, about five of them. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw) ?? raw;
  const ticks: number[] = [];
  for (let tick = Math.ceil(min / step) * step; tick <= max + step * 1e-9; tick += step) {
    ticks.push(Math.round(tick * 1e6) / 1e6);
  }
  return ticks;
}

/**
 * The step line of one series as SVG path commands: a horizontal run for
 * each release, a vertical step where the value changes, and a break where
 * the value is unknown.
 */
export function stepPath(values: (number | null)[], x: (index: number) => number, y: (value: number) => number): string {
  const commands: string[] = [];
  let open = false;
  values.forEach((value, index) => {
    if (value === null) {
      open = false;
      return;
    }
    const start = x(index);
    const end = x(index + 1);
    commands.push(open ? `L${start},${y(value)}` : `M${start},${y(value)}`);
    commands.push(`L${end},${y(value)}`);
    open = true;
  });
  return commands.join("");
}

/**
 * The value axis: from zero, so a change from 300 to 320 does not look like a
 * doubling, to a little above the largest value. `null` with nothing to draw.
 */
export function valueExtent(series: readonly ChartSeries[]): { min: number; max: number } | null {
  let min = 0;
  let max: number | null = null;
  for (const one of series) {
    for (const value of one.values) {
      if (value === null) continue;
      if (value < min) min = value;
      if (max === null || value > max) max = value;
    }
  }
  if (max === null) return null;
  if (max === min) max = min + 1;
  return { min, max: max + (max - min) * 0.06 };
}

export function UnitHistoryChart({ releases, series, format, onOpenRelease }: Props) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(320, Math.floor(element.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const extent = valueExtent(series);

  if (releases.length === 0 || extent === null) {
    return <p className="unit-history-chart-empty">{t("changelog.units.chart.empty")}</p>;
  }

  const plotWidth = width - LEFT - RIGHT;
  const step = plotWidth / releases.length;
  const x = (index: number) => LEFT + index * step;
  const y = (value: number) => TOP + (HEIGHT - TOP - BOTTOM) * (1 - (value - extent.min) / (extent.max - extent.min));
  const ticks = niceTicks(extent.min, extent.max);
  // Release labels thin out to what fits: about one per 70 pixels.
  const labelEvery = Math.max(1, Math.ceil(70 / step));

  const indexAt = (event: ReactMouseEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const index = Math.floor((event.clientX - box.left - LEFT) / step);
    return index >= 0 && index < releases.length ? index : null;
  };

  const hovered = hover !== null ? releases[hover] : undefined;

  return (
    <div className="unit-history-chart" ref={wrapRef}>
      {series.length > 1 && (
        <ul className="unit-history-legend" aria-label={t("changelog.units.chart.legend")}>
          {series.map((one) => (
            <li key={one.label} className={one.compared ? "is-compared" : undefined}>
              <svg width="22" height="10" aria-hidden="true">
                <line x1="1" x2="21" y1="5" y2="5" />
              </svg>
              {one.label}
            </li>
          ))}
        </ul>
      )}
      <svg
        className="unit-history-svg"
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={series.map((one) => one.label).join(", ")}
        onMouseMove={(event) => setHover(indexAt(event))}
        onMouseLeave={() => setHover(null)}
        onClick={(event) => {
          const index = indexAt(event);
          if (index !== null) onOpenRelease(releases[index].id);
        }}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="unit-history-grid" x1={LEFT} x2={width - RIGHT} y1={y(tick)} y2={y(tick)} />
            <text className="unit-history-label" x={LEFT - 8} y={y(tick) + 4} textAnchor="end">
              {format(tick)}
            </text>
          </g>
        ))}
        <line className="unit-history-axis" x1={LEFT} x2={width - RIGHT} y1={HEIGHT - BOTTOM} y2={HEIGHT - BOTTOM} />
        {releases.map((release, index) =>
          index % labelEvery === 0 ? (
            <text key={release.id} className="unit-history-label" x={x(index) + step / 2} y={HEIGHT - 10} textAnchor="middle">
              {release.id}
            </text>
          ) : null,
        )}
        {hover !== null && (
          <rect className="unit-history-hover-band" x={x(hover)} y={TOP} width={step} height={HEIGHT - TOP - BOTTOM} />
        )}
        {series.map((one) => (
          <path
            key={one.label}
            className={`unit-history-line${one.compared ? " is-compared" : ""}`}
            d={stepPath(one.values, x, y)}
          />
        ))}
        {/* A dot where the value changed, so a step is findable even when it
            is a small one. */}
        {series.map((one) =>
          one.values.map((value, index) => {
            const previous = one.values.slice(0, index).reverse().find((candidate) => candidate !== null);
            if (value === null || previous === undefined || previous === value) return null;
            return (
              <circle
                key={`${one.label}-${index}`}
                className={`unit-history-change${one.compared ? " is-compared" : ""}`}
                cx={x(index)}
                cy={y(value)}
                r={4}
              />
            );
          }),
        )}
      </svg>
      {hovered && hover !== null && (
        <div
          className={`unit-history-tooltip surface-raised${x(hover) > width / 2 ? " is-left" : ""}`}
          style={x(hover) > width / 2 ? { right: width - x(hover) + 8 } : { left: x(hover + 1) + 8 }}
        >
          <strong>{hovered.id}</strong>
          {hovered.date && <span className="muted">{formatDate(hovered.date, "", { day: "numeric", month: "short", year: "numeric" })}</span>}
          {series.map((one) => (
            <span key={one.label} className="unit-history-tooltip-row">
              {series.length > 1 && <span className="muted">{one.label}</span>}
              <span>{format(one.values[hover] ?? null)}</span>
            </span>
          ))}
          <span className="muted">{t("changelog.units.chart.openNote")}</span>
        </div>
      )}
    </div>
  );
}
