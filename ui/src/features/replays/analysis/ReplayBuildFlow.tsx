// One player's build order as lanes, drawn the way the maintainer's own build
// order analyser draws one (bo-sheppy, `BoFlow.tsx`): a lane per unit that
// built something, a node with the built unit's icon where each build began,
// a bar for as long as it took, a label under the node where it fits, and a
// branch from a build down to the lane of the builder it became. Node
// positions are true to time: two nodes crowding each other means the two
// builds really were seconds apart.
//
// What is reconstructed rather than read is `buildFlow.ts`'s to say; the pane
// above says it to the player. Hovering a lane or a node lights up that
// builder and its branch.

import { useMemo, useState } from "react";
import type { UnitSummary } from "../../../ipc/bindings";
import type { UnitIcons } from "../../../ipc/native";
import { useTranslation } from "../../../i18n/useTranslation";
import { enhancementWords, isEnhancementRemoval } from "./buildOrder";
import { formatGameTime, TICKS_PER_SECOND } from "./replayAnalysis";
import type { FlowCategory, FlowLane, FlowNode } from "./buildFlow";

const ROW_H = 54;
const TOP = 22;
const LABEL_W = 96;
const R = 15;
const ICON = 20;
const PAD_R = 24;
const CHAR_W = 6;
const LABEL_MAX = 96;

const categoryColor = (category: FlowCategory) => `var(--color-bo-${category})`;

type Translate = ReturnType<typeof useTranslation>["t"];

