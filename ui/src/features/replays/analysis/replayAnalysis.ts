// The arithmetic behind the replay analysis panels, kept out of the components
// that draw them.
//
// Everything here mirrors what the Python client computes in
// `src/replays/replaydetails/` (FAForever/client): the same rolling window over
// the same deduplicated orders, the same per-player denominator, the same
// colour palette. Where the two disagree the reason is written down.

import type {
  ReplayAnalysis,
  ReplayArmy,
  ReplayOrder,
  ReplayPoint,
} from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";

/** The simulation's clock: ten ticks to the second. */
export const TICKS_PER_SECOND = 10;

/**
 * The window the activity graph counts over, in ticks.
 *
 * Sixty seconds, which is what makes the line "actions per minute" rather than
 * a count per tick. The Python client uses the same 600.
 */
export const ACTIVITY_WINDOW_TICKS = 600;

/**
 * The game's own player colours, indexed the way a replay's `PlayerColor` is:
 * from one.
 *
 * Copied from `lua/GameColors.lua` by way of the Python client, so a player is
 * the colour here that they were on the map.
 */
export const PLAYER_COLORS = [
  "#e80a0a", // Cybran red
  "#901427", // dark red
  "#FF873E", // Nomads orange
  "#b76518", // brown
  "#a79602", // Seraphim gold
  "#fafa00", // yellow
  "#9fd802", // Order green
  "#40bf40", // mid green
  "#2e8b57", // green
  "#2F4F4F", // olive
  "#436eee", // blue
  "#2929e1", // UEF blue
  "#5F01A7", // dark purple
  "#9161ff", // purple
  "#66ffcc", // aqua
  "#ffffff", // white
  "#616d7e", // grey
  "#ff88ff", // pink
  "#ff32ff", // fuchsia
] as const;

export function playerColor(index: number): string {
  return PLAYER_COLORS[index - 1] ?? PLAYER_COLORS[15];
}

/**
 * `EUnitCommandType`, which is what an order's `command` is.
 *
 * Taken from the engine's own enum, which the Python client's Zig parser also
 * carries. That client's display table has `BuildFactory` and `BuildMobile` the
 * other way round to its own enum; the two agreeing sources win.
 */
export const COMMAND_NAMES = [
  "None",
  "Stop",
  "Move",
  "Dive",
  "Form move",
  "Build tactical silo",
  "Build nuclear silo",
  "Build factory",
  "Build mobile",
  "Assist build",
  "Attack",
  "Form attack",
  "Nuke",
  "Tactical missile",
  "Teleport",
  "Guard",
  "Patrol",
  "Ferry",
  "Form patrol",
  "Reclaim",
  "Repair",
  "Capture",
  "Load transport",
  "Reverse load transport",
  "Unload transport",
  "Unload some units",
  "Detach from transport",
  "Upgrade",
  "Script",
  "Assist commander",
  "Kill self",
  "Destroy self",
  "Sacrifice",
  "Pause",
  "Overcharge",
  "Aggressive move",
  "Form aggressive move",
  "Assist move",
  "Special action",
  "Dock",
  "Retarget",
] as const;

export function commandName(command: number): string {
  return COMMAND_NAMES[command] ?? `Command ${command}`;
}

/** `12:34`, and `1:02:03` once a game passes the hour. */
export function formatGameTime(ticks: number): string {
  const seconds = Math.max(0, Math.floor(ticks / TICKS_PER_SECOND));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const padded = `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${padded}` : padded;
}

/** One player, as every analysis panel wants them. */
export interface AnalysedPlayer {
  source: number;
  name: string;
  faction: number;
  color: string;
  team: number;
  country: string;
  rating: number | null;
  /** Deduplicated orders, the way the Python client counts them. */
  commands: number;
  /** The last tick this player did anything. */
  lastTick: number;
  /** Commands per minute, over the time up to that last tick. */
  perMinute: number | null;
}

/**
 * Join the armies to what the command stream says they did.
 *
 * The denominator is the player's own last order rather than the length of the
 * game, which is the Python client's rule and the fair one: somebody killed at
 * minute ten did nothing for the thirty minutes after it, and dividing by forty
 * would report them as four times slower than they played.
 */
