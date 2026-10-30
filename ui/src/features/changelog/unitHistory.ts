// Pure helpers for the unit history section: the unit grid, naming a value,
// formatting one, and turning series into chart lines. Kept apart from the
// views so they can be tested without rendering.

import type { UnitChange, UnitHistory, UnitKind, UnitStat, UnitSummary, UnitValueKey, WeaponStat } from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";
import { formatNumber } from "../../i18n";

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

export const UNIT_STAT_LABELS: Record<UnitStat, MessageKey> = {
  maxHealth: "changelog.units.stat.maxHealth",
  regenRate: "changelog.units.stat.regenRate",
  shieldHealth: "changelog.units.stat.shieldHealth",
  shieldRegenRate: "changelog.units.stat.shieldRegenRate",
  shieldRadius: "changelog.units.stat.shieldRadius",
  massCost: "changelog.units.stat.massCost",
  energyCost: "changelog.units.stat.energyCost",
  buildTime: "changelog.units.stat.buildTime",
  buildRate: "changelog.units.stat.buildRate",
  massProduction: "changelog.units.stat.massProduction",
  energyProduction: "changelog.units.stat.energyProduction",
  energyUpkeep: "changelog.units.stat.energyUpkeep",
  speed: "changelog.units.stat.speed",
  visionRadius: "changelog.units.stat.visionRadius",
  waterVisionRadius: "changelog.units.stat.waterVisionRadius",
  radarRadius: "changelog.units.stat.radarRadius",
  sonarRadius: "changelog.units.stat.sonarRadius",
  omniRadius: "changelog.units.stat.omniRadius",
};

export const WEAPON_STAT_LABELS: Record<WeaponStat, MessageKey> = {
  dps: "changelog.units.weaponStat.dps",
  damage: "changelog.units.weaponStat.damage",
  damageRadius: "changelog.units.weaponStat.damageRadius",
  range: "changelog.units.weaponStat.range",
  minRange: "changelog.units.weaponStat.minRange",
  rateOfFire: "changelog.units.weaponStat.rateOfFire",
  salvoSize: "changelog.units.weaponStat.salvoSize",
  salvoDelay: "changelog.units.weaponStat.salvoDelay",
  dotPulses: "changelog.units.weaponStat.dotPulses",
  dotTime: "changelog.units.weaponStat.dotTime",
};

/** A faction's units in this order: land, air, naval, then structures. */
export const UNIT_KINDS: readonly UnitKind[] = ["land", "air", "naval", "structure"];

export const UNIT_KIND_LABELS: Record<UnitKind, MessageKey> = {
  land: "changelog.units.kind.land",
  air: "changelog.units.kind.air",
  naval: "changelog.units.kind.naval",
  structure: "changelog.units.kind.structure",
};

/** The factions in the game's own order, as blueprints write them. */
export const UNIT_FACTIONS = ["UEF", "Aeon", "Cybran", "Seraphim"] as const;

/** How many lines one chart colours: `--color-chart-1` to `-8`. */
export const CHART_COLORS = 8;

/** A second, third, ... unit of one faction: its colour lighter, then darker,
 * then further each way, so the faction stays and the lines stay apart. */
const FACTION_SHADES = [
  (color: string) => color,
  (color: string) => `color-mix(in srgb, ${color} 62%, var(--color-text))`,
  (color: string) => `color-mix(in srgb, ${color} 62%, var(--color-bg))`,
  (color: string) => `color-mix(in srgb, ${color} 35%, var(--color-text))`,
  (color: string) => `color-mix(in srgb, ${color} 40%, var(--color-bg))`,
  (color: string) => `color-mix(in srgb, ${color} 82%, var(--color-text))`,
];

/**
 * Each picked unit's colour, wherever it is marked: its card, its column, its
 * line in the chart. Always its faction's; the first unit of a faction in the
 * selection takes the colour itself and the next ones a shade of it.
 */
export function unitColors(selected: string[], factionOf: (id: string) => string | null | undefined): Record<string, string> {
  const seen = new Map<string, number>();
  return Object.fromEntries(
    selected.map((id) => {
      const faction = (factionOf(id) ?? "").toLowerCase();
      const color = faction ? `var(--unit-faction-${faction})` : "var(--color-muted)";
      const place = seen.get(faction) ?? 0;
      seen.set(faction, place + 1);
      return [id, FACTION_SHADES[place % FACTION_SHADES.length](color)];
    }),
  );
}

