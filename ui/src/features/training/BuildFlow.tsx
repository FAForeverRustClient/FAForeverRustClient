// The recorded build order as a lane per producer: each thing a unit built is a
// node on that unit's line, with a bar trailing it for as long as the build
// took. Read left to right in game time.
//
// Ported from the BO recorder's own analyser. Two decisions carried over
// because they are the reason it works:
//
// Node positions are true to time rather than evenly spaced. Even spacing reads
// more cleanly and would be wrong: this is a tool for judging *timings*, so two
// nodes crowding each other means those two things really did happen within a
// few seconds of each other, and that is information, not a layout defect.
//
// It is inline SVG rather than an image, because hovering a lane drives state
// the map beside it also reads. Pointing at an engineer here lights up the
// route it drove over there, which is the whole reason the two panes sit side
// by side.

import { useTranslation } from "../../i18n/useTranslation";
import { CAT_COLOR, catColor, ellipsize, mmss, type Lane, type Stalls } from "./recording";

const ROW_H = 36;
const NODE_R = 5;
const TOP = 18;
/** Room for the last bar's rounded end. */
const PAD_R = 20;
/**
 * The label gutter grows with the longest lane name, between these two.
 *
 * Fixed at the narrow end it cut long unit names off at the chart's left
 * edge; unbounded it would let one experimental's name push the chart away.
 * Past the wide end a label is shortened and keeps its full name as a tooltip.
 */
const LABEL_MIN_W = 108;
const LABEL_MAX_W = 200;
/** A generous average glyph width for the 11px label font, in pixels. */
const CHAR_W = 6.6;
/** Gap between a label's end and the rail. */
const LABEL_GAP = 8;
/** Height of one stall strip above the lanes. */
const STRIP_H = 5;

/** Stalls are painted in the colour of what ran out: the mex and power colours. */
const STALL_COLOR = { mass: CAT_COLOR.mex, energy: CAT_COLOR.power } as const;

interface Props {
  lanes: Lane[];
  durationMs: number;
  hovered: string | null;
  onHover: (id: string | null) => void;
  /** Where mass or energy storage sat empty, when the run recorded storage. */
  stalls?: Stalls;
}

