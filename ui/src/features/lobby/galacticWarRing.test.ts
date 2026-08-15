import { describe, expect, it } from "vitest";

import type { GalacticWarFaction } from "../../ipc/bindings";
import { factionNumber, ringSegments } from "./galacticWarRing";

function faction(name: string, numPlanets: number, id = 0): GalacticWarFaction {
  return {
    id,
    name,
    longName: name,
    numAvatars: 0,
    numAliveAvatars: 0,
    numOnlineAvatars: 0,
    numPlanets,
  };
}

describe("faction identity", () => {
  it("maps by name, whatever the gateway numbers them", () => {
    // The published spec numbers UEF 1; the live server numbers it 0. Neither
    // may decide which glyph is drawn.
    expect(factionNumber("UEF")).toBe(1);
    expect(factionNumber("Aeon")).toBe(2);
    expect(factionNumber("Cybran")).toBe(3);
    expect(factionNumber("Seraphim")).toBe(4);
  });

  it("tolerates casing and padding", () => {
    expect(factionNumber(" seraphim ")).toBe(4);
  });

  it("falls back for a faction this client has never heard of", () => {
    expect(factionNumber("Nomads")).toBe(5);
    expect(factionNumber("")).toBe(5);
  });
});

describe("the territory ring", () => {
  it("sizes each arc by the planets held", () => {
    const segments = ringSegments([faction("UEF", 30), faction("Aeon", 10)]);

    expect(segments.map((segment) => segment.share)).toEqual([0.75, 0.25]);
    expect(segments.map((segment) => segment.offset)).toEqual([0, 0.75]);
  });

  it("covers the whole ring exactly", () => {
    const segments = ringSegments([
      faction("UEF", 254),
      faction("Aeon", 245),
      faction("Cybran", 249),
      faction("Seraphim", 252),
    ]);

    const total = segments.reduce((sum, segment) => sum + segment.share, 0);
    expect(total).toBeCloseTo(1, 10);
    const last = segments[segments.length - 1];
    expect(last.offset + last.share).toBeCloseTo(1, 10);
  });

  it("keeps the gateway's order and colours by faction", () => {
    const segments = ringSegments([faction("Seraphim", 1), faction("UEF", 1)]);

    expect(segments.map((segment) => segment.name)).toEqual(["Seraphim", "UEF"]);
    expect(segments[0].color).toBe("var(--color-faction-seraphim)");
    expect(segments[1].color).toBe("var(--color-faction-uef)");
  });

  it("draws nothing rather than four equal quarters when no planets are held", () => {
    expect(ringSegments([faction("UEF", 0), faction("Aeon", 0)])).toEqual([]);
    expect(ringSegments([])).toEqual([]);
  });

  it("ignores a negative count instead of inverting an arc", () => {
    const segments = ringSegments([faction("UEF", -5), faction("Aeon", 10)]);

    expect(segments[0].share).toBe(0);
    expect(segments[1].share).toBe(1);
  });
});