export function ReplayBuildFlow({
  lanes,
  span,
  window,
  width,
  catalogue,
  icons,
}: {
  lanes: FlowLane[];
  /** The ticks the drawing covers. */
  span: number;
  /** The ticks the visible width shows; the rest scrolls. */
  window: number;
  /** The visible width in pixels. */
  width: number;
  catalogue: ReadonlyMap<string, UnitSummary>;
  icons: UnitIcons | null;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<number | null>(null);

  const plotVisible = Math.max(200, width - LABEL_W - PAD_R);
  const perTick = plotVisible / window;
  const plotW = Math.max(plotVisible, span * perTick);
  const svgW = LABEL_W + plotW + PAD_R;
  const svgH = lanes.length * ROW_H + TOP;
  const x = (tick: number) => LABEL_W + tick * perTick;

  // A line every 30 seconds up to ten minutes in view, coarser past that, so
  // the labels never crowd.
  const step = (window <= 10 * 60 * TICKS_PER_SECOND ? 30 : window <= 30 * 60 * TICKS_PER_SECOND ? 60 : 300) * TICKS_PER_SECOND;
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let tick = 0; tick <= span; tick += step) out.push(tick);
    return out;
  }, [span, step]);

  const rowOf = new Map(lanes.map((lane, row) => [lane.id, row]));
  const mid = (row: number) => TOP + row * ROW_H + ROW_H / 2;
  const branches = lanes.flatMap((lane, row) =>
    lane.nodes.flatMap((node) => {
      const childRow = node.child === null ? undefined : rowOf.get(node.child);
      if (childRow === undefined || node.child === null) return [];
      const childStart = lanes[childRow].nodes[0]?.start ?? node.start;
      return [{ child: node.child, bx: x(node.start), mid: mid(row), childMid: mid(childRow), childX: x(childStart), color: categoryColor(node.category) }];
    }),
  );

  return (
    <div className="replay-build-flow">
      <svg width={svgW} height={svgH} role="img" aria-label={t("replays.buildOrder.flowAria")}>
        <defs>
          <pattern id="replay-build-flow-cancelled" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="3" height="6" className="replay-build-flow-hatch" />
          </pattern>
        </defs>

        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={x(tick)} y1={16} x2={x(tick)} y2={svgH} className="replay-build-flow-grid" />
            <text x={x(tick)} y={11} textAnchor="middle" className="replay-build-flow-time">
              {formatGameTime(tick)}
            </text>
          </g>
        ))}

        {/* Branches under the lanes, so a highlighted one stays bright while
            its producer's row dims. */}
        {branches.map((branch, index) => {
          const hot = hovered === branch.child;
          const dim = hovered !== null && !hot;
          return (
            <path
              key={`branch-${index}`}
              d={`M ${branch.bx} ${branch.mid} V ${branch.childMid} H ${branch.childX}`}
              stroke={branch.color}
              strokeWidth={hot ? 2.5 : 1.5}
              fill="none"
              opacity={dim ? 0.16 : hot ? 1 : 0.5}
            />
          );
        })}

        {lanes.map((lane, row) => {
          const y = TOP + row * ROW_H;
          const middle = y + ROW_H / 2;
          const isHot = hovered === lane.id;
          const color = categoryColor(lane.category);
          const lastEnd = Math.max(...lane.nodes.map((node) => node.end ?? node.start));
          return (
            <g
              key={lane.id}
              onMouseEnter={() => setHovered(lane.id)}
              onMouseLeave={() => setHovered(null)}
              opacity={hovered !== null && !isHot ? 0.42 : 1}
              className="replay-build-flow-lane"
            >
              <rect x={0} y={y} width={svgW} height={ROW_H} className={isHot ? "replay-build-flow-row is-hot" : row % 2 ? "replay-build-flow-row is-odd" : "replay-build-flow-row"} />
              <line x1={0} y1={y + ROW_H} x2={svgW} y2={y + ROW_H} className="replay-build-flow-grid" />
              {lane.nodes.length > 0 && (
                <line x1={x(lane.nodes[0].start)} y1={middle} x2={x(lastEnd)} y2={middle} className="replay-build-flow-spine" />
              )}
              {lane.nodes.map((node, index) => (
                <FlowNodeMark
                  key={node.key}
                  node={node}
                  next={lane.nodes[index + 1] ?? null}
                  x={x}
                  middle={middle}
                  catalogue={catalogue}
                  icons={icons}
                  onHover={(child) => setHovered(child ?? lane.id)}
                  t={t}
                />
              ))}
              {/* The label gutter last, so it stays over nodes scrolled under it. */}
              <rect x={0} y={y} width={LABEL_W} height={ROW_H} className="replay-build-flow-gutter" />
              <line x1={LABEL_W} y1={y} x2={LABEL_W} y2={y + ROW_H} stroke={color} strokeWidth={2} />
              <text x={LABEL_W - 8} y={middle} textAnchor="end" dominantBaseline="middle" className={isHot ? "replay-build-flow-lane-name is-hot" : "replay-build-flow-lane-name"}>
                {laneName(lane, t)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function laneName(lane: FlowLane, t: Translate): string {
  switch (lane.kind) {
    case "acu":
      return t("replays.buildOrder.lane.acu");
    case "engineer":
      return t("replays.buildOrder.lane.engineer", { index: lane.index });
    case "upgrades":
      return t("replays.buildOrder.lane.upgrades");
    default:
      return t(
        lane.layer === "air"
          ? "replays.buildOrder.lane.airFactory"
          : lane.layer === "naval"
            ? "replays.buildOrder.lane.navalFactory"
            : "replays.buildOrder.lane.landFactory",
        { index: lane.index },
      );
  }
}

function nodeName(node: FlowNode, catalogue: ReadonlyMap<string, UnitSummary>, t: Translate): string {
  if (node.enhancement) {
    return t(isEnhancementRemoval(node.enhancement) ? "replays.buildOrder.enhancementRemoved" : "replays.buildOrder.enhancement", {
      name: enhancementWords(node.enhancement),
    });
  }
  const unit = node.unit ? catalogue.get(node.unit) : undefined;
  if (!unit) return node.unit ?? "";
  if (unit.name) return unit.name;
  if (unit.description) return unit.tech && unit.tech > 1 && unit.tech < 4 ? `${unit.description} (T${unit.tech})` : unit.description;
  return unit.id;
}

function FlowNodeMark({
  node,
  next,
  x,
  middle,
  catalogue,
  icons,
  onHover,
  t,
}: {
  node: FlowNode;
  next: FlowNode | null;
  x: (tick: number) => number;
  middle: number;
  catalogue: ReadonlyMap<string, UnitSummary>;
  icons: UnitIcons | null;
  onHover: (child: number | null) => void;
  t: Translate;
}) {
  const name = nodeName(node, catalogue, t);
  const bx = x(node.start);
  const end = node.end ?? node.start;
  const bw = Math.max(x(end) - bx, 2);
  const color = categoryColor(node.category);
  const icon = node.unit ? icons?.units[node.unit] : undefined;
  // A label is centred on its node, so it may take the distance to the next
  // one: three power generators a few seconds apart would otherwise smear.
  const room = next ? x(next.start) - bx : LABEL_MAX;
  const fits = Math.floor((Math.min(room, LABEL_MAX) - 6) / CHAR_W);
  const label = fits >= 5 ? (name.length > fits ? `${name.slice(0, fits - 1)}…` : name) : null;
  const title = node.cancelled
    ? t("replays.buildOrder.nodeCancelled", { name, time: formatGameTime(node.ordered) })
    : node.end === null
      ? t("replays.buildOrder.nodeAt", { name, time: formatGameTime(node.start) })
      : t("replays.buildOrder.nodeSpan", { name, start: formatGameTime(node.start), end: formatGameTime(end) });

  return (
    <g
      onMouseEnter={node.child !== null ? () => onHover(node.child) : undefined}
      onMouseLeave={node.child !== null ? () => onHover(null) : undefined}
      opacity={node.cancelled ? 0.55 : 1}
    >
      <title>{title}</title>
      <rect x={bx} y={middle - 4} width={bw} height={8} rx={4} fill={color} opacity={0.55} />
      {node.cancelled && <rect x={bx} y={middle - 4} width={Math.max(bw, 12)} height={8} rx={4} fill="url(#replay-build-flow-cancelled)" />}
      <circle cx={bx} cy={middle} r={R} className="replay-build-flow-node" stroke={color} strokeWidth={1.5} />
      {icon ? (
        <image href={icon} x={bx - ICON / 2} y={middle - ICON / 2} width={ICON} height={ICON} preserveAspectRatio="xMidYMid meet" />
      ) : (
        <text x={bx} y={middle} fill={color} textAnchor="middle" dominantBaseline="middle" className="replay-build-flow-label">
          {name.slice(0, 3)}
        </text>
      )}
      {label && (
        // Pushed right where centring it would put its start under the gutter.
        <text x={Math.max(bx, LABEL_W + 4 + (label.length * CHAR_W) / 2)} y={middle + R + 11} fill={color} textAnchor="middle" className="replay-build-flow-label">
          {label}
        </text>
      )}
    </g>
  );
}
