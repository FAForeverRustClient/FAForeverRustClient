// A player's build order as lanes, one per unit that built something: the
// commander, each engineer, each factory. Every order is a node on its
// builder's lane with a bar for as long as the build took, and a node that
// made a builder of its own (a factory's engineer, an engineer's factory)
// branches down to that builder's lane. The drawing is `ReplayBuildFlow`;
// this is pure, so it is tested without a page.
//
// The layout is the one of the maintainer's own build order analyser
// (bo-sheppy, `BoFlow.tsx` and `model.ts`), which reads a recorder mod's log
// with every build's start and finish. A replay holds only the orders, so
// here two things are reconstructed and the view says they are:
//
// - **When a build ran.** A builder works through its orders one after the
//   other, so a build starts when it was ordered or when the one before it
//   finished, whichever is later, and takes the unit's build time over the
//   builder's build power; a group of engineers given one order builds it
//   at their power together, on the lane of the first. Assisting by later
//   orders, walking and running short of mass or energy are not in the file
//   and are not counted.
// - **Which unit a lane is.** The stream names a unit by a number the engine
//   hands out again once the unit is gone, and an order by an id it hands out
//   again once the order is done: in replay 28032260 unit 3 is a mass
//   extractor at 1:15 and an air factory from 5:11. So a number starts a new
//   lane when its orders stop fitting the unit it was (a factory order to a
//   number that was an engineer), and a queue change belongs to the latest
//   order of its id. Two engineers that held the same number one after the
//   other still share a lane; nothing in the file tells them apart.
// - **Which builder a build became.** A unit exists from the moment its build
//   starts, so builders are matched to builds in the order they first took
//   an order, each to a build ordered before that; where none fits, there is
//   no branch rather than a wrong one.

import type { ReplayAnalysis, ReplayOrder, UnitKind, UnitSummary } from "../../../ipc/bindings";
import { BUILD_FACTORY, BUILD_MOBILE, SCRIPT, UPGRADE } from "./buildOrder";
import { TICKS_PER_SECOND } from "./replayAnalysis";

/** The analyser's categories: one colour each for a lane and its bars. */
export type FlowCategory =
  | "acu"
  | "factory"
  | "engie"
  | "mex"
  | "power"
  | "structure"
  | "unit"
  | "bomber"
  | "interceptor";

export interface FlowNode {
  key: string;
  /** When the order was given, in ticks. */
  ordered: number;
  /** When the build is reckoned to have run, in ticks; `end` null where the
   *  length is not known (a commander upgrade). */
  start: number;
  end: number | null;
  /** Upper-case blueprint id, or null for a commander upgrade. */
  unit: string | null;
  enhancement: string | null;
  category: FlowCategory;
  /** Taken off the queue again before it began. */
  cancelled: boolean;
  /** Units the order went to that build it together: a group of engineers
   *  given one structure. A factory order's factories each build their own. */
  builders: number;
  /** The lane of the builder this build became, where it became one. */
  child: number | null;
}

export type LaneKind = "acu" | "engineer" | "factory" | "upgrades";

export interface FlowLane {
  /** The lane's own number, in the order lanes opened; -1 for the upgrades lane. */
  id: number;
  /** The builder's unit number in the stream, which a later unit may hold again. */
  unit: number;
  kind: LaneKind;
  /** The builder's place among its kind, from 1: "Engineer 3". */
  index: number;
  /** For a factory, what it builds. */
  layer: UnitKind | null;
  category: FlowCategory;
  nodes: FlowNode[];
}

type Catalogue = ReadonlyMap<string, UnitSummary>;

/** The upgrades of structures that build nothing themselves share a lane. */
export const UPGRADES_LANE = -1;

/** A faction's blueprint prefix, by the army's faction number. */
const FACTION_PREFIX: Record<number, string> = { 1: "UE", 2: "UA", 3: "UR", 4: "XS" };
const FACTION_NAME: Record<number, string> = { 1: "UEF", 2: "Aeon", 3: "Cybran", 4: "Seraphim" };
const ENGINEER_SUFFIX: Record<number, string> = { 1: "L0105", 2: "L0208", 3: "L0309" };

/** Build power where the installed game does not say: the base game's values. */
const FALLBACK_RATE = { acu: 10, engineer: 5, factory: 20, upgrade: 10 } as const;

export function categoryOf(unit: UnitSummary | undefined): FlowCategory {
  if (!unit) return "unit";
  if (unit.role === "landFactory" || unit.role === "airFactory" || unit.role === "navalFactory") return "factory";
  if (unit.role === "massExtractor") return "mex";
  const icon = unit.strategicIcon ?? "";
  if (icon.includes("engineer")) return "engie";
  if (unit.role === "hydrocarbon" || icon.endsWith("_energy")) return "power";
  if (unit.kind === "structure") return "structure";
  if (unit.kind === "air") {
    const words = `${unit.name ?? ""} ${unit.description ?? ""}`.toLowerCase();
    if (words.includes("bomber") || words.includes("gunship")) return "bomber";
    if (words.includes("interceptor") || words.includes("fighter")) return "interceptor";
  }
  return "unit";
}

