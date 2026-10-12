// The rating page's figures, drawn here rather than borrowed.
//
// They were the wiki's pictures: an exported spreadsheet chart and three
// histograms on white, in five rainbow colours and a saturated red, and a
// stock illustration of cartoon faces. None of them took the theme, and the
// histograms each scaled their own axis, so a new account's curve (deviation
// 500) and a veteran's (57) came out the same width: the one thing the section
// is about could not be seen. Drawn from the page's own numbers, on one rating
// axis, in the client's ink, the curves show it at a glance.
//
// Each figure is an image to assistive technology, named by the alt text the
// page already had, and its caption stays the page's own sentence. Labels sit
// in the drawing at 12 units against a viewBox about as wide as the column
// draws it, so they stay at the 11 px floor down to the narrowest column.

import { formatNumber } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

type Tone = "focus" | "context";

export interface BellCurve {
  mean: number;
  deviation: number;
  /** Written over the curve, so it is told apart by name, not colour. */
  label?: string;
  /**
   * Where along the axis the label sits, over the curve there. Its peak by
   * default; a wide curve behind narrow ones takes its name out to a flank,
   * where nothing else is written.
   */
  labelAt?: number;
  tone: Tone;
}

interface Marker {
  value: number;
  label: string;
}

interface BellCurvesProps {
  curves: BellCurve[];
  /** The stretch of the rating axis drawn, and where its labels fall. */
  domain: [number, number];
  tickStep: number;
  /** Lines at a value, labelled over the plot (the mean, the listed rating). */
  markers?: Marker[];
  /** A span between two values, labelled under the curve. */
  span?: { from: number; to: number; label: string };
  ariaLabel: string;
  width?: number;
}

const HEIGHT = 190;
const PAD = { left: 10, right: 10, top: 34, bottom: 28 };

/**
 * Bell curves over one rating axis.
 *
 * Every curve peaks at the same height. What the section is about is how wide
 * a curve is, and at true density a new account's curve, nine times flatter
 * than a veteran's, all but vanished into the axis. The width is exact: each
 * curve is drawn to four deviations either side of its mean.
 */
export function BellCurves({ curves, domain, tickStep, markers = [], span, ariaLabel, width = 600 }: BellCurvesProps) {
  const [from, to] = domain;
  const plotWidth = width - PAD.left - PAD.right;
  const base = HEIGHT - PAD.bottom;
  const peak = base - PAD.top;
  const x = (value: number) => PAD.left + ((value - from) / (to - from)) * plotWidth;
  const height = (curve: BellCurve, value: number) =>
    peak * Math.exp(-0.5 * ((value - curve.mean) / curve.deviation) ** 2);
  const ticks: number[] = [];
  for (let tick = Math.ceil(from / tickStep) * tickStep; tick <= to; tick += tickStep) ticks.push(tick);

  return (
    <svg className="rating-figure-plot" viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={ariaLabel}>
      <line className="rating-figure-axis" x1={PAD.left} x2={width - PAD.right} y1={base} y2={base} />
      {ticks.map((tick) => (
        <g key={tick}>
          <line className="rating-figure-axis" x1={x(tick)} x2={x(tick)} y1={base} y2={base + 4} />
          <text className="rating-figure-tick" x={x(tick)} y={base + 18} textAnchor="middle">
            {formatNumber(tick)}
          </text>
        </g>
      ))}
      {curves.map((curve) => {
        const start = Math.max(from, curve.mean - 4 * curve.deviation);
        const end = Math.min(to, curve.mean + 4 * curve.deviation);
        const steps = 160;
        const points: string[] = [];
        for (let step = 0; step <= steps; step++) {
          const value = start + ((end - start) * step) / steps;
          points.push(`${x(value).toFixed(1)},${(base - height(curve, value)).toFixed(1)}`);
        }
        const outline = `M ${points.join(" L ")}`;
        return (
          <g key={`${curve.mean}-${curve.deviation}`} className={`rating-curve is-${curve.tone}`}>
            <path className="rating-curve-fill" d={`${outline} L ${x(end).toFixed(1)},${base} L ${x(start).toFixed(1)},${base} Z`} />
            <path className="rating-curve-line" d={outline} />
            {curve.label && (
              <text
                className={curve.tone === "context" ? "rating-figure-label is-muted" : "rating-figure-label"}
                x={x(curve.labelAt ?? curve.mean)}
                y={base - height(curve, curve.labelAt ?? curve.mean) - 10}
                textAnchor="middle"
              >
                {curve.label}
              </text>
            )}
          </g>
        );
      })}
      {markers.map((marker) => (
        <g key={marker.label} className="rating-figure-marker">
          <line x1={x(marker.value)} x2={x(marker.value)} y1={base} y2={PAD.top - 6} />
          <text className="rating-figure-label" x={x(marker.value)} y={PAD.top - 12} textAnchor="middle">
            {marker.label}
          </text>
        </g>
      ))}
      {/* Over the curve rather than across it, on the markers' line: a span
          from the bottom of a curve to its middle crosses its flank at any
          height inside it. */}
      {span && (
        <g className="rating-figure-span">
          <line x1={x(span.from)} x2={x(span.to)} y1={PAD.top - 4} y2={PAD.top - 4} />
          <text
            className="rating-figure-tick"
            x={(x(span.from) + x(span.to)) / 2}
            y={PAD.top - 12}
            textAnchor="middle"
          >
            {span.label}
          </text>
        </g>
      )}
    </svg>
  );
}

