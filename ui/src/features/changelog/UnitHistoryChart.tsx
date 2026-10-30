// Values over the game releases, as a step chart: a value holds from the
// release that set it until the release that changed it, so a line stays flat
// between changes and steps at them. Up to eight lines on one axis: one
// unit's values as percentages of where they started, or several units' one
// value.
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
  key: string;
  label: string;
  /** What is drawn, aligned with the chart's releases; `null` where unset. */
  values: (number | null)[];
  /** A CSS colour: a value's `--color-chart-<n>`, or a unit's faction colour. */
  color: string;
  /** An SVG dash pattern, for telling apart lines of one colour. */
  dash?: string;
  /** What the tooltip says for a release, when the drawn number is not it. */
  describe?: (index: number) => string;
}

interface Props {
  releases: ChartRelease[];
  series: ChartSeries[];
  /** A tick on the value axis, and a drawn value without `describe`. */
  format: (value: number) => string;
  /**
   * Where the value axis starts. Zero for absolute values, so 300 to 320
   * does not look like a doubling; `null` lets it fit the values, which is
   * right for percentages around 100.
   */
  floor: number | null;
  /** A line at this value, such as 100% for "where it started". */
  baseline?: number;
  /** Opens a release's patch note. */
  onOpenRelease: (id: string) => void;
}

const HEIGHT = 280;
const LEFT = 60;
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
 * The value axis: from `floor` (or the smallest value) to a little above the
 * largest, with the same room below when it fits the values. `null` with
 * nothing to draw.
 */
export function valueExtent(
  series: readonly Pick<ChartSeries, "values">[],
  floor: number | null = 0,
  baseline?: number,
): { min: number; max: number } | null {
  let min: number | null = floor;
  let max: number | null = null;
  const take = (value: number) => {
    if (min === null || value < min) min = value;
    if (max === null || value > max) max = value;
  };
  for (const one of series) for (const value of one.values) if (value !== null) take(value);
  if (max === null || min === null) return null;
  if (baseline !== undefined) take(baseline);
  let low: number = min;
  let high: number = max;
  if (high === low) {
    high = low + Math.max(1, Math.abs(low) * 0.1);
    if (floor === null) low -= Math.max(1, Math.abs(low) * 0.1);
  }
  const room = (high - low) * 0.06;
  return { min: floor === null ? low - room : low, max: high + room };
}

/** A short piece of a line, for a legend: its colour and its dash. */
export function LineSample({ color, dash }: { color: string | null; dash?: string }) {
  return (
    <svg className="unit-history-sample" width="22" height="8" aria-hidden="true">
      <line
        x1="1"
        x2="21"
        y1="4"
        y2="4"
        style={{
          stroke: color ?? "var(--color-border-strong)",
          strokeDasharray: dash || undefined,
        }}
      />
    </svg>
  );
}

export function UnitHistoryChart({ releases, series, format, floor, baseline, onOpenRelease }: Props) {
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

  const extent = valueExtent(series, floor, baseline);

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
  const onLeft = hover !== null && x(hover) > width / 2;

  return (
    <div className="unit-history-chart" ref={wrapRef}>
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
        {baseline !== undefined && (
          <line className="unit-history-baseline" x1={LEFT} x2={width - RIGHT} y1={y(baseline)} y2={y(baseline)} />
        )}
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
            key={one.key}
            className="unit-history-line"
            style={{ stroke: one.color, strokeDasharray: one.dash || undefined }}
            d={stepPath(one.values, x, y)}
          />
        ))}
        {/* A dot where a value changed, so a step is findable even when it
            is a small one. */}
        {series.map((one) =>
          one.values.map((value, index) => {
            const previous = one.values.slice(0, index).reverse().find((candidate) => candidate !== null);
            if (value === null || previous === undefined || previous === value) return null;
            return (
              <circle
                key={`${one.key}-${index}`}
                className="unit-history-change"
                style={{ fill: one.color }}
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
          className="unit-history-tooltip surface-raised"
          style={onLeft ? { right: width - x(hover) + 8 } : { left: x(hover + 1) + 8 }}
        >
          <strong>{hovered.id}</strong>
          {hovered.date && (
            <span className="muted">{formatDate(hovered.date, "", { day: "numeric", month: "short", year: "numeric" })}</span>
          )}
          {series.map((one) => {
            const value = one.values[hover] ?? null;
            return (
              <span key={one.key} className="unit-history-tooltip-row">
                <LineSample color={one.color} dash={one.dash} />
                <span className="unit-history-tooltip-label">{one.label}</span>
                <span>{one.describe ? one.describe(hover) : value === null ? "–" : format(value)}</span>
              </span>
            );
          })}
          <span className="muted">{t("changelog.units.chart.openNote")}</span>
        </div>
      )}
    </div>
  );
}
