// Pure helpers for the unit history section: the unit grid, naming a value,
// formatting one, and turning series into chart lines. Kept apart from the
// views so they can be tested without rendering.

import type { UnitHistory, UnitStat, UnitSummary, UnitValueKey, WeaponStat } from "../../ipc/bindings";
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

/** The factions in the game's own order, as blueprints write them. */
export const UNIT_FACTIONS = ["UEF", "Aeon", "Cybran", "Seraphim"] as const;

/** How many lines one chart colours: `--color-chart-1` to `-8`. */
export const CHART_COLORS = 8;

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
 * The list order: by faction in the game's order, then commanders before tech
 * 1 to experimental, then by name, which keeps a faction's tree together.
 */
export function sortUnits(units: readonly UnitSummary[]): UnitSummary[] {
  const faction = (unit: UnitSummary) => {
    const index = FACTION_ORDER.indexOf(unit.faction ?? "");
    return index === -1 ? FACTION_ORDER.length : index;
  };
  return [...units].sort(
    (left, right) =>
      faction(left) - faction(right) ||
      (left.tech ?? 0) - (right.tech ?? 0) ||
      unitTitle(left).localeCompare(unitTitle(right)) ||
      left.id.localeCompare(right.id),
  );
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
    if (faction && unit.faction !== faction) return false;
    if (tech !== null && unit.tech !== tech) return false;
    if (!needle) return true;
    return [unit.id, unit.name ?? "", unit.description ?? ""].some((text) => text.toLocaleLowerCase().includes(needle));
  });
}

export interface UnitGroup {
  faction: string;
  tiers: Array<{ tech: number | null; units: UnitSummary[] }>;
}

/**
 * The grid of a unit database: one block per faction, one row of icons per
 * tech level inside it (commanders and the like first, experimentals last).
 */
export function groupUnits(units: readonly UnitSummary[]): UnitGroup[] {
  const groups: UnitGroup[] = [];
  for (const unit of sortUnits(units)) {
    const faction = unit.faction ?? "";
    let group = groups.find((candidate) => candidate.faction === faction);
    if (!group) {
      group = { faction, tiers: [] };
      groups.push(group);
    }
    let tier = group.tiers.find((candidate) => candidate.tech === unit.tech);
    if (!tier) {
      tier = { tech: unit.tech, units: [] };
      group.tiers.push(tier);
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
