// How big a tournament map is.
//
// The tournament service stores a size only where the organiser picked one in
// its map editor, an optional field most leave unset. So the stored value wins
// and the client fills the gaps: the base game's own list for its maps (the
// vault's record for those is not to be trusted, see `OFFICIAL_BASE_MAPS`),
// then the vault record the map's name resolves to. A secret map stays
// without one: its size would narrow down which map it is.

import type { MapSpec, TourneyMap, VaultMap } from "../../ipc/bindings";
import { isGeneratedMap, kilometresLabel, officialMapFor } from "../../shared/mapPresentation";
import { matchVaultMap } from "../../shared/rules/tourneyRules";

/** The website's size choices, keyed by the side of a square map in generator units. */
const SPEC_SIZES = new Map<number, string>([
  [256, "5x5"],
  [512, "10x10"],
  [1024, "20x20"],
  [2048, "40x40"],
  // 80 km by the arithmetic; the website's list says 81, and so does the map
  // editor's select, so this has to as well.
  [4096, "81x81"],
]);

export const EMPTY_MAP_SPEC: MapSpec = {
  team1Spawns: [],
  team2Spawns: [],
  closedSpawns: [],
  closedMexSpawns: [],
  size: "",
};

/** A size as the website's map editor offers it, or "" where its list has none. */
export function specSizeOf(width: number, height: number): string {
  return width === height ? (SPEC_SIZES.get(width) ?? "") : "";
}

/** Width and height in generator units of the map a name refers to, where known. */
export function mapDimensionsByName(name: string, vault: VaultMap[]): { width: number; height: number } | null {
  const official = officialMapFor(name);
  if (official !== undefined) return official;
  const record = matchVaultMap({ name }, vault);
  return record !== null && record.width > 0 && record.height > 0 ? record : null;
}

/**
 * The size a tournament map is shown with, in the stored value's own form
 * (`10x10`, read as kilometres): the organiser's if they gave one, else the
 * one the client knows. A size off the website's list (`15x15`, `10x20`) is
 * still a size worth showing. "" where nobody knows, or it is secret.
 */
export function tourneyMapSize(map: TourneyMap, vault: VaultMap[], generatedSize?: number): string {
  const stored = map.spec?.size.trim() ?? "";
  if (stored !== "") return stored;
  if (map.masked) return "";
  // A generated map is in no vault, but its name encodes its size: the map
  // generator slice decodes it (`decodeNames`), as for a lobby tile.
  if (generatedSize !== undefined && generatedSize > 0) {
    const listed = specSizeOf(generatedSize, generatedSize);
    return listed !== "" ? listed : `${kilometresLabel(generatedSize)}x${kilometresLabel(generatedSize)}`;
  }
  const dimensions = mapDimensionsByName(map.name, vault);
  if (dimensions === null) return "";
  const listed = specSizeOf(dimensions.width, dimensions.height);
  return listed !== "" ? listed : `${kilometresLabel(dimensions.width)}x${kilometresLabel(dimensions.height)}`;
}

/**
 * Whether the client would have to ask the vault before it can size this map.
 * Never for a generated map: the vault holds none, and asking for one by name
 * was a request per map that could only come back empty.
 */
export function needsSizeLookup(map: TourneyMap, vault: VaultMap[]): boolean {
  return (
    !map.masked &&
    !isGeneratedMap(map.name) &&
    (map.spec?.size.trim() ?? "") === "" &&
    mapDimensionsByName(map.name, vault) === null
  );
}

/**
 * A spec with the size filled in where it was left empty and the map's size
 * is one the editor offers. For a map being added from the vault or opened in
 * the editor, so the organiser sees it chosen and saves it with the rest.
 */
export function withKnownSize(spec: MapSpec | null, name: string, vault: VaultMap[]): MapSpec | null {
  if (spec !== null && spec.size.trim() !== "") return spec;
  const dimensions = mapDimensionsByName(name, vault);
  const size = dimensions === null ? "" : specSizeOf(dimensions.width, dimensions.height);
  if (size === "") return spec;
  return { ...(spec ?? EMPTY_MAP_SPEC), size };
}
