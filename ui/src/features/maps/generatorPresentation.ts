// Turning generator data into things a person can read.
//
// Kept out of the dialog so the arithmetic (unit conversions, which options are
// legal, what a decoded map name says) can be tested without rendering React.

import type {
  DecodedMapName,
  GeneratorOptions,
  GeneratorStatus,
  ValidationIssue,
} from "../../ipc/bindings";
import type { Translation } from "../../i18n/useTranslation";
import { kilometresLabel } from "../../shared/mapPresentation";

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

/** "10 km (512×512)", "17.5 km (896×896)". */
export function formatMapSize(units: number): string {
  return `${kilometresLabel(units)} km (${units}×${units})`;
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

/** One decoded parameter, as a labelled row. */
export interface GeneratorParameter {
  /** Stable across locales, for React keys. */
  key: string;
  label: string;
  value: string;
}

/**
 * The same decoding as [`summariseDecodedName`], as labelled rows.
 *
 * The chip list above answers "what kind of map is this" at a glance in a
 * lobby row. This answers "which settings produced it" for somebody looking at
 * one map on purpose, which needs the labels: `10 km · 8 spawns · 4 teams` is
 * readable as a strip and useless as an answer to "what was the reclaim set
 * to".
 *
 * On reclaim in particular: a name carries a reclaim *density* only when the
 * map was generated from component styles. A predefined style has no density
 * in the name because the style is the setting: `HIGH_RECLAIM` is the answer,
 * and inventing a percentage for it would be a guess. So the style row is
 * always present and the density rows appear exactly when the name has them.
 *
 * Unknown ordinals (a generator newer than this client's tables) decode to
 * `null` and drop their row rather than showing a wrong name. A name that does
 * not decode at all produces no rows, and the dialog still shows the raw name.
 */
export function generatorParameters(
  decoded: DecodedMapName,
  t: Translation["t"],
): GeneratorParameter[] {
  const rows: GeneratorParameter[] = [
    { key: "size", label: t("maps.generate.mapSize"), value: formatMapSize(decoded.mapSize) },
    { key: "spawns", label: t("maps.generate.spawns"), value: String(decoded.spawnCount) },
    {
      key: "teams",
      label: t("maps.generate.teams"),
      value: decoded.numTeams === 0 ? t("maps.generate.asymmetric") : String(decoded.numTeams),
    },
  ];
  if (decoded.symmetry) {
    rows.push({
      key: "symmetry",
      label: t("maps.generate.symmetry"),
      value: formatSymmetry(decoded.symmetry),
    });
  }

  if (decoded.visibility) {
    // A tournament/blind map carries a timestamp where the style would be:
    // withholding the style is the entire point of it, so there is nothing
    // further to show.
    rows.push({
      key: "visibility",
      label: t("lobby.browser.visibility"),
      value: titleCase(decoded.visibility),
    });
  } else if (decoded.style?.kind === "predefined") {
    if (decoded.style.style) {
      rows.push({
        key: "style",
        label: t("maps.generate.styleOfGame"),
        value: titleCase(decoded.style.style),
      });
    }
  } else if (decoded.style?.kind === "custom") {
    const custom = decoded.style;
    const components: Array<[string, string, string | null]> = [
      ["terrain", t("maps.generate.terrain"), custom.terrainStyle],
      ["texture", t("maps.generate.texture"), custom.textureStyle],
      ["resourceStyle", t("maps.generate.resources"), custom.resourceStyle],
      ["props", t("maps.generate.props"), custom.propStyle],
    ];
    for (const [key, label, value] of components) {
      if (value) rows.push({ key, label, value: titleCase(value) });
    }
    // Nullable on the wire because a float crossing the JSON boundary can be
    // NaN, not because a custom style can lack a density.
    const densities: Array<[string, string, number | null]> = [
      ["reclaimDensity", t("maps.generate.reclaimDensity"), custom.reclaimDensity],
      ["resourceDensity", t("maps.generate.resourceDensity"), custom.resourceDensity],
    ];
    for (const [key, label, bin] of densities) {
      if (bin !== null) rows.push({ key, label, value: `${densityPercent(bin)}%` });
    }
  }

  // Last, because it identifies the map rather than describing it: the seed
  // is what somebody regenerating this exact map needs, and nothing anybody
  // reads a parameter list to find out.
  rows.push({ key: "seed", label: t("maps.generate.seed"), value: decoded.seed });
  rows.push({
    key: "version",
    label: t("maps.generate.generatorVersion"),
    value: decoded.version,
  });
  return rows;
}

/** `MOUNTAIN_RANGE` reads better as `Mountain range` in a dense list. */
export function titleCase(value: string): string {
  const spaced = value.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A symmetry as the generator means it.
 *
 * Most generator enums are words and read better title-cased, which is what
 * `titleCase` is for. The axis symmetries are not words: `ZX` names the two
 * axes the map is mirrored across, and `Zx` is simply the wrong spelling of
 * it. Everything longer - `QUAD`, `DIAG`, `POINT12`, `NONE` - is a word and
 * takes the usual treatment.
 */
export function formatSymmetry(value: string): string {
  return /^[XYZ]{1,2}$/.test(value) ? value : titleCase(value);
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

/** How a run this dialog started ended, once it has. */
export type RunOutcome =
  /** Still going, or the status on screen is not ours to act on. */
  | { kind: "waiting" }
  /** Finished; these are the folders now on disk. */
  | { kind: "generated"; maps: string[] }
  /** Failed or cancelled. Nothing to show, but the wait is over. */
  | { kind: "stopped" };

/**
 * Decide whether the status on screen is the outcome of *our* run.
 *
 * The subtlety this exists for: the generator status is sticky. After a run it
 * stays `generated` with that run's maps until something else replaces it. A
 * dialog that simply reacts to "status is generated" therefore fires the
 * instant the user starts a *second* run, reports the previous run's maps as
 * if they were new, and then ignores the real result because it has already
 * stopped listening. That produced both halves of the reported bug: sometimes
 * a map too many, sometimes nothing at all.
 *
 * The fix is to compare against the status that was showing at the moment the
 * run was requested. Anything identical to it is the past, not the present.
 * Each event from the backend produces a fresh status object, so reference
 * inequality is exactly the question "has anything happened since I asked?".
 *
 * `since` being null means no run of ours is outstanding.
 */
export function outcomeOfRun(
  current: GeneratorStatus,
  since: GeneratorStatus | null,
): RunOutcome {
  if (since === null || current === since) return { kind: "waiting" };
  switch (current.type) {
    case "generated":
      return { kind: "generated", maps: current.payload.maps };
    case "failed":
    case "cancelled":
      return { kind: "stopped" };
    default:
      return { kind: "waiting" };
  }
}