/** A value's key as one string, for a `<select>` and a React key. */
export function valueKeyId(key: UnitValueKey): string {
  return key.type === "unit" ? `unit:${key.payload.stat}` : `weapon:${key.payload.weapon}:${key.payload.stat}`;
}

/** What a value is called: "Health", or "Gauss Cannon: DPS". */
export function valueLabel(key: UnitValueKey, history: UnitHistory, t: Translate): string {
  if (key.type === "unit") return t(UNIT_STAT_LABELS[key.payload.stat]);
  const weapon = history.weapons.find((known) => known.key === key.payload.weapon);
  return t("changelog.units.weaponValue", {
    weapon: weapon?.name ?? key.payload.weapon,
    value: t(WEAPON_STAT_LABELS[key.payload.stat]),
  });
}

/** The game's `MATH_IRound`: to the nearest whole number, ties to even. */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * A value as the reader sees it. DPS is a whole number, the way the game's
 * unit view prints it; everything else keeps the blueprint's precision.
 */
export function formatValue(key: UnitValueKey, value: number | null): string {
  if (value === null) return "–";
  if (key.type === "weapon" && key.payload.stat === "dps") return formatNumber(roundHalfEven(value));
  return formatNumber(value);
}

/** A change against the first value, signed: "+12%", "-5%", "0%". */
export function formatPercentChange(indexed: number | null): string {
  if (indexed === null) return "–";
  const change = Math.round(indexed - 100);
  return `${change > 0 ? "+" : ""}${formatNumber(change)}%`;
}

/** A unit's name for a list: "MA12 Striker", or its description, or its id. */
export function unitTitle(unit: UnitSummary): string {
  return unit.name ?? unit.description ?? unit.id;
}

const FACTION_ORDER: readonly string[] = UNIT_FACTIONS;

/**
 * The list order: by faction in the game's own order, then land, air, naval and
 * structures, then commanders before tech 1 to experimental, and within a
 * tech level the order of the game's own build menu (`BuildIconSortPriority`),
 * so a row reads the way a factory or an engineer offers it.
 */
export function sortUnits(units: readonly UnitSummary[]): UnitSummary[] {
  const faction = (unit: UnitSummary) => {
    const index = FACTION_ORDER.indexOf(unit.faction ?? "");
    return index === -1 ? FACTION_ORDER.length : index;
  };
  return [...units].sort(
    (left, right) =>
      faction(left) - faction(right) ||
      UNIT_KINDS.indexOf(left.kind) - UNIT_KINDS.indexOf(right.kind) ||
      (left.tech ?? 0) - (right.tech ?? 0) ||
      (left.sortPriority ?? Number.MAX_SAFE_INTEGER) - (right.sortPriority ?? Number.MAX_SAFE_INTEGER) ||
      unitTitle(left).localeCompare(unitTitle(right)) ||
      left.id.localeCompare(right.id),
  );
}

/**
 * Whether a unit belongs in the grid: everything a build menu offers, and the
 * commanders, which no menu builds (the only land units without a tech
 * level). Beacons, concrete, drones and test units have no place in any menu,
 * and most have no build icon either.
 */
export function inBuildMenus(unit: UnitSummary): boolean {
  return unit.sortPriority !== null || (unit.tech === null && unit.kind === "land");
}

/**
 * The units a search and the two filters leave. The search matches the name,
 * the description and the blueprint id, without regard to case.
 */
export function filterUnits(
  units: readonly UnitSummary[],
  query: string,
  faction: string,
  tech: number | null,
): UnitSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  return sortUnits(units).filter((unit) => {
    if (!inBuildMenus(unit)) return false;
    if (faction && unit.faction !== faction) return false;
    if (tech !== null && unit.tech !== tech) return false;
    if (!needle) return true;
    return [unit.id, unit.name ?? "", unit.description ?? ""].some((text) => text.toLocaleLowerCase().includes(needle));
  });
}

export interface UnitGroup {
  faction: string;
  kinds: Array<{ kind: UnitKind; tiers: UnitTier[] }>;
}

/** One row of the grid: one tech level of one kind, `null` the commanders. */
export interface UnitTier {
  tech: number | null;
  units: UnitSummary[];
}

/**
 * The grid of a unit database: one block per faction, in it one block each
 * for land, air, naval and structures, and in that one row per tech level in
 * build-menu order.
 */
