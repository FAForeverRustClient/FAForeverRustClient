// The build order of a replay: what each player ordered built, in order, and
// the milestones of an opening read off it. Pure functions over the analysis
// the backend sends and the unit list of the installed game; the pane
// (`ReplayBuildOrderPane`) only draws what these return.
//
// Everything here is an order, not a completion: the replay holds the inputs,
// not what came of them, so a structure cancelled a second later still counts
// and a factory order counts the moment it is queued. The pane says so.
//
// The rules follow faf-workshop's Build order tab (Garanas/faf-workshop,
// `OpeningTimings.cs` and `BuildOrderItem.cs`, MIT): a factory order builds
// one unit in every factory it went to, an engineer order one structure, a
// queue change its signed count; equal orders a player gave in one tick are
// one row; the milestones are firsts only. Where that code tells a structure
// apart by the words of its description, this uses the role the installed
// blueprint's categories give it (`UnitSummary.role`).

import type { ReplayAnalysis, ReplayOrder, UnitSummary } from "../../../ipc/bindings";
import { TICKS_PER_SECOND } from "./replayAnalysis";

/** `EUnitCommandType` values a build order is made of. */
export const BUILD_FACTORY = 7;
export const BUILD_MOBILE = 8;
export const UPGRADE = 27;
export const SCRIPT = 28;

const TICKS_PER_MINUTE = 60 * TICKS_PER_SECOND;

/** How many minutes the per-minute table covers: the opening, not the game. */
export const OPENING_MINUTES = 10;

export type BuildEntry = {
  /** Stable within one replay: the order's place among the player's entries. */
  key: string;
  tick: number;
  /** Upper-case blueprint id, or null for a commander upgrade. */
  unit: string | null;
  /** The commander upgrade's id as the blueprint names it, e.g. `AdvancedEngineering`. */
  enhancement: string | null;
  /** Units the entry adds; negative for a queue shortened. */
  quantity: number;
  /** A change to an order already queued rather than an order of its own. */
  queueChange: boolean;
  /** A structure upgraded in place (a mass extractor to tech 2). */
  upgrade: boolean;
};

export type MilestoneId =
  | "landFactory"
  | "airFactory"
  | "navalFactory"
  | "hydrocarbon"
  | "energyStorage"
  | "massUpgrade"
  | "acuUpgrade"
  | "t2Factory"
  | "t2Unit"
  | "t3Factory"
  | "t3Unit"
  | "experimental";

type Catalogue = ReadonlyMap<string, UnitSummary>;

/** The installed units by upper-case id, which is how the orders are looked up. */
export function unitCatalogue(units: readonly UnitSummary[]): Catalogue {
  return new Map(units.map((unit) => [unit.id.toUpperCase(), unit]));
}

const isFactory = (unit: UnitSummary | undefined, tech: number) =>
  unit?.tech === tech && (unit.role === "landFactory" || unit.role === "airFactory" || unit.role === "navalFactory");
const isMobile = (unit: UnitSummary | undefined, tech: number) =>
  unit !== undefined && unit.kind !== "structure" && unit.tech === tech;

const MILESTONE_TESTS: ReadonlyArray<[MilestoneId, (entry: BuildEntry, unit: UnitSummary | undefined) => boolean]> = [
  ["landFactory", (_, unit) => unit?.role === "landFactory" && unit.tech === 1],
  ["airFactory", (_, unit) => unit?.role === "airFactory" && unit.tech === 1],
  ["navalFactory", (_, unit) => unit?.role === "navalFactory" && unit.tech === 1],
  ["hydrocarbon", (_, unit) => unit?.role === "hydrocarbon"],
  ["energyStorage", (_, unit) => unit?.role === "energyStorage"],
  ["massUpgrade", (_, unit) => unit?.role === "massExtractor" && unit.tech === 2],
  ["acuUpgrade", (entry) => entry.enhancement !== null && !isRemoval(entry.enhancement)],
  ["t2Factory", (_, unit) => isFactory(unit, 2)],
  ["t2Unit", (_, unit) => isMobile(unit, 2)],
  ["t3Factory", (_, unit) => isFactory(unit, 3)],
  ["t3Unit", (_, unit) => isMobile(unit, 3)],
  ["experimental", (_, unit) => unit?.tech === 4],
];

export const MILESTONES: readonly MilestoneId[] = MILESTONE_TESTS.map(([id]) => id);

/** The blueprint's id of taking an upgrade off again: `T3EngineeringRemove`. */
const REMOVAL = /.Remove$/;

function isRemoval(enhancement: string): boolean {
  return REMOVAL.test(enhancement);
}

/**
 * What one player ordered built, in the order given. Orders that build
 * nothing (moves, attacks, assists) are left out, and so is a script order
 * that is not a commander upgrade.
 */
