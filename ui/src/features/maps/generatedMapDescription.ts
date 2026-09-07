// The generator's own account of a map, as rows a person can read.
//
// A generated map carries its whole recipe twice: encoded in the folder name,
// and spelled out in the `description` field of its `_scenario.lua`. The name
// is all a lobby row has, and `generatorPresentation.ts` decodes it. This file
// is about the other copy, which only an *installed* map has and which says
// strictly more: the name encodes a style, while the description also records
// what that style resolved to: biome, terrain, resources, props, and the
// three symmetries that were actually used.
//
// Until now the client rendered that field verbatim, so the host dialog showed
// this under the preview:
//
//     Seed: -2207507018540207222\r\nSeed: -2207507018540207222\r\nSpawns: 12\r\n…
//
// One unbroken line, with the escapes visible, two of everything, and `null`
// where the generator had nothing to say. Every complaint about it is a
// property of the text rather than of the data, so the fix is to parse it.

import {
  formatMapSize,
  formatSymmetry,
  titleCase,
  type GeneratorParameter,
} from "./generatorPresentation";
import type { MessageKey } from "../../i18n/catalog/en";
import type { Translation } from "../../i18n/useTranslation";

/**
 * Line breaks as they actually arrive.
 *
 * The description is read out of a single-quoted Lua string and never
 * unescaped, so its breaks are the two characters `\` and `n` rather than a
 * newline. Real newlines are accepted too: a future reader that does unescape
 * should not silently produce one giant row.
 */
const LINE_BREAK = /(?:\\r\\n|\\n|\\r|\r\n|\n|\r)+/;

/** The generator writes `null` for a setting it never had. */
const NOTHING = /^(?:null|none|n\/a|)$/i;

/** `SymmetrySettings[terrainSymmetry=ZX, teamSymmetry=ZX, spawnSymmetry=ZX]`. */
const RECORD = /^([A-Za-z][\w.]*)\[(.+)]$/;

/**
 * How a recognised key is labelled and rendered, in the order the rows appear.
 *
 * Order is fixed rather than taken from the file because the generator writes
 * its two blocks in an order that suits the generator: the seed twice at the
 * top, the resolved styles at the bottom. What a reader wants first is what
 * kind of map this is; the seed is a reproduction detail and goes last.
 */
const KNOWN: Array<{
  /** The canonical key, as [`canonicalise`] produces it. */
  key: string;
  label: MessageKey;
  /** Absent means the value is an enum name, which title-cases. */
  render?: (value: string, t: Translation["t"]) => string;
}> = [
  { key: "mapsize", label: "maps.generate.mapSize", render: renderMapSize },
  { key: "spawns", label: "maps.generate.spawns", render: verbatim },
  { key: "numteams", label: "maps.generate.teams", render: renderTeams },
  { key: "style", label: "maps.generate.styleOfGame" },
  { key: "terrainstyle", label: "maps.generate.terrain" },
  { key: "biome", label: "maps.generate.biome" },
  { key: "texturestyle", label: "maps.generate.texture" },
  { key: "resourcestyle", label: "maps.generate.resources" },
  { key: "propstyle", label: "maps.generate.props" },
  { key: "symmetry", label: "maps.generate.symmetry", render: renderSymmetry },
  { key: "terrainsymmetry", label: "maps.generate.terrainSymmetry", render: renderSymmetry },
  { key: "teamsymmetry", label: "maps.generate.teamSymmetry", render: renderSymmetry },
  { key: "spawnsymmetry", label: "maps.generate.spawnSymmetry", render: renderSymmetry },
  { key: "seed", label: "maps.generate.seed", render: verbatim },
];

const KNOWN_KEYS = new Set(KNOWN.map((entry) => entry.key));

/**
 * How many recognised settings a description needs before we treat it as the
 * generator's.
 *
 * An ordinary map's description is prose ("A balanced battleground for 4
 * players."), and prose has no `key: value` lines at all, so one would do. Two
 * costs nothing and rules out a hand-written description that happens to open
 * with something like `Style: aggressive`.
 */
const ENOUGH = 2;

/**
 * The description as labelled rows, or `[]` when it is not a generator's.
 *
 * Tolerant in the same way the name decoder is, and for the same reason: a
 * generator newer than this client writes keys this client has never heard of,
 * and the useful behaviour is to show them under a humanised label rather than
 * to drop them or to give up on the whole description.
 */
export function generatedMapDescriptionRows(
  description: string | null | undefined,
  t: Translation["t"],
): GeneratorParameter[] {
  const values = parseSettings(description);
  if (values === null) return [];

  const rows: GeneratorParameter[] = [];
  for (const entry of KNOWN) {
    const value = values.get(entry.key);
    if (value === undefined) continue;
    rows.push({
      key: entry.key,
      label: t(entry.label),
      value: (entry.render ?? titleCased)(value.text, t),
    });
  }

  // Anything this client has no table for, in the order the generator wrote
  // it. Rendered verbatim: an unknown key's value is not known to be an enum,
  // and title-casing a version or a path would be damage rather than polish.
  const unknown = [...values.entries()]
    .filter(([key]) => !KNOWN_KEYS.has(key))
    .sort((left, right) => left[1].position - right[1].position);
  for (const [key, value] of unknown) {
    rows.push({ key, label: humanise(value.rawKey), value: value.text });
  }
  return rows;
}