export function groupUnits(units: readonly UnitSummary[]): UnitGroup[] {
  const groups: UnitGroup[] = [];
  for (const unit of sortUnits(units)) {
    const faction = unit.faction ?? "";
    let group = groups.find((candidate) => candidate.faction === faction);
    if (!group) {
      group = { faction, kinds: [] };
      groups.push(group);
    }
    let kind = group.kinds.find((candidate) => candidate.kind === unit.kind);
    if (!kind) {
      kind = { kind: unit.kind, tiers: [] };
      group.kinds.push(kind);
    }
    let tier = kind.tiers.find((candidate) => candidate.tech === unit.tech);
    if (!tier) {
      tier = { tech: unit.tech, units: [] };
      kind.tiers.push(tier);
    }
    tier.units.push(unit);
  }
  return groups;
}

/** The values a history can draw, in the history's own order. */
export function drawableKeys(history: UnitHistory): UnitValueKey[] {
  return history.series.filter((series) => series.values.some((value) => value !== null)).map((series) => series.key);
}

/** The values that took more than one value over the releases. */
export function changedKeys(history: UnitHistory): UnitValueKey[] {
  return history.series
    .filter((series) => new Set(series.values.filter((value) => value !== null)).size > 1)
    .map((series) => series.key);
}

/**
 * The values one unit's chart opens with: the ones that changed, the unit's
 * own before its weapons', as many as the chart has colours for.
 */
export function defaultStatKeys(history: UnitHistory, limit = 6): UnitValueKey[] {
  const changed = changedKeys(history);
  return [...changed.filter((key) => key.type === "unit"), ...changed.filter((key) => key.type === "weapon")].slice(0, limit);
}

/** One unit's values for a key, aligned with another history's releases. */
export function alignedValues(history: UnitHistory, key: UnitValueKey, releases: readonly string[]): (number | null)[] {
  const id = valueKeyId(key);
  const series = history.series.find((candidate) => valueKeyId(candidate.key) === id);
  if (!series) return releases.map(() => null);
  const byRelease = new Map(history.releases.map((release, index) => [release.release, series.values[index] ?? null]));
  return releases.map((release) => byRelease.get(release) ?? null);
}

/**
 * Values as a percentage of the first one that is not zero, so values of
 * different sizes (a health of 3000, a speed of 3.4) share one axis and a
 * step reads as the change it was. `null` stays `null`; values before that
 * first one are `null` too, having nothing to compare with.
 */
export function indexedValues(values: readonly (number | null)[]): (number | null)[] {
  const base = values.find((value) => value !== null && value !== 0);
  if (base === undefined || base === null) return values.map(() => null);
  const start = values.indexOf(base);
  return values.map((value, index) => (value === null || index < start ? null : (value / base) * 100));
}

/**
 * The value of another unit to draw beside `key`. Weapons are named per unit
 * ("MainGun", "LaserArms"), so a weapon value the other unit has no weapon of
 * that name for is taken from its first weapon that has the value: comparing
 * two tanks' DPS should not need their guns to share a label.
 */
export function comparableKey(other: UnitHistory, key: UnitValueKey): UnitValueKey | null {
  const id = valueKeyId(key);
  const drawable = drawableKeys(other);
  const same = drawable.find((candidate) => valueKeyId(candidate) === id);
  if (same) return same;
  if (key.type !== "weapon") return null;
  return drawable.find((candidate) => candidate.type === "weapon" && candidate.payload.stat === key.payload.stat) ?? null;
}

/** The default value to compare: DPS of the first weapon that has one, else health. */
export function defaultKey(history: UnitHistory): UnitValueKey | null {
  const keys = drawableKeys(history);
  return (
    keys.find((key) => key.type === "weapon" && key.payload.stat === "dps") ??
    keys.find((key) => key.type === "unit" && key.payload.stat === "maxHealth") ??
    keys[0] ??
    null
  );
}

/** A release id's number, for ordering releases newest first. */
export function releaseOrder(release: string): number {
  const number = Number.parseInt(release, 10);
  return Number.isFinite(number) ? number : 0;
}

/** The unit's own values a head shows, in this order, where the unit has them. */
const HEADLINE_STATS: readonly UnitStat[] = [
  "maxHealth",
  "shieldHealth",
  "massCost",
  "energyCost",
  "buildTime",
  "buildRate",
  "massProduction",
  "energyProduction",
  "speed",
  "visionRadius",
];