const isFactoryRole = (unit: UnitSummary | undefined) =>
  unit?.role === "landFactory" || unit?.role === "airFactory" || unit?.role === "navalFactory";

/** The faction's factory of a layer and tech level: the headquarters, which the build menu lists first. */
function factoryOf(catalogue: Catalogue, faction: string, layer: UnitKind, tech: number): UnitSummary | undefined {
  const role = layer === "air" ? "airFactory" : layer === "naval" ? "navalFactory" : "landFactory";
  let best: UnitSummary | undefined;
  for (const unit of catalogue.values()) {
    if (unit.role !== role || unit.faction !== faction || unit.tech !== tech) continue;
    if (!best || (unit.sortPriority ?? Infinity) < (best.sortPriority ?? Infinity)) best = unit;
  }
  return best;
}

/** Ticks a build takes: build time over build power, ten ticks a second. */
function buildTicks(unit: UnitSummary | undefined, rate: number): number {
  if (!unit?.buildTime || rate <= 0) return 0;
  return Math.round((unit.buildTime / rate) * TICKS_PER_SECOND);
}

/** One player's lanes, the commander first, the rest by when they first built. */
export function buildFlow(
  analysis: Pick<ReplayAnalysis, "orders" | "queueChanges">,
  source: number,
  faction: number,
  catalogue: Catalogue,
): FlowLane[] {
  const prefix = FACTION_PREFIX[faction] ?? "UE";
  const factionName = FACTION_NAME[faction] ?? "UEF";
  const own = analysis.orders.filter((order) => order.source === source);
  const isBuild = (order: ReplayOrder) =>
    ((order.command === BUILD_FACTORY || order.command === BUILD_MOBILE || order.command === UPGRADE) && order.blueprint !== "") ||
    (order.command === SCRIPT && order.enhancement !== "");
  const orders = own.filter(isBuild);

  // An order whose count went to nothing never ran. A change names its order
  // by an id the engine reuses, so it is the latest order of that id given
  // by then; an id last given to an order that builds nothing is no build's.
  const counts = new Map<ReplayOrder, number>();
  const latest = new Map<number, ReplayOrder>();
  let given = 0;
  for (const change of analysis.queueChanges) {
    if (change.source !== source) continue;
    for (; given < own.length && own[given].tick <= change.tick; given += 1) latest.set(own[given].id, own[given]);
    const order = latest.get(change.order);
    if (order && isBuild(order)) counts.set(order, (counts.get(order) ?? 1) + change.delta);
  }

  // A unit number's lane, until its orders show the number belongs to
  // another unit now: a factory order to what was an engineer, or the other
  // way round. The commander is whoever took the first build order.
  const lanes: FlowLane[] = [];
  const current = new Map<number, FlowLane>();
  let upgrades: FlowLane | null = null;
  const open = (unitNumber: number, kind: LaneKind): FlowLane => {
    const lane: FlowLane = {
      id: kind === "upgrades" ? UPGRADES_LANE : lanes.length,
      unit: unitNumber,
      kind,
      index: 0,
      layer: null,
      category: laneCategory(kind),
      nodes: [],
    };
    lanes.push(lane);
    if (kind !== "upgrades") current.set(unitNumber, lane);
    return lane;
  };

  orders.forEach((order, position) => {
    const unitId = order.blueprint ? order.blueprint.toUpperCase() : null;
    const unit = unitId ? catalogue.get(unitId) : undefined;
    const held = current.get(order.unit);
    let lane: FlowLane;
    if (order.command === BUILD_FACTORY) {
      lane = held?.kind === "factory" ? held : open(order.unit, "factory");
    } else if (order.command === UPGRADE) {
      // A factory's upgrade stays on its lane; any other structure's goes to
      // the shared lane, since those build nothing that would need one.
      if (!isFactoryRole(unit)) lane = upgrades ??= open(UPGRADES_LANE, "upgrades");
      else lane = held?.kind === "factory" ? held : open(order.unit, "factory");
    } else if (held && held.kind !== "factory") {
      lane = held;
    } else {
      lane = open(order.unit, lanes.some((other) => other.kind === "acu") ? "engineer" : "acu");
    }
    if (lane.kind === "factory" && lane.layer === null && order.command === BUILD_FACTORY && unit) lane.layer = unit.kind;
    lane.nodes.push({
      key: `${source}:${position}`,
      ordered: order.tick,
      start: order.tick,
      end: null,
      unit: unitId,
      enhancement: order.enhancement || null,
      category: order.command === SCRIPT ? "acu" : categoryOf(unit),
      cancelled: (counts.get(order) ?? 1) <= 0,
      builders: order.command === BUILD_MOBILE ? Math.max(1, order.units) : 1,
      child: null,
    });
  });

  // When each build ran: one after the other on its lane, at the lane's
  // build power.
  for (const lane of lanes) {
    let free = 0;
    let factoryTech = 1;
    const engineerTech = Math.min(
      3,
      Math.max(1, ...lane.nodes.map((node) => (node.unit ? catalogue.get(node.unit)?.tech ?? 1 : 1)).filter((tech) => tech <= 3)),
    );
    for (const node of lane.nodes) {
      const unit = node.unit ? catalogue.get(node.unit) : undefined;
      if (node.cancelled) {
        node.start = node.ordered;
        node.end = node.ordered;
        continue;
      }
      let rate: number;
      if (lane.kind === "acu") rate = catalogue.get(`${prefix}L0001`)?.buildRate ?? FALLBACK_RATE.acu;
      else if (lane.kind === "engineer")
        rate = catalogue.get(`${prefix}${ENGINEER_SUFFIX[engineerTech]}`)?.buildRate ?? FALLBACK_RATE.engineer;
      else if (lane.kind === "factory") {
        if (isFactoryRole(unit) && unit?.tech) factoryTech = Math.max(factoryTech, unit.tech);
        else if (unit?.tech && unit.tech <= 3) factoryTech = Math.max(factoryTech, unit.tech);
        rate = factoryOf(catalogue, factionName, lane.layer ?? "land", factoryTech)?.buildRate ?? FALLBACK_RATE.factory;
      } else {
        const from = [...catalogue.values()].find(
          (candidate) => candidate.role === unit?.role && candidate.faction === factionName && candidate.tech === (unit?.tech ?? 2) - 1,
        );
        rate = from?.buildRate ?? FALLBACK_RATE.upgrade;
      }
      // The upgrades lane is many structures at once, so its builds overlap.
      node.start = lane.kind === "upgrades" ? node.ordered : Math.max(node.ordered, free);
      node.end = node.enhancement ? null : node.start + buildTicks(unit, rate * node.builders);
      if (lane.kind !== "upgrades") free = node.end ?? node.start;
    }
  }

  // Which builder each build became: builders in the order they first took
  // an order, each matched to the first build still free that was ordered
  // before that, since a builder cannot exist before its build was ordered.
  // (Not finished: a factory takes orders while it is still going up, and
  // assisting makes the reckoned build times too long.) A factory set to
  // repeat its queue builds engineers no order names; their lanes mostly find
  // no such build and keep no branch rather than a wrong one.
  const firstOrder = (lane: FlowLane) => lane.nodes[0]?.ordered ?? Infinity;
  const byFirstOrder = [...lanes].sort((left, right) => firstOrder(left) - firstOrder(right) || left.id - right.id);
  const link = (made: (node: FlowNode) => boolean, targets: FlowLane[]) => {
    const builds = lanes
      .flatMap((lane) => lane.nodes)
      .filter((node) => !node.cancelled && made(node))
      .sort((left, right) => left.ordered - right.ordered);
    for (const lane of targets) {
      const build = builds.find((node) => node.child === null && node.ordered <= firstOrder(lane));
      if (build) build.child = lane.id;
    }
  };
  // A factory's own upgrade sits on its lane and makes no new factory.
  const builtByBuilder = (node: FlowNode) =>
    lanes.some((lane) => (lane.kind === "acu" || lane.kind === "engineer") && lane.nodes.includes(node));
  link((node) => node.category === "engie", byFirstOrder.filter((lane) => lane.kind === "engineer"));
  for (const layer of ["land", "air", "naval"] as const) {
    link(
      (node) => node.category === "factory" && layerOf(node, catalogue) === layer && builtByBuilder(node),
      byFirstOrder.filter((lane) => lane.kind === "factory" && lane.layer === layer),
    );
  }

  // Numbered in the order they first built: engineers together, factories
  // by what they build.
  byFirstOrder.filter((lane) => lane.kind === "engineer").forEach((lane, index) => (lane.index = index + 1));
  for (const layer of ["land", "air", "naval", null] as const) {
    byFirstOrder.filter((lane) => lane.kind === "factory" && lane.layer === layer).forEach((lane, index) => (lane.index = index + 1));
  }
  // The commander first, the shared upgrades last, every other builder in
  // the order it first built, so branches run downwards.
  return byFirstOrder.sort(
    (left, right) =>
      Number(right.kind === "acu") - Number(left.kind === "acu") ||
      Number(left.kind === "upgrades") - Number(right.kind === "upgrades") ||
      firstOrder(left) - firstOrder(right) ||
      left.id - right.id,
  );
}

/** What a factory build builds for: the layer of its role. */
function layerOf(node: FlowNode, catalogue: Catalogue): UnitKind | null {
  const role = node.unit ? catalogue.get(node.unit)?.role : null;
  return role === "landFactory" ? "land" : role === "airFactory" ? "air" : role === "navalFactory" ? "naval" : null;
}

function laneCategory(kind: LaneKind): FlowCategory {
  switch (kind) {
    case "acu":
      return "acu";
    case "engineer":
      return "engie";
    case "factory":
      return "factory";
    default:
      return "structure";
  }
}

/** The span a flow needs: up to the last build's end, at least the opening. */
export function flowSpan(lanes: readonly FlowLane[], minimum: number): number {
  let last = minimum;
  for (const lane of lanes) for (const node of lane.nodes) last = Math.max(last, node.end ?? node.start);
  return last;
}
