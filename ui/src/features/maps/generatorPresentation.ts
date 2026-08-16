// Turning generator data into things a person can read.
//
// Kept out of the dialog so the arithmetic (unit conversions, which options are
// legal, what a decoded map name says) can be tested without rendering React.

import type { DecodedMapName, GeneratorOptions, ValidationIssue } from "../../ipc/bindings";
import type { Translation } from "../../i18n/useTranslation";

/** Generator units per kilometre, the generator's own `MultipleMapSizeConverter`. */
export const UNITS_PER_KM = 51.2;

/** Map size is stored as a byte of 64-unit steps, so every legal size is a multiple. */
export const MAP_SIZE_STEP = 64;

/** Density slider resolution: the generator's `NUM_BINS`. */
export const DENSITY_BINS = 127;

/**
 * Every map size the generator accepts in the range the reference clients
 * offer, plus the two larger ones it also allows.
 *
 * The Java client offers 5–20 km in 1.25 km steps, which is exactly the 64-unit
 * grid; earlier this list skipped five of those thirteen for no reason. 1280
 * and 2048 are beyond what either reference client exposes but well within the
 * generator's own 2048 limit.
 */
export const MAP_SIZES: number[] = [
  256, 320, 384, 448, 512, 576, 640, 704, 768, 832, 896, 960, 1024, 1280, 2048,
];

/** Team counts the generator accepts. 1 is absent because it is meaningless. */
export const TEAM_COUNTS: number[] = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

/** The generator's ceiling on maps produced in a single run. */
export const MAX_MAPS_PER_RUN = 50;

export function sizeInKm(units: number): number {
  return units / UNITS_PER_KM;
}

/** "10 km (512×512)". Fractional sizes land on quarters, so one decimal is enough. */
export function formatMapSize(units: number): string {
  const km = sizeInKm(units);
  const rounded = Number.isInteger(km) ? String(km) : km.toFixed(2).replace(/0$/, "");
  return `${rounded} km (${units}×${units})`;
}

/**
 * Spawn counts that divide evenly among the given teams.
 *
 * The generator refuses anything else outright, so offering it would be
 * offering a guaranteed failure. The Java client filters its spinner the same
 * way; ours previously accepted any number between 2 and 16.
 */
export function spawnCountsFor(numTeams: number): number[] {
  const all = Array.from({ length: 15 }, (_, index) => index + 2);
  if (numTeams === 0) return all;
  return all.filter((spawns) => spawns % numTeams === 0);
}

/** Move a spawn count onto the nearest one legal for this many teams. */
export function nearestLegalSpawnCount(spawns: number, numTeams: number): number {
  const legal = spawnCountsFor(numTeams);
  if (legal.length === 0) return spawns;
  if (legal.includes(spawns)) return spawns;
  return legal.reduce((best, candidate) =>
    Math.abs(candidate - spawns) < Math.abs(best - spawns) ? candidate : best,
  );
}

/**
 * A validation issue as a sentence.
 *
 * Deliberately close to the generator's own wording, so somebody who sees both
 * ours and the generator's recognises them as the same complaint rather than
 * two unrelated problems.
 *
 * Takes the translate function rather than importing the module-level `t`, so
 * the messages follow the user's locale like the rest of the dialog and the
 * function stays testable without a locale being set.
 */
export function describeIssue(issue: ValidationIssue, t: Translation["t"]): string {
  switch (issue.kind) {
    case "spawnsNotDivisibleByTeams":
      return t("maps.generate.issue.spawnsNotDivisible", {
        spawns: issue.payload.spawnCount,
        teams: issue.payload.numTeams,
      });
    case "mapSizeNotAMultiple":
      return t("maps.generate.issue.mapSizeNotMultiple", {
        size: issue.payload.mapSize,
        step: MAP_SIZE_STEP,
      });
    case "symmetryIncompatible":
      return t("maps.generate.issue.symmetryIncompatible", {
        symmetries: issue.payload.symmetries.join(", "),
        teams: issue.payload.numTeams,
      });
    case "outOfRange":
      return t("maps.generate.issue.outOfRange", {
        field: capitalise(issue.payload.field),
        value: issue.payload.value,
        min: issue.payload.min,
        max: issue.payload.max,
      });
    case "styleOutsideItsRange":
      return t("maps.generate.issue.styleOutsideRange", {
        style: issue.payload.style,
        from: formatMapSize(issue.payload.constraints.minMapSize),
        to: formatMapSize(issue.payload.constraints.maxMapSize),
      });
    case "seedNotAnInteger":
      return t("maps.generate.issue.seedNotInteger", { seed: issue.payload.seed });
  }
}

/** A stable key for an issue, for React lists. Independent of the locale. */
export function issueKey(issue: ValidationIssue): string {
  return `${issue.kind}:${JSON.stringify(issue.payload)}`;
}

/** Whether the generator would refuse outright, as opposed to producing something odd. */
export function isFatal(issue: ValidationIssue): boolean {
  return issue.kind !== "styleOutsideItsRange";
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A decoded map name as a short list of facts, most identifying first.
 *
 * This is the payoff of decoding names locally: a lobby row can say what the
 * map is before anyone spends two minutes generating it. Neither reference
 * client shows any of this.
 */
export function summariseDecodedName(decoded: DecodedMapName): string[] {
  const parts = [
    formatMapSize(decoded.mapSize),
    `${decoded.spawnCount} spawns`,
    decoded.numTeams === 0 ? "asymmetric" : `${decoded.numTeams} teams`,
  ];
  if (decoded.symmetry) parts.push(decoded.symmetry);

  if (decoded.visibility) {
    parts.push(titleCase(decoded.visibility));
  } else if (decoded.style?.kind === "predefined" && decoded.style.style) {
    parts.push(titleCase(decoded.style.style));
  } else if (decoded.style?.kind === "custom") {
    const custom = decoded.style;
    for (const value of [custom.terrainStyle, custom.textureStyle]) {
      if (value) parts.push(titleCase(value));
    }
  }
  return parts;
}

/** `MOUNTAIN_RANGE` reads better as `Mountain range` in a dense list. */
export function titleCase(value: string): string {
  const spaced = value.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A density bin as the percentage the user is really choosing. */
export function densityPercent(bin: number): number {
  return Math.round((bin / DENSITY_BINS) * 100);
}

/**
 * Whether these options can be sent at all.
 *
 * Raw arguments are always allowed through: they are the documented escape
 * hatch, and second-guessing them would defeat the point.
 */
export function canGenerate(options: GeneratorOptions, issues: ValidationIssue[]): boolean {
  if (options.commandLineArgs.trim() !== "") return true;
  return !issues.some(isFatal);
}