export function buildEntries(analysis: Pick<ReplayAnalysis, "orders" | "queueChanges">, source: number): BuildEntry[] {
  const entries: Array<Omit<BuildEntry, "key">> = [];
  for (const order of analysis.orders) {
    if (order.source !== source) continue;
    const entry = entryOf(order);
    if (entry) entries.push(entry);
  }
  for (const change of analysis.queueChanges) {
    if (change.source !== source || change.delta === 0) continue;
    entries.push({
      tick: change.tick,
      unit: change.blueprint ? change.blueprint.toUpperCase() : null,
      enhancement: null,
      quantity: change.delta,
      queueChange: true,
      upgrade: false,
    });
  }
  // Stable: orders before queue changes on the same tick, each in stream order.
  entries.sort((a, b) => a.tick - b.tick || Number(a.queueChange) - Number(b.queueChange));
  return entries.map((entry, index) => ({ ...entry, key: `${source}:${index}` }));
}

function entryOf(order: ReplayOrder): Omit<BuildEntry, "key"> | null {
  const unit = order.blueprint ? order.blueprint.toUpperCase() : null;
  switch (order.command) {
    case BUILD_FACTORY:
      return unit ? { tick: order.tick, unit, enhancement: null, quantity: Math.max(1, order.units), queueChange: false, upgrade: false } : null;
    case BUILD_MOBILE:
      return unit ? { tick: order.tick, unit, enhancement: null, quantity: 1, queueChange: false, upgrade: false } : null;
    case UPGRADE:
      return unit ? { tick: order.tick, unit, enhancement: null, quantity: Math.max(1, order.units), queueChange: false, upgrade: true } : null;
    case SCRIPT:
      return order.enhancement
        ? { tick: order.tick, unit: null, enhancement: order.enhancement, quantity: 1, queueChange: false, upgrade: false }
        : null;
    default:
      return null;
  }
}

export type BuildRow = BuildEntry & {
  /** How many equal entries the player gave in this tick: a line of walls, a shift-clicked unit. */
  repeats: number;
};

/**
 * Equal entries of one tick as one row: dragging a line of twenty walls is
 * one decision, not twenty. Queue changes are never merged with orders.
 */
export function buildRows(entries: readonly BuildEntry[]): BuildRow[] {
  const rows: BuildRow[] = [];
  for (const entry of entries) {
    const last = rows[rows.length - 1];
    if (
      last &&
      last.tick === entry.tick &&
      last.unit === entry.unit &&
      last.enhancement === entry.enhancement &&
      last.queueChange === entry.queueChange &&
      last.upgrade === entry.upgrade &&
      Math.sign(last.quantity) === Math.sign(entry.quantity)
    ) {
      last.repeats += 1;
      last.quantity += entry.quantity;
      continue;
    }
    rows.push({ ...entry, repeats: 1 });
  }
  return rows;
}

/** The tick each milestone was first reached, or null where it never was. */
export function milestoneTicks(entries: readonly BuildEntry[], units: Catalogue): Record<MilestoneId, number | null> {
  const found = Object.fromEntries(MILESTONES.map((id) => [id, null])) as Record<MilestoneId, number | null>;
  for (const entry of entries) {
    if (entry.queueChange || entry.quantity <= 0) continue;
    const unit = entry.unit ? units.get(entry.unit) : undefined;
    for (const [id, test] of MILESTONE_TESTS) {
      if (found[id] === null && test(entry, unit)) found[id] = entry.tick;
    }
  }
  return found;
}

export type MinuteCount = { unit: string; count: number };

/**
 * The mobile units ordered in each minute of the opening, most first. Factory
 * orders times their factories, plus queue changes; a unit whose orders were
 * all taken back again in that minute is left out.
 */
export function unitsPerMinute(entries: readonly BuildEntry[], units: Catalogue, minutes = OPENING_MINUTES): MinuteCount[][] {
  const perMinute = Array.from({ length: minutes }, () => new Map<string, number>());
  for (const entry of entries) {
    if (!entry.unit || entry.upgrade) continue;
    const unit = units.get(entry.unit);
    if (!unit || unit.kind === "structure") continue;
    const minute = Math.floor(entry.tick / TICKS_PER_MINUTE);
    if (minute >= minutes) continue;
    const counts = perMinute[minute];
    counts.set(entry.unit, (counts.get(entry.unit) ?? 0) + entry.quantity);
  }
  return perMinute.map((counts) =>
    [...counts]
      .filter(([, count]) => count > 0)
      .map(([unit, count]) => ({ unit, count }))
      .sort((a, b) => b.count - a.count || a.unit.localeCompare(b.unit)),
  );
}

/**
 * A commander upgrade's id as words: `AdvancedEngineering` reads "Advanced
 * Engineering", `T3EngineeringRemove` "T3 Engineering" (the pane says it was
 * removed). The `FAF_` prefix of balance variants is dropped.
 */
export function enhancementWords(id: string): string {
  let name = id.startsWith("FAF_") ? id.slice(4) : id;
  if (isRemoval(name)) name = name.replace(/Remove$/, "");
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
}

export const isEnhancementRemoval = isRemoval;

/** The two players a build order compares by default: the first of each of the first two teams, else the first two. */
export function defaultPair<T extends { source: number; team: number }>(players: readonly T[]): [number, number] | null {
  if (players.length < 2) return null;
  const first = players[0];
  const rival = players.find((player) => player.team !== first.team) ?? players[1];
  return [first.source, rival.source];
}