// Five teams over their last forty games, read off the wiki's chart: the
// TrueSkill mean on its own scale (25 for a newcomer), oldest game first.
// The second is the new team the caption is about.
const SETTLED_TEAMS = [
  [29.2, 29.3, 29.35, 29.4, 29.45, 29.5, 29.5, 29.55, 29.6, 29.65, 29.7, 29.45, 29.2, 29.3, 29.35, 29, 29.05, 29.35, 29.3, 29.6, 29.45, 29.6, 29.8, 29.7, 29.6, 29.75, 29.6, 29.75, 29.9, 29.8, 29.75, 29.95, 29.9, 30.1, 30.05, 30.25, 30.4, 30.4, 30.45, 30.45, 30.5],
  [27.7, 28.1, 28.4, 28.7, 28.9, 28.95, 28.95, 28.95, 28.95, 28.7, 28.5, 28.3, 28.6, 28.4, 28.2, 27.9, 27.95, 27.7, 27.8, 27.9, 27.95, 28.2, 28, 27.8, 28, 28.1, 28.25, 28.1, 28.4, 28.5, 28.4, 28.1, 28.15, 28, 28, 28, 27.85, 27.75, 27.65, 27.6, 27.8],
  [25.15, 24.9, 24.95, 24.95, 24.95, 25.4, 25.7, 26, 25.8, 26.1, 26.4, 26.75, 26.6, 26.9, 27.15, 26.9, 26.7, 26.85, 26.95, 27, 27.25, 27.05, 26.85, 27, 27.25, 27.1, 27.25, 27.1, 26.95, 26.75, 26.95, 26.8, 27, 27.2, 27.05, 27.3, 27.5, 27.65, 27.75, 27.8, 27.65],
  [20.1, 22.3, 24.7, 26.45, 26, 25.4, 25.05, 24.95, 23.95, 23.3, 22.75, 22.4, 23.3, 24, 23.65, 24.4, 25, 24.6, 25, 24.65, 24.45, 25.05, 25.65, 25.75, 25.8, 25.85, 25.3, 25.55, 25, 24.75, 25.15, 25.55, 25.3, 25.6, 26.05, 25.85, 25.65, 25.9, 26.15, 25.9, 25.85],
];
const NEW_TEAM = [15.6, 17.2, 17, 16.9, 16.85, 16.8, 18.2, 16.8, 18.3, 20.9, 20.5, 22.4, 22.2, 24.1, 25.6, 26.2, 26.6, 25.8, 26.7, 26.1, 25.8, 26.7, 27.5, 28.2, 27.8, 28.5, 29, 28.6, 29.1, 28.7, 29.1, 28.7, 28.3, 28.1, 28.5, 28.9, 29.3, 28.9, 28.7, 28.9, 28.7];

/**
 * The five teams as lines: the four settled ones receding, the new one in the
 * accent and on top of them. The y axis has no numbers on purpose. They are
 * TrueSkill's own scale, not FAF's, and the figure is about the shape: four
 * flat lines and one that climbs to meet them.
 */