export function analysedPlayers(analysis: ReplayAnalysis): AnalysedPlayer[] {
  const activity = new Map(analysis.activity.map((entry) => [entry.source, entry]));
  return analysis.armies
    .map((army: ReplayArmy) => {
      const own = activity.get(army.source);
      const commands = own?.commandTicks.length ?? 0;
      const lastTick = own?.lastTick ?? analysis.ticks;
      const minutes = lastTick / TICKS_PER_SECOND / 60;
      return {
        source: army.source,
        name: army.name,
        faction: army.faction,
        color: playerColor(army.color),
        team: army.team,
        country: army.country,
        rating: army.rating,
        commands,
        lastTick,
        perMinute: minutes > 0 ? commands / minutes : null,
      };
    })
    .sort((left, right) => left.team - right.team || right.commands - left.commands);
}

/**
 * A rolling count of actions, one value per tick.
 *
 * At tick `t` the value is how many orders the player gave in the minute
 * starting there, which is the line the activity graph draws. Built by sliding
 * a window rather than by counting each tick's minute from scratch: a long game
 * is tens of thousands of ticks, and the quadratic version of this took longer
 * than reading the file did.
 */
export function rollingActions(
  commandTicks: readonly number[],
  ticks: number,
  window = ACTIVITY_WINDOW_TICKS,
): Uint16Array {
  const series = new Uint16Array(Math.max(ticks, 1));
  if (commandTicks.length === 0 || ticks <= 0) return series;

  const perTick = new Uint16Array(ticks + window);
  for (const tick of commandTicks) {
    if (tick >= 0 && tick < perTick.length) perTick[tick] += 1;
  }
  let running = 0;
  for (let tick = 0; tick < window && tick < perTick.length; tick += 1) running += perTick[tick];
  series[0] = running;
  for (let tick = 1; tick < ticks; tick += 1) {
    running += perTick[tick + window - 1] - perTick[tick - 1];
    series[tick] = running;
  }
  return series;
}

/** The tallest value across a set of series, for a shared y axis. */
export function peakOf(series: Iterable<Uint16Array>): number {
  let peak = 0;
  for (const values of series) {
    for (const value of values) if (value > peak) peak = value;
  }
  return peak;
}

/**
 * Orders in one window of the graph, per player.
 *
 * The panel under the graph lists what each player was actually doing in the
 * minute the pointer is over, which is the Python client's own read-out.
 *
 * Counted the way the line above it is counted, by the walk's own rule: the
 * same command type repeated back to back on the same tick by the same client
 * is one action. The stream emits one record per selected unit, so a single
 * click onto forty engineers arrives as forty identical records, and listing
 * them raw put a number under the graph that the graph's own axis never
 * reaches -- a read-out of 182 actions over a chart whose peak was 109. The
 * run is tracked across the whole stream rather than inside the window, so an
 * order sitting on the window's first tick is judged against the one before
 * it and not by where the pointer happens to be.
 */
export function ordersInWindow(
  orders: readonly ReplayOrder[],
  from: number,
  window = ACTIVITY_WINDOW_TICKS,
): Map<number, ReplayOrder[]> {
  const grouped = new Map<number, ReplayOrder[]>();
  const previous = new Map<number, { tick: number; command: number }>();
  for (const order of orders) {
    const last = previous.get(order.source);
    const repeated = last?.tick === order.tick && last?.command === order.command;
    previous.set(order.source, { tick: order.tick, command: order.command });
    if (repeated) continue;
    if (order.tick < from || order.tick >= from + window) continue;
    const own = grouped.get(order.source);
    if (own) own.push(order);
    else grouped.set(order.source, [order]);
  }
  return grouped;
}

/** What the heatmap draws: a count per cell, and the busiest cell in it. */
export interface HeatmapBins {
  /** `size * size` counts, row by row. */
  cells: Float32Array<ArrayBuffer>;
  size: number;
  peak: number;
}

/**
 * Bin the points of a replay into a square grid over the map.
 *
 * The map's own edge length is the scale: a point is in world units, and two
 * replays on differently sized maps have to land in the same grid for the
 * picture to mean the same thing.
 *
 * No axis is flipped. FAF's own map previews put world `x` and `z` straight
 * onto image `x` and `y` (`normalize_pos` in the Python client's
 * `fa/maps_/_preview.py`), which is what makes a start spot land where the
 * spot is; the heatmap draws over one of those previews and has to agree with
 * it. That client's own heatmap does flip, because the plotting widget it
 * draws into has its origin at the bottom, and it rotates the map underneath
 * to match.
 *
 * Coordinates off the edge of the map are clamped rather than dropped: aiming
 * past the border is a real thing players do, and it belongs on the nearest
 * cell rather than nowhere.
 */