/** One value as a head shows it: the newest release's, and the first one's. */
export interface UnitFact {
  key: UnitValueKey;
  now: number;
  first: number;
}

/** The first and the last value of a series that is set, `null` when none is. */
export function valueSpan(values: readonly (number | null)[]): { first: number; now: number } | null {
  const set = values.filter((value): value is number => value !== null);
  return set.length === 0 ? null : { first: set[0], now: set[set.length - 1] };
}

/**
 * The values that say what a unit is: its health, costs and speed, then the
 * DPS of each weapon and the range of the first, as many as `limit`.
 */
export function headlineKeys(history: UnitHistory, limit = 8): UnitValueKey[] {
  const drawable = drawableKeys(history);
  const own = HEADLINE_STATS.flatMap((stat) =>
    drawable.filter((key) => key.type === "unit" && key.payload.stat === stat),
  );
  const range = drawable.find((key) => key.type === "weapon" && key.payload.stat === "range");
  // At most three weapon values, so an experimental's dozen guns leave room
  // for its health and costs.
  const weapons = [
    ...drawable.filter((key) => key.type === "weapon" && key.payload.stat === "dps"),
    ...(range ? [range] : []),
  ].slice(0, 3);
  return [...own.slice(0, limit - weapons.length), ...weapons];
}

/** A unit's headline values, newest and first. */
export function headlineFacts(history: UnitHistory, limit = 8): UnitFact[] {
  return headlineKeys(history, limit).flatMap((key) => {
    const span = valueSpan(alignedValues(history, key, history.releases.map((release) => release.release)));
    return span ? [{ key, ...span }] : [];
  });
}

/**
 * How many of `count` facts a strip shows, and in how many columns, so no row
 * has a hole: four or three to a row, the last fact or two left out rather
 * than a row half empty.
 */
export function factsLayout(count: number): { shown: number; columns: 2 | 3 | 4 } {
  if (count <= 2) return { shown: count, columns: 2 };
  if (count <= 4) return { shown: count, columns: count as 3 | 4 };
  if (count % 4 === 0) return { shown: count, columns: 4 };
  if (count % 3 === 0) return { shown: count, columns: 3 };
  const byFour = count - (count % 4);
  const byThree = count - (count % 3);
  return byThree > byFour ? { shown: byThree, columns: 3 } : { shown: byFour, columns: 4 };
}

/** A change from `before` to `after` as a signed percentage, `null` without both. */
export function changePercent(before: number | null, after: number | null): string | null {
  if (before === null || after === null || before === 0 || before === after) return null;
  return formatPercentChange((after / before) * 100);
}

/** Whether a change made the unit stronger or weaker. */
export type Verdict = "buff" | "nerf";

/** Values a unit is better off with less of: what it costs, how long it takes
 * to build, what it draws, and how close an enemy can get under its guns. */
const LOWER_IS_BETTER: ReadonlySet<UnitStat | WeaponStat> = new Set<UnitStat | WeaponStat>([
  "massCost",
  "energyCost",
  "buildTime",
  "energyUpkeep",
  "minRange",
]);

/** Values that say nothing on their own: a longer salvo delay or burn can be
 * the price of more damage, which DPS already counts. */
const NO_VERDICT: ReadonlySet<UnitStat | WeaponStat> = new Set<UnitStat | WeaponStat>(["salvoDelay", "dotTime"]);

/** A value going from `before` to `after` as a buff or a nerf, `null` when it
 * is neither or the value has no better direction. */
export function valueVerdict(key: UnitValueKey, before: number | null, after: number | null): Verdict | null {
  if (before === null || after === null || before === after) return null;
  const stat = key.payload.stat;
  if (NO_VERDICT.has(stat)) return null;
  const up = after > before;
  return up !== LOWER_IS_BETTER.has(stat) ? "buff" : "nerf";
}

/** What one release did to a unit, by its value changes: all buffs, all
 * nerfs, both, or `null` when it changed no value with a better direction. */
export function releaseVerdict(changes: readonly UnitChange[]): Verdict | "mixed" | null {
  const verdicts = new Set(
    changes.flatMap((change) =>
      change.type === "value" ? [valueVerdict(change.payload.key, change.payload.before, change.payload.after)] : [],
    ),
  );
  verdicts.delete(null);
  if (verdicts.size === 0) return null;
  if (verdicts.size > 1) return "mixed";
  return verdicts.has("buff") ? "buff" : "nerf";
}