export function TrajectoryChart({ ariaLabel }: { ariaLabel: string }) {
  const { t } = useTranslation();
  const width = 600;
  const height = 230;
  const pad = { left: 10, right: 10, top: 14, bottom: 30 };
  // The floor sits two points under the new team's start, room for its name
  // under the flat stretch it starts with.
  const [low, high] = [13, 31];
  const games = NEW_TEAM.length - 1;
  const x = (index: number) => pad.left + (index / games) * (width - pad.left - pad.right);
  const y = (value: number) => pad.top + ((high - value) / (high - low)) * (height - pad.top - pad.bottom);
  const line = (series: number[]) => series.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const base = height - pad.bottom;

  return (
    <svg className="rating-figure-plot" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
      {[16, 20, 24, 28].map((value) => (
        <line key={value} className="rating-figure-grid" x1={pad.left} x2={width - pad.right} y1={y(value)} y2={y(value)} />
      ))}
      <line className="rating-figure-axis" x1={pad.left} x2={width - pad.right} y1={base} y2={base} />
      {[40, 30, 20, 10, 0].map((ago) => (
        <text key={ago} className="rating-figure-tick" x={x(games - ago)} y={base + 18} textAnchor={ago === 40 ? "start" : ago === 0 ? "end" : "middle"}>
          {formatNumber(ago)}
        </text>
      ))}
      {SETTLED_TEAMS.map((series, team) => (
        <polyline key={team} className="rating-trajectory is-context" points={line(series)} />
      ))}
      <polyline className="rating-trajectory-halo" points={line(NEW_TEAM)} />
      <polyline className="rating-trajectory is-focus" points={line(NEW_TEAM)} />
      <text className="rating-figure-label is-muted" x={x(0)} y={y(30.55)}>
        {t("leaderboard.rating.figure.settledTeams")}
      </text>
      <text className="rating-figure-label is-focus" x={x(1) + 4} y={y(14.4)}>
        {t("leaderboard.rating.figure.newTeam")}
      </text>
      <text className="rating-figure-tick" x={x(games)} y={pad.top - 2} textAnchor="end">
        {t("leaderboard.rating.figure.gamesAgo")}
      </text>
    </svg>
  );
}

/** A person's shoulders, as a half ellipse from its left end. */
const shoulders = (x: number, y: number) => ["M", x, y, "a", 11, 9, 0, 0, 1, 22, 0].join(" ");

/**
 * Five players in a row, weakest to strongest, each a beta from the next: the
 * gap that makes the stronger of two an 80 percent favourite. The figure the
 * wiki drew with cartoon faces, as the plain diagram it is.
 */
export function SkillChain({ ariaLabel }: { ariaLabel: string }) {
  const { t } = useTranslation();
  const width = 600;
  const height = 132;
  const centres = [56, 178, 300, 422, 544];
  const row = 52;
  const radius = 22;

  return (
    <svg className="rating-figure-plot" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
      {centres.slice(1).map((centre, index) => {
        const left = centres[index] + radius + 8;
        const right = centre - radius - 8;
        return (
          <g key={centre} className="rating-chain-link">
            <line x1={left} x2={right} y1={row} y2={row} />
            <path d={`M ${left + 6} ${row - 4} L ${left} ${row} L ${left + 6} ${row + 4}`} />
            <path d={`M ${right - 6} ${row - 4} L ${right} ${row} L ${right - 6} ${row + 4}`} />
            <text className="rating-figure-label" x={(left + right) / 2} y={row - 10} textAnchor="middle">β</text>
            <text className="rating-figure-tick" x={(left + right) / 2} y={row + 20} textAnchor="middle">20 : 80</text>
          </g>
        );
      })}
      {centres.map((centre) => (
        <g key={centre} className="rating-chain-player">
          <circle cx={centre} cy={row} r={radius} />
          <circle className="rating-chain-glyph" cx={centre} cy={row - 6} r={6} />
          <path className="rating-chain-glyph" d={shoulders(centre - 11, row + 13)} />
        </g>
      ))}
      <text className="rating-figure-label is-muted" x={centres[0]} y={row + radius + 32} textAnchor="middle">
        {t("leaderboard.rating.figure.weakest")}
      </text>
      <text className="rating-figure-label is-muted" x={centres[centres.length - 1]} y={row + radius + 32} textAnchor="middle">
        {t("leaderboard.rating.figure.strongest")}
      </text>
    </svg>
  );
}