/** Whether this description is the generator's, and worth showing as rows. */
export function isGeneratedMapDescription(description: string | null | undefined): boolean {
  return parseSettings(description) !== null;
}

interface Setting {
  /** The key as the generator spelled it, for labelling an unknown one. */
  rawKey: string;
  text: string;
  /** Where it first appeared, so unknown keys keep the generator's order. */
  position: number;
}

/**
 * `key: value` lines, deduplicated, or `null` when this is not a generator
 * description.
 *
 * Two shapes of duplicate exist and both resolve the same way, by letting a
 * later line win over an earlier one. The generator prints the seed twice
 * identically, which is harmless. It also prints `Style: null` in its
 * parameter block and `Style: FRACTAL_LAND` in its generator block, because
 * the first is the style that was *asked for* and the second is the one that
 * was *used*. Blank values never enter the map at all, so the surviving line
 * is the last one that said anything.
 */
function parseSettings(description: string | null | undefined): Map<string, Setting> | null {
  if (!description) return null;

  const values = new Map<string, Setting>();
  let recognised = 0;
  let position = 0;

  for (const line of description.split(LINE_BREAK)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const rawKey = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!rawKey || NOTHING.test(rawValue)) continue;

    for (const [key, value] of expand(rawKey, rawValue)) {
      const canonical = canonicalise(key);
      if (!canonical || NOTHING.test(value)) continue;
      const existing = values.get(canonical);
      if (existing === undefined && KNOWN_KEYS.has(canonical)) recognised += 1;
      values.set(canonical, {
        rawKey: key,
        text: value,
        position: existing?.position ?? position++,
      });
    }
  }

  return recognised >= ENOUGH ? values : null;
}

/**
 * One line as the settings it carries.
 *
 * Usually one. A record value, `SymmetrySettings[terrainSymmetry=ZX, ...]`, is
 * the generator printing a Java object, and the three symmetries inside it are
 * three settings a reader wants, not one string containing a class name. A
 * record whose insides do not parse falls back to the whole line, because a
 * value we cannot take apart is still a value.
 */
function expand(rawKey: string, rawValue: string): Array<[string, string]> {
  const record = RECORD.exec(rawValue);
  if (!record) return [[rawKey, rawValue]];

  const fields: Array<[string, string]> = [];
  for (const field of record[2].split(",")) {
    const equals = field.indexOf("=");
    if (equals <= 0) continue;
    const key = field.slice(0, equals).trim();
    const value = field.slice(equals + 1).trim();
    if (key && value) fields.push([key, value]);
  }
  return fields.length > 0 ? fields : [[rawKey, rawValue]];
}

/**
 * The key as one comparable token.
 *
 * The generator spells the same setting both ways: `Terrain Symmetry` in its
 * parameter block and `terrainSymmetry` inside `SymmetrySettings`. Stripping
 * everything but letters and digits makes those the one key they are, which is
 * also what lets the second, populated one supersede the first, `null` one.
 */
function canonicalise(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function verbatim(value: string): string {
  return value;
}

function titleCased(value: string): string {
  return titleCase(value);
}

/** `ZX` names two axes and stays spelled that way; `QUAD` is a word. */
function renderSymmetry(value: string): string {
  return formatSymmetry(value);
}

/** Generator units, the same as everywhere else: `1024` is `20 km (1024×1024)`. */
function renderMapSize(value: string): string {
  const units = Number(value);
  return Number.isFinite(units) && units > 0 ? formatMapSize(units) : value;
}

/** `0` teams is the generator's way of saying the map is not team-symmetric. */
function renderTeams(value: string, t: Translation["t"]): string {
  return value === "0" ? t("maps.generate.asymmetric") : value;
}

/** `terrainSymmetry` and `Terrain Symmetry` both read as `Terrain symmetry`. */
function humanise(rawKey: string): string {
  const spaced = rawKey.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  const collapsed = spaced.replace(/\s+/g, " ").trim().toLowerCase();
  return collapsed.charAt(0).toUpperCase() + collapsed.slice(1);
}

/**
 * Two lists of parameters as one, without saying anything twice.
 *
 * The two sources overlap and disagree about naming: the folder name and the
 * description both carry the size and the style, under different keys. They do
 * not disagree about the *labels*, which are the only thing a reader sees, so
 * the label is what decides whether a row is already present.
 *
 * `primary` wins, and should be the description when there is one: it records
 * what the generator actually did, where the name records what it was asked
 * for. What the name still adds is real - the generator version, and the two
 * densities a description never mentions - so it is appended rather than
 * dropped.
 */
export function mergeGeneratorRows(
  primary: GeneratorParameter[],
  secondary: GeneratorParameter[],
): GeneratorParameter[] {
  const seen = new Set(primary.map((row) => row.label));
  const merged = [...primary];
  for (const row of secondary) {
    if (seen.has(row.label)) continue;
    seen.add(row.label);
    merged.push(row);
  }
  // The seed identifies the map rather than describing it, and both sources
  // put it last for that reason. Merging must not promote it into the middle.
  const seeds = merged.filter((row) => row.key === "seed");
  return [...merged.filter((row) => row.key !== "seed"), ...seeds];
}
