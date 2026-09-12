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

import { t } from "../../i18n";
import { catColor, mmss, type Lane } from "./recording";

const ROW_H = 36;
const LABEL_W = 108;
const NODE_R = 5;
const TOP = 18;
/** Room for the last bar's rounded end. */
const PAD_R = 20;

interface Props {
  lanes: Lane[];
  durationMs: number;
  hovered: string | null;
  onHover: (id: string | null) => void;
}

export function BuildFlow({ lanes, durationMs, hovered, onHover }: Props) {
  // Scaled by duration rather than fitted to the container: a ten-minute run
  // squeezed into the width of a two-minute one makes the early game, which is
  // the part that matters, unreadable. The container scrolls instead.
  const plotW = Math.max(560, (durationMs / 60_000) * 260);
  const width = LABEL_W + plotW + PAD_R;
  const height = lanes.length * ROW_H + TOP + 6;

  const x = (t: number) => LABEL_W + (t / durationMs) * plotW;
  const midOf = (row: number) => TOP + row * ROW_H + ROW_H / 2;

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
                y={TOP + row * ROW_H}
                width={width}
                height={ROW_H}
                fill="transparent"
                style={{ cursor: "pointer" }}
              />
              <text x={LABEL_W - 8} y={mid + 3} className="training-flow-label" textAnchor="end">
                {lane.name}
              </text>
              <line
                x1={LABEL_W}
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
                      {`${bar.name} · ${mmss(bar.start)}${
                        bar.end === null ? "" : ` to ${mmss(bar.end)}`
                      }`}
                    </title>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