export function BuildFlow({ lanes, durationMs, hovered, onHover, stalls }: Props) {
  const { t } = useTranslation();
  const longest = lanes.reduce((max, lane) => Math.max(max, lane.name.length), 0);
  const labelW = Math.min(
    LABEL_MAX_W,
    Math.max(LABEL_MIN_W, Math.ceil(longest * CHAR_W) + LABEL_GAP + 4),
  );
  const labelChars = Math.floor((labelW - LABEL_GAP - 4) / CHAR_W);

  const stallKinds = (["mass", "energy"] as const).filter(
    (kind) => (stalls?.[kind].length ?? 0) > 0,
  );
  // The strips get a row of their own above the lanes: under them, every
  // lane's hover band would swallow the strip's tooltip.
  const stripsH = stallKinds.length > 0 ? stallKinds.length * (STRIP_H + 1) + 3 : 0;
  const lanesTop = TOP + stripsH;

  // Scaled by duration rather than fitted to the container: a ten-minute run
  // squeezed into the width of a two-minute one makes the early game, which is
  // the part that matters, unreadable. The container scrolls instead.
  const plotW = Math.max(560, (durationMs / 60_000) * 260);
  const width = labelW + plotW + PAD_R;
  const height = lanes.length * ROW_H + lanesTop + 6;

  const x = (t: number) => labelW + (t / durationMs) * plotW;
  const midOf = (row: number) => lanesTop + row * ROW_H + ROW_H / 2;

  const ticks: number[] = [];
  for (let t = 0; t <= durationMs; t += 60_000) ticks.push(t);

  // Producer to child, so a lane can be joined to the node that started it.
  // `childId` is the produced unit's entity id, which is also what its own lane
  // hovers on, so pointing at a node and pointing at its lane light the same
  // branch.
  const rowOf = new Map(lanes.map((lane, i) => [lane.id, i]));
  const branches = lanes.flatMap((lane, row) =>
    lane.bars.flatMap((bar) => {
      const childRow = rowOf.get(bar.entityId);
      if (childRow === undefined) return [];
      return [
        {
          childId: bar.entityId,
          bx: x(bar.start),
          mid: midOf(row),
          childMid: midOf(childRow),
          color: catColor(bar.cat),
        },
      ];
    }),
  );

  return (
    <div className="training-flow">
      <svg width={width} height={height} role="img" aria-label={t("training.build.chartLabel")}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={x(tick)} y1={TOP - 4} x2={x(tick)} y2={height} className="training-flow-grid" />
            <text x={x(tick)} y={TOP - 8} className="training-flow-tick" textAnchor="middle">
              {mmss(tick)}
            </text>
          </g>
        ))}

        {/* Stalls first, so everything else draws over them. A faint band down
            the whole chart says which builds were starved, and a solid strip
            above the lanes carries the tooltip. */}
        {stallKinds.map((kind, strip) =>
          (stalls?.[kind] ?? []).map((span, i) => {
            const x0 = x(span.from);
            const w = Math.max(2, x(span.to) - x0);
            const label = t(
              kind === "mass" ? "training.build.stallMassSpan" : "training.build.stallEnergySpan",
              { from: mmss(span.from), to: mmss(span.to) },
            );
            return (
              <g key={`stall-${kind}-${i}`}>
                <rect
                  x={x0}
                  y={lanesTop}
                  width={w}
                  height={height - lanesTop}
                  fill={STALL_COLOR[kind]}
                  opacity={0.08}
                  style={{ pointerEvents: "none" }}
                />
                <rect
                  x={x0}
                  y={TOP + strip * (STRIP_H + 1)}
                  width={w}
                  height={STRIP_H}
                  rx={1}
                  fill={STALL_COLOR[kind]}
                  opacity={0.8}
                >
                  <title>{label}</title>
                </rect>
              </g>
            );
          }),
        )}

        {/* Under the lanes, so a highlighted branch stays bright while its
            producer's row dims. */}
        {branches.map((b, i) => {
          const hot = hovered === b.childId;
          return (
            <path
              key={`branch-${i}`}
              d={`M ${b.bx} ${b.mid} V ${b.childMid}`}
              fill="none"
              stroke={b.color}
              strokeWidth={hot ? 2 : 1}
              opacity={hovered !== null && !hot ? 0.12 : 0.45}
            />
          );
        })}

        {lanes.map((lane, row) => {
          const mid = midOf(row);
          const hot = hovered === lane.id;
          const dimmed = hovered !== null && !hot;
          return (
            <g
              key={lane.id}
              opacity={dimmed ? 0.3 : 1}
              onMouseEnter={() => onHover(lane.id)}
              onMouseLeave={() => onHover(null)}
            >
              {/* A row-wide transparent band, so the lane is hoverable
                  everywhere rather than only on its marks. */}
              <rect
                x={0}
                y={lanesTop + row * ROW_H}
                width={width}
                height={ROW_H}
                fill="transparent"
                style={{ cursor: "pointer" }}
              />
              <text
                x={labelW - LABEL_GAP}
                y={mid + 3}
                className="training-flow-label"
                textAnchor="end"
              >
                {ellipsize(lane.name, labelChars)}
                <title>{lane.name}</title>
              </text>
              <line
                x1={labelW}
                y1={mid}
                x2={width - PAD_R}
                y2={mid}
                className="training-flow-rail"
              />

              {lane.bars.map((bar) => {
                const start = x(bar.start);
                // A build still unfinished when the recording stopped runs to
                // the end rather than vanishing: it happened, it just did not
                // finish inside the run.
                const end = x(bar.end ?? durationMs);
                return (
                  <g key={bar.key}>
                    <rect
                      x={start}
                      y={mid - 3}
                      width={Math.max(2, end - start)}
                      height={6}
                      rx={3}
                      fill={catColor(bar.cat)}
                      opacity={bar.end === null ? 0.45 : 0.75}
                    />
                    <circle cx={start} cy={mid} r={NODE_R} fill={catColor(bar.cat)} />
                    <title>
                      {bar.end === null
                        ? `${bar.name} · ${mmss(bar.start)}`
                        : t("training.build.barSpan", {
                            name: bar.name,
                            from: mmss(bar.start),
                            to: mmss(bar.end),
                          })}
                    </title>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      {stallKinds.length > 0 && (
        <div className="training-flow-legend">
          {stallKinds.map((kind) => (
            <span key={kind}>
              <span className="training-run-swatch" style={{ background: STALL_COLOR[kind] }} />
              {t(kind === "mass" ? "training.build.stallMass" : "training.build.stallEnergy")}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
