// The territory ring around the launch button: one arc per faction, sized by
// the planets it holds.
//
// Pure, so the arc arithmetic is testable without a DOM. The rendering is in
// `GalacticWarPanel`.

import type { GalacticWarFaction } from "../../ipc/bindings";
import { FACTION_COLORS } from "../../shared/factions";

/**
 * The client's own faction numbering, keyed by the gateway's faction *name*.
 *
 * Deliberately not by `faction.id`: the published spec numbers UEF as 1 and
 * the running server numbers it 0, so the id says nothing reliable. The same
 * approach as `CoopPanel`'s mapping, for the same reason.
 */
const FACTION_NUMBER_BY_NAME: Readonly<Record<string, number>> = {
  uef: 1,
  aeon: 2,
  cybran: 3,
  seraphim: 4,
};

/** Whatever the gateway sends that this client has no glyph or colour for. */
const UNKNOWN_FACTION = 5;

export interface RingSegment {
  name: string;
  /** The client's faction number, for the glyph and colour. */
  faction: number;
  color: string;
  planets: number;
  /** Fraction of the whole ring, `0`..`1`. */
  share: number;
  /** Where this arc starts, as a fraction of the ring. */
  offset: number;
}

export function factionNumber(name: string): number {
  return FACTION_NUMBER_BY_NAME[name.trim().toLowerCase()] ?? UNKNOWN_FACTION;
}

/**
 * Arcs for the ring, in the order the gateway sent them.
 *
 * Returns nothing when no planets are held at all, rather than dividing by
 * zero or drawing four equal quarters: an empty ring is honest about a season
 * that has not started, four quarters would be a claim.
 */
export function ringSegments(factions: readonly GalacticWarFaction[]): RingSegment[] {
  const planets = factions.map((faction) => Math.max(0, faction.numPlanets ?? 0));
  const total = planets.reduce((sum, count) => sum + count, 0);
  if (total === 0) return [];

  let offset = 0;
  return factions.map((faction, index) => {
    const share = planets[index] / total;
    const segment: RingSegment = {
      name: faction.name ?? "",
      faction: factionNumber(faction.name ?? ""),
      color: FACTION_COLORS[factionNumber(faction.name ?? "")] ?? FACTION_COLORS[UNKNOWN_FACTION],
      planets: planets[index],
      share,
      offset,
    };
    offset += share;
    return segment;
  });
}
