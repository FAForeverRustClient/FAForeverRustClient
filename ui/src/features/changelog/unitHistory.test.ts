import { describe, expect, it } from "vitest";
import type { UnitHistory, UnitSummary, UnitValueKey } from "../../ipc/bindings";
import { niceTicks, stepPath, valueExtent } from "./UnitHistoryChart";
import {
  alignedValues,
  comparableKey,
  defaultKey,
  filterUnits,
  formatValue,
  roundHalfEven,
  sortUnits,
  valueKeyId,
} from "./unitHistory";

function unit(id: string, overrides: Partial<UnitSummary> = {}): UnitSummary {
  return {
    id,
    path: `units/${id}/${id}_unit.bp`,
    name: null,
    description: null,
    faction: "UEF",
    tech: 1,
    ...overrides,
  };
}

const dps = (weapon: string): UnitValueKey => ({ type: "weapon", payload: { weapon, stat: "dps" } });
const health: UnitValueKey = { type: "unit", payload: { stat: "maxHealth" } };

function history(id: string, series: Array<[UnitValueKey, (number | null)[]]>, releases = ["3700", "3701", "3702"]): UnitHistory {
  return {
    unit: unit(id),
    releases: releases.map((release) => ({ release, date: "", source: { type: "repository" } })),
    weapons: [],
    series: series.map(([key, values]) => ({ key, values })),
    changes: [],
  };
}

describe("the unit list", () => {
  const units = [
    unit("XSL0101", { name: "Selen", description: "Combat Scout", faction: "Seraphim" }),
    unit("UEL0201", { name: "MA12 Striker", description: "Medium Tank" }),
    unit("UEL0001", { name: "Armored Command Unit", tech: null }),
    unit("URL0107", { name: "Mantis", description: "Assault Bot", faction: "Cybran" }),
    unit("UEL0303", { name: "Titan", tech: 3 }),
  ];

  it("searches the name, the description and the id", () => {
    expect(filterUnits(units, "striker", "", null).map((u) => u.id)).toEqual(["UEL0201"]);
    expect(filterUnits(units, "assault bot", "", null).map((u) => u.id)).toEqual(["URL0107"]);
    expect(filterUnits(units, "xsl01", "", null).map((u) => u.id)).toEqual(["XSL0101"]);
  });

  it("filters by faction and tech level", () => {
    expect(filterUnits(units, "", "UEF", null).map((u) => u.id)).toEqual(["UEL0001", "UEL0201", "UEL0303"]);
    expect(filterUnits(units, "", "", 3).map((u) => u.id)).toEqual(["UEL0303"]);
  });

  it("orders by faction, then commanders before tech 1, then name", () => {
    expect(sortUnits(units).map((u) => u.id)).toEqual(["UEL0001", "UEL0201", "UEL0303", "URL0107", "XSL0101"]);
  });
});

describe("values", () => {
  it("rounds DPS the way the game's unit view does, ties to even", () => {
    expect(roundHalfEven(26.6667)).toBe(27);
    expect(roundHalfEven(12.5)).toBe(12);
    expect(roundHalfEven(13.5)).toBe(14);
    expect(formatValue(dps("MainGun"), 26.6667)).toBe("27");
    expect(formatValue(health, null)).toBe("–");
  });

  it("aligns another unit's values with the releases on screen", () => {
    const other = history("URL0107", [[health, [200, 220]]], ["3701", "3702"]);
    expect(alignedValues(other, health, ["3700", "3701", "3702"])).toEqual([null, 200, 220]);
    expect(alignedValues(other, dps("MainGun"), ["3700"])).toEqual([null]);
  });

  it("compares a weapon value with the other unit's first weapon that has it", () => {
    const other = history("URL0107", [[health, [200]], [dps("LaserArms"), [26]]]);
    expect(comparableKey(other, dps("MainGun"))).toEqual(dps("LaserArms"));
    expect(comparableKey(other, health)).toEqual(health);
    expect(comparableKey(history("UEB2101", [[health, [900]]]), dps("MainGun"))).toBeNull();
  });

  it("opens on the first weapon's DPS, or health without a weapon", () => {
    expect(defaultKey(history("UEL0201", [[health, [300]], [dps("MainGun"), [24]]]))).toEqual(dps("MainGun"));
    expect(defaultKey(history("UEB1101", [[health, [300]]]))).toEqual(health);
    expect(valueKeyId(dps("MainGun"))).toBe("weapon:MainGun:dps");
  });
});

describe("the step chart", () => {
  it("draws a flat run per release, a step at a change, and a break at a gap", () => {
    const path = stepPath([1, 1, null, 2], (index) => index * 10, (value) => value);
    expect(path).toBe("M0,1L10,1L10,1L20,1M30,2L40,2");
  });

  it("starts the value axis at zero and keeps a little headroom", () => {
    const extent = valueExtent([{ label: "a", values: [300, null, 320] }]);
    expect(extent?.min).toBe(0);
    expect(extent?.max).toBeCloseTo(339.2);
    expect(valueExtent([{ label: "a", values: [null] }])).toBeNull();
    expect(niceTicks(0, 100)).toEqual([0, 20, 40, 60, 80, 100]);
  });
});