export function heatmapBins(
  points: readonly ReplayPoint[],
  mapWidth: number,
  mapHeight: number,
  size: number,
  include: (point: ReplayPoint) => boolean,
): HeatmapBins {
  const cells = new Float32Array(size * size);
  const width = Math.max(1, mapWidth);
  const height = Math.max(1, mapHeight);
  let peak = 0;
  for (const point of points) {
    if (!include(point)) continue;
    const x = Math.min(size - 1, Math.max(0, Math.round((point.x / width) * (size - 1))));
    const y = Math.min(size - 1, Math.max(0, Math.round((point.y / height) * (size - 1))));
    const index = y * size + x;
    cells[index] += 1;
    if (cells[index] > peak) peak = cells[index];
  }
  return { cells, size, peak };
}

/**
 * Blur the bins, so a scatter of single orders reads as a region.
 *
 * A separable box blur run three times, which is close enough to a Gaussian for
 * a picture and cheap enough to redo whenever a filter changes. The Python
 * client calls `scipy.ndimage.gaussian_filter` for the same effect.
 */
export function blurBins(bins: HeatmapBins, radius: number): HeatmapBins {
  if (radius <= 0) return bins;
  const { size } = bins;
  let source: Float32Array<ArrayBuffer> = bins.cells;
  let target: Float32Array<ArrayBuffer> = new Float32Array(size * size);
  for (let pass = 0; pass < 3; pass += 1) {
    // Horizontal, then vertical, reusing the two buffers.
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let total = 0;
        let count = 0;
        for (let offset = -radius; offset <= radius; offset += 1) {
          const sampled = x + offset;
          if (sampled < 0 || sampled >= size) continue;
          total += source[y * size + sampled];
          count += 1;
        }
        target[y * size + x] = count > 0 ? total / count : 0;
      }
    }
    [source, target] = [target, source];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let total = 0;
        let count = 0;
        for (let offset = -radius; offset <= radius; offset += 1) {
          const sampled = y + offset;
          if (sampled < 0 || sampled >= size) continue;
          total += source[sampled * size + x];
          count += 1;
        }
        target[y * size + x] = count > 0 ? total / count : 0;
      }
    }
    [source, target] = [target, source];
  }
  let peak = 0;
  for (const value of source) if (value > peak) peak = value;
  return { cells: source, size, peak };
}

/** The unit categories the simulation reports, in the order the panel wants. */
export const UNIT_CATEGORIES = [
  "land",
  "air",
  "naval",
  "structures",
  "engineer",
  "transportation",
  "cdr",
  "sacu",
  "tech1",
  "tech2",
  "tech3",
  "experimental",
] as const;

/**
 * The token each unit category's bar is drawn in.
 *
 * Twelve categories stand side by side in one group on the units tab, and
 * twelve bars in one colour say nothing about what was built: "bei units in
 * gamestats hat jede unit die gleiche farbe". The tokens are declared in
 * `tokens.css` as aliases of the palette, so a theme changes them with
 * everything else.
 */
export const UNIT_CATEGORY_TOKENS: Readonly<Record<string, string>> = {
  land: "--color-unit-land",
  air: "--color-unit-air",
  naval: "--color-unit-naval",
  structures: "--color-unit-structures",
  engineer: "--color-unit-engineer",
  transportation: "--color-unit-transportation",
  cdr: "--color-unit-cdr",
  sacu: "--color-unit-sacu",
  tech1: "--color-unit-tech1",
  tech2: "--color-unit-tech2",
  tech3: "--color-unit-tech3",
  experimental: "--color-unit-experimental",
};

/**
 * What to call a unit category, and the three things a game is measured in.
 *
 * The simulation's own field names are `cdr` and `sacu` and `massin`; the
 * catalogue turns those into words, in whatever language the client is set to.
 */
export const STAT_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  land: "replays.insights.unit.land",
  air: "replays.insights.unit.air",
  naval: "replays.insights.unit.naval",
  structures: "replays.insights.unit.structures",
  engineer: "replays.insights.unit.engineer",
  transportation: "replays.insights.unit.transportation",
  cdr: "replays.insights.unit.cdr",
  sacu: "replays.insights.unit.sacu",
  tech1: "replays.insights.unit.tech1",
  tech2: "replays.insights.unit.tech2",
  tech3: "replays.insights.unit.tech3",
  experimental: "replays.insights.unit.experimental",
  mass: "replays.insights.mass",
  energy: "replays.insights.energy",
  count: "replays.insights.count",
};

/** `1.2M`, `340k`, `900`: bar labels that fit under a bar. */
export function compactNumber(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (magnitude >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}
