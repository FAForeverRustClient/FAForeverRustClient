import { describe, expect, it } from "vitest";
import type { UnitHistory, UnitSummary, UnitValueKey } from "../../ipc/bindings";
import { normalizedSelection } from "../../store/reducers/unitHistory";
import { niceTicks, stepPath, valueExtent } from "./UnitHistoryChart";
import {
  alignedValues,
  changedKeys,
  comparableKey,
  defaultKey,
  defaultStatKeys,
  filterUnits,
  formatPercentChange,
  formatValue,
  groupUnits,
  indexedValues,
  roundHalfEven,
  sortUnits,
  valueKeyId,
} from "./unitHistory";

function unit(id: string, overrides: Partial<UnitSummary> = {}): UnitSummary {
  return {
    id,
    path: `units/${id}/${id}_unit.bp`,
    iconUrl: `https://example.invalid/${id}_icon.png`,
    name: null,
    description: null,
    faction: "UEF",
    tech: 1,
    ...overrides,
  };
}

const dps = (weapon: string): UnitValueKey => ({ type: "weapon", payload: { weapon, stat: "dps" } });
const health: UnitValueKey = { type: "unit", payload: { stat: "maxHealth" } };
const speed: UnitValueKey = { type: "unit", payload: { stat: "speed" } };

function history(id: string, series: Array<[UnitValueKey, (number | null)[]]>, releases = ["3700", "3701", "3702"]): UnitHistory {
  return {
    unit: unit(id),
    releases: releases.map((release) => ({ release, date: "", source: { type: "repository" } })),
    weapons: [],
    series: series.map(([key, values]) => ({ key, values })),
    changes: [],
  };
}

describe("the unit grid", () => {
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

  it("groups a faction's units into rows by tech level", () => {
    const groups = groupUnits(units);
    expect(groups.map((group) => group.faction)).toEqual(["UEF", "Cybran", "Seraphim"]);
    expect(groups[0].tiers.map((tier) => [tier.tech, tier.units.map((u) => u.id)])).toEqual([
      [null, ["UEL0001"]],
      [1, ["UEL0201"]],
      [3, ["UEL0303"]],
    ]);
  });

  it("keeps a selection upper case, unique and capped, like the backend", () => {
    expect(normalizedSelection(["uel0201", "UEL0201", " url0107 ", "", "A", "B", "C", "D", "E"])).toEqual([
      "UEL0201",
      "URL0107",
      "A",
      "B",
      "C",
      "D",
    ]);
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
    const other = history("URL0107", [[health, [200, 200, 200]], [dps("LaserArms"), [26, 26, 26]]]);
    expect(comparableKey(other, dps("MainGun"))).toEqual(dps("LaserArms"));
    expect(comparableKey(other, health)).toEqual(health);
    expect(comparableKey(history("UEB2101", [[health, [900, 900, 900]]]), dps("MainGun"))).toBeNull();
  });

  it("opens a comparison on the first weapon's DPS, or health without a weapon", () => {
    expect(defaultKey(history("UEL0201", [[health, [300, 300, 300]], [dps("MainGun"), [24, 24, 24]]]))).toEqual(
      dps("MainGun"),
    );
    expect(defaultKey(history("UEB1101", [[health, [300, 300, 300]]]))).toEqual(health);
    expect(valueKeyId(dps("MainGun"))).toBe("weapon:MainGun:dps");
  });

  it("charts only the values that changed, the unit's own first", () => {
    const striker = history("UEL0201", [
      [health, [300, 300, 300]],
      [speed, [3, 3.4, 3.4]],
      [dps("MainGun"), [24, 26, null]],
    ]);
    expect(changedKeys(striker)).toEqual([speed, dps("MainGun")]);
    expect(defaultStatKeys(striker, 1)).toEqual([speed]);
  });

  it("puts values of different sizes on one axis as a share of their first value", () => {
    expect(indexedValues([null, 0, 200, 300, null, 100])).toEqual([null, null, 100, 150, null, 50]);
    expect(indexedValues([null, null])).toEqual([null, null]);
    expect(formatPercentChange(150)).toBe("+50%");
    expect(formatPercentChange(95)).toBe("-5%");
    expect(formatPercentChange(100)).toBe("0%");
  });
});

describe("the step chart", () => {
  it("draws a flat run per release, a step at a change, and a break at a gap", () => {
    const path = stepPath([1, 1, null, 2], (index) => index * 10, (value) => value);
    expect(path).toBe("M0,1L10,1L10,1L20,1M30,2L40,2");
  });

  it("starts absolute values at zero and fits percentages around their baseline", () => {
    const absolute = valueExtent([{ values: [300, null, 320] }]);
    expect(absolute?.min).toBe(0);
    expect(absolute?.max).toBeCloseTo(339.2);
    const relative = valueExtent([{ values: [100, 120] }], null, 100);
    expect(relative?.min).toBeCloseTo(98.8);
    expect(relative?.max).toBeCloseTo(121.2);
    expect(valueExtent([{ values: [null] }])).toBeNull();
    expect(niceTicks(0, 100)).toEqual([0, 20, 40, 60, 80, 100]);
  });
});
